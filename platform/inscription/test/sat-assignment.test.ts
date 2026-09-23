import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertNoInscriptionBurn,
  assignSats,
  checkInscriptionCoverage,
  InscriptionBurnError,
  inscriptionDestination,
  type SatInput,
  type SatOutput,
} from '../src/index.js';

const insc = (value: bigint | number, id: string, offset: bigint | number = 0): SatInput => ({ value, inscriptions: [{ id, offset }] });
const fund = (value: bigint | number): SatInput => ({ value });
const outs = (...values: Array<bigint | number>): SatOutput[] => values.map((value) => ({ value }));

const where = (r: ReturnType<typeof assignSats>, id: string) => r.placements.find((p) => p.id === id)!.destination;

describe('assignSats: ord FIFO rule', () => {
  it('inscription at offset 0 of input 0 lands at output 0 offset 0', () => {
    const r = assignSats([insc(546, 'a'), fund(10_000)], outs(546, 9_000));
    expect(where(r, 'a')).toEqual({ vout: 0, offset: 0n });
    expect(r.outputs[0]!.inscriptions).toEqual([{ id: 'a', offset: 0n, sat: null, input: 0, inputOffset: 0n }]);
    expect(r.fee).toEqual({ value: 1_000n, ranges: [{ unknown: 1_000n }], inscriptions: [] });
  });

  it('marketplace layout bug: inscription input 0 + price output 0 sends the inscription to the seller', () => {
    // seller's PSBT: input 0 = the inscription UTXO, output 0 = the price paid to the seller
    const r = assignSats([insc(546, 'nft'), fund(100_000)], outs(50_000, 546, 49_000));
    expect(where(r, 'nft')).toEqual({ vout: 0, offset: 0n }); // seller keeps the inscription AND gets paid
  });

  it('marketplace fixed layout: two dummy inputs ahead land the inscription in output 1', () => {
    const r = assignSats([fund(600), fund(600), insc(546, 'nft'), fund(100_000)], outs(1_200, 546, 50_000, 49_000));
    expect(where(r, 'nft')).toEqual({ vout: 1, offset: 0n });
    expect(r.outputs[0]!.inscriptions).toEqual([]);
  });

  it('shave: [insc 777] + funding -> [1][776][change] isolates the inscription in a 1-sat output', () => {
    const r = assignSats([insc(777, 'i'), fund(30_000)], outs(1, 776, 29_000));
    expect(where(r, 'i')).toEqual({ vout: 0, offset: 0n });
    expect(r.outputs[0]!.value).toBe(1n);
    expect(r.outputs.map((o) => o.inscriptions.length)).toEqual([1, 0, 0]);
    expect(r.fee.value).toBe(1_000n);
  });

  it('pack: N one-sat inputs -> one N-sat output holding N inscriptions at offsets 0..N-1', () => {
    for (const n of [1, 2, 5, 64, 1_000]) {
      const inputs = Array.from({ length: n }, (_, k) => insc(1, `i${k}`));
      const r = assignSats([...inputs, fund(50_000)], outs(n, 40_000));
      expect(r.outputs[0]!.value).toBe(BigInt(n));
      expect(r.outputs[0]!.inscriptions.map((p) => [p.id, p.offset])).toEqual(inputs.map((_, k) => [`i${k}`, BigInt(k)]));
      expect(r.outputs[1]!.inscriptions).toEqual([]);
      expect(r.fee.inscriptions).toEqual([]);
    }
  });

  it('funding input first burns the last inscription into the fee', () => {
    // [funding 30000][1][1][1] -> [3][29999], fee 1: the stream head (funding) fills output 0 and the
    // start of the change; the inscriptions slide to the tail, and the last one drops into the fee.
    const r = assignSats([fund(30_000), insc(1, 'i0'), insc(1, 'i1'), insc(1, 'i2')], outs(3, 29_999));
    expect(where(r, 'i0')).toEqual({ vout: 1, offset: 29_997n });
    expect(where(r, 'i1')).toEqual({ vout: 1, offset: 29_998n });
    expect(where(r, 'i2')).toBe('fee');
    expect(r.outputs[0]!.inscriptions).toEqual([]);
    expect(r.fee.inscriptions).toEqual([{ id: 'i2', offset: 0n, sat: null, input: 3, inputOffset: 0n }]);
    expect(() => assertNoInscriptionBurn([fund(30_000), insc(1, 'i0'), insc(1, 'i1'), insc(1, 'i2')], outs(3, 29_999))).toThrow(InscriptionBurnError);
    // a larger fee burns every inscription, not just the last
    expect(assignSats([fund(30_000), insc(1, 'i0'), insc(1, 'i1'), insc(1, 'i2')], outs(3, 29_000)).fee.inscriptions.map((p) => p.id)).toEqual(['i0', 'i1', 'i2']);
    expect(checkInscriptionCoverage([fund(30_000), insc(1, 'i0')], outs(1, 29_000))).toEqual({
      ok: false,
      reason: 'inscription input 1 sits behind a funding input',
    });
  });

  it('safety invariant: sum(outputs) >= inscription-input value with inscription inputs ahead of funding => no burn', () => {
    // NOTES.md: sending the entire funding to fee with no change output burns nothing ...
    expect(checkInscriptionCoverage([insc(1, 'a'), insc(1, 'b'), fund(5_000)], outs(2))).toEqual({ ok: true });
    expect(assertNoInscriptionBurn([insc(1, 'a'), insc(1, 'b'), fund(5_000)], outs(2)).fee.value).toBe(5_000n);
    // ... and one sat short of covering the inscription inputs does burn.
    expect(checkInscriptionCoverage([insc(1, 'a'), insc(1, 'b'), fund(5_000)], outs(1))).toEqual({
      ok: false,
      reason: 'outputs (1) do not cover the inscription inputs (2)',
    });
    expect(assignSats([insc(1, 'a'), insc(1, 'b'), fund(5_000)], outs(1)).fee.inscriptions.map((p) => p.id)).toEqual(['b']);

    // Property: whenever the invariant holds, assignSats never burns, for pseudo-random layouts.
    let seed = 0x2545f491;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % n;
    };
    let checked = 0;
    for (let trial = 0; trial < 500; trial++) {
      const nIns = 1 + rnd(6);
      const inputs: SatInput[] = Array.from({ length: nIns }, (_, k) => {
        const value = 1 + rnd(2_000);
        return { value, inscriptions: Array.from({ length: 1 + rnd(3) }, (_, m) => ({ id: `${k}.${m}`, offset: rnd(value) })) };
      });
      const funding = Array.from({ length: rnd(3) }, () => fund(1 + rnd(50_000)));
      const totalInsc = inputs.reduce((s, i) => s + Number(i.value), 0);
      const totalIn = totalInsc + funding.reduce((s, i) => s + Number(i.value), 0);
      // outputs: random split of a total in [totalInsc, totalIn]
      let budget = totalInsc + rnd(totalIn - totalInsc + 1);
      const outputs: SatOutput[] = [];
      while (budget > 0) {
        const v = 1 + rnd(budget);
        outputs.push({ value: v });
        budget -= v;
      }
      if (rnd(2)) outputs.push({ value: 0 }); // an OP_RETURN somewhere at the end
      const all = [...inputs, ...funding];
      expect(checkInscriptionCoverage(all, outputs)).toEqual({ ok: true });
      const r = assignSats(all, outputs);
      expect(r.fee.inscriptions).toEqual([]);
      expect(r.placements.every((p) => p.destination !== 'fee')).toBe(true);
      checked++;
    }
    expect(checked).toBe(500);
  });

  it('reveal layout from ADR-0002: [parent][commit] -> [parent return][child postage]', () => {
    const parentValue = 10_000n;
    const commitValue = 2_546n; // fee 2000 + postage 546
    const postage = 546n;
    const r = assignSats([insc(parentValue, 'parent'), insc(commitValue, 'child')], outs(parentValue, postage));
    expect(where(r, 'parent')).toEqual({ vout: 0, offset: 0n });
    expect(where(r, 'child')).toEqual({ vout: 1, offset: 0n });
    expect(r.fee.value).toBe(2_000n);
    expect(inscriptionDestination({ inputs: [{ value: parentValue }, { value: commitValue }], outputs: outs(parentValue, postage) }, 1, 0)).toEqual({ vout: 1, offset: 0n });
    // The README's "parent return value is exact" rule: one sat more moves the child into output 0.
    expect(inscriptionDestination({ inputs: [{ value: parentValue }, { value: commitValue }], outputs: outs(parentValue + 1n, postage - 1n) }, 1)).toEqual({ vout: 0, offset: parentValue });
    // The rescue layout: [commit] -> [child].
    expect(inscriptionDestination({ inputs: [{ value: commitValue }], outputs: outs(postage) }, 0)).toEqual({ vout: 0, offset: 0n });
  });

  it('inscriptionDestination reports fee for a burned sat and validates the index', () => {
    expect(inscriptionDestination({ inputs: [{ value: 1_000 }, { value: 1 }], outputs: outs(1_000) }, 1)).toBe('fee');
    expect(inscriptionDestination({ inputs: [{ value: 1_000 }], outputs: outs(400, 500) }, 0, 950)).toBe('fee');
    expect(inscriptionDestination({ inputs: [{ value: 1_000 }], outputs: outs(400, 500) }, 0, 450)).toEqual({ vout: 1, offset: 50n });
    expect(() => inscriptionDestination({ inputs: [{ value: 1 }], outputs: [] }, 1)).toThrow(/out of range/);
  });

  it('carries known sat ranges through to outputs and fee (pilot shave, NOTES.md)', () => {
    const sat0 = 1_605_504_478_332_462n;
    const inputs: SatInput[] = [
      { value: 546, sats: [{ start: sat0, end: sat0 + 546n }], inscriptions: [{ id: 'i0', offset: 0 }] },
      { value: 546, sats: [{ start: sat0 + 546n, end: sat0 + 1_092n }], inscriptions: [{ id: 'i1', offset: 0 }] },
      { value: 30_000 }, // funding, numbering unknown
    ];
    const r = assignSats(inputs, outs(1, 545, 1, 545, 28_000));
    expect(r.outputs.map((o) => o.ranges)).toEqual([
      [{ start: sat0, end: sat0 + 1n }],
      [{ start: sat0 + 1n, end: sat0 + 546n }],
      [{ start: sat0 + 546n, end: sat0 + 547n }],
      [{ start: sat0 + 547n, end: sat0 + 1_092n }],
      [{ unknown: 28_000n }],
    ]);
    expect(r.outputs[0]!.inscriptions[0]!.sat).toBe(sat0);
    expect(r.outputs[2]!.inscriptions[0]!.sat).toBe(sat0 + 546n);
    expect(r.fee).toEqual({ value: 2_000n, ranges: [{ unknown: 2_000n }], inscriptions: [] });

    // an output straddling inputs lists one range per input chunk (ranges are not merged across inputs)
    const s = assignSats(inputs, outs(1_100, 29_000));
    expect(s.outputs[0]!.ranges).toEqual([{ start: sat0, end: sat0 + 546n }, { start: sat0 + 546n, end: sat0 + 1_092n }, { unknown: 8n }]);
    expect(s.outputs[1]!.ranges).toEqual([{ unknown: 29_000n }]);
  });

  it('is bigint-safe beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 2n ** 62n;
    const r = assignSats([{ value: big, inscriptions: [{ id: 'x', offset: big - 1n }] }, { value: 10n }], [{ value: big - 5n }, { value: 10n }]);
    expect(where(r, 'x')).toEqual({ vout: 1, offset: 4n });
    expect(r.fee.value).toBe(5n);
    expect(r.outputs[0]!.ranges).toEqual([{ unknown: big - 5n }]);
  });

  it('rejects malformed plans', () => {
    expect(() => assignSats([fund(10)], outs(11))).toThrow(/exceed inputs/);
    expect(() => assignSats([insc(10, 'a', 10)], outs(10))).toThrow(/offset 10 >= value 10/);
    expect(() => assignSats([{ value: 10, sats: [{ unknown: 9n }] }], outs(10))).toThrow(/sum to 9/);
    expect(() => assignSats([{ value: 10, sats: [{ start: 5n, end: 4n }] }], outs(10))).toThrow(/precedes/);
    expect(() => assignSats([fund(-1)], [])).toThrow(RangeError);
    expect(() => assignSats([fund(1.5)], [])).toThrow(RangeError);
    expect(() => assignSats([fund(1)], outs(-1))).toThrow(RangeError);
    expect(() => assignSats([{ value: 1, inscriptions: [{ id: '', offset: 0 }] }], outs(1))).toThrow(/id required/);
  });
});

// ---------------------------------------------------------------- shared vectors (test/vectors/fifo.json)

interface Vector {
  name: string;
  inputs: Array<{ value: number; inscriptions?: Array<{ id: string; offset: number }> }>;
  outputs: Array<{ value: number }>;
  expect: Record<string, { vout: number | 'fee'; offset: number }>;
}

const vectorsPath = fileURLToPath(new URL('./vectors/fifo.json', import.meta.url));
const vectors: Vector[] = existsSync(vectorsPath) ? (JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vector[]) : [];

describe.skipIf(vectors.length === 0)('shared FIFO vectors', () => {
  it('file is present and well-formed', () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      expect(typeof v.name).toBe('string');
      expect(Object.keys(v.expect).length).toBeGreaterThan(0);
    }
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const r = assignSats(v.inputs, v.outputs);
    const ids = v.inputs.flatMap((i) => (i.inscriptions ?? []).map((x) => x.id));
    expect(Object.keys(v.expect).sort()).toEqual([...ids].sort());
    for (const [id, want] of Object.entries(v.expect)) {
      const got = r.placements.find((p) => p.id === id)!;
      if (want.vout === 'fee') {
        expect(got.destination, id).toBe('fee');
        expect(got.offset, id).toBe(BigInt(want.offset));
      } else {
        expect(got.destination, id).toEqual({ vout: want.vout, offset: BigInt(want.offset) });
      }
    }
    // inscriptionDestination agrees with assignSats for every inscription
    for (const [i, input] of v.inputs.entries())
      for (const x of input.inscriptions ?? [])
        expect(inscriptionDestination({ inputs: v.inputs, outputs: v.outputs }, i, x.offset)).toEqual(r.placements.find((p) => p.id === x.id)!.destination);
  });
});
