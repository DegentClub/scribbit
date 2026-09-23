/**
 * Cross-implementation vectors: DegentClub/blockspace-holdings `tests/vectors/fifo.json` (hand-computed
 * for the Python `ord_sim.py`) run through the TypeScript `assignSats`. Both implementations must
 * agree on every placement, on burned inscriptions, on the sat number when ranges are known, and on
 * the fee. Copied verbatim as `test/vectors/fifo-holdings.json`; refresh it when the holdings repo
 * changes its vectors (its `docs/FIFO-SIMULATOR.md` is the spec both follow).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assignSats, type SatInput } from '../src/index.js';

interface HoldingsVector {
  name: string;
  description?: string;
  inputs: Array<{
    outpoint?: string;
    value: number;
    sat_ranges?: Array<[number, number] | { unknown: number }> | null;
    inscriptions?: Array<{ id: string; offset: number }>;
  }>;
  outputs: number[];
  expect: {
    error?: string;
    fee?: number;
    placements?: Array<{ id: string; output: number | 'FEE'; offset: number; sat: number | null; burned: boolean }>;
    out_ranges?: Array<Array<[number, number] | { unknown: number }>>;
  };
}

const file = JSON.parse(readFileSync(fileURLToPath(new URL('./vectors/fifo-holdings.json', import.meta.url)), 'utf8')) as {
  version: number;
  vectors: HoldingsVector[];
};

function toInputs(v: HoldingsVector): SatInput[] {
  return v.inputs.map((i) => ({
    value: i.value,
    sats: i.sat_ranges?.map((r) => (Array.isArray(r) ? { start: BigInt(r[0]), end: BigInt(r[1]) } : { unknown: BigInt(r.unknown) })) ?? undefined,
    inscriptions: i.inscriptions,
  }));
}

describe('blockspace-holdings FIFO vectors', () => {
  it('file is present and well-formed', () => {
    expect(file.vectors.length).toBeGreaterThan(0);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const run = () => assignSats(toInputs(v), v.outputs.map((value) => ({ value })));
    if (v.expect.error !== undefined) {
      expect(run, v.expect.error).toThrow();
      return;
    }
    const r = run();
    expect(r.fee.value, 'fee').toBe(BigInt(v.expect.fee!));
    expect(r.placements.length, 'placement count').toBe(v.expect.placements!.length);
    for (const want of v.expect.placements!) {
      const got = r.placements.find((p) => p.id === want.id);
      expect(got, want.id).toBeDefined();
      if (want.burned) {
        expect(got!.destination, want.id).toBe('fee');
      } else {
        expect(got!.destination, want.id).toEqual({ vout: want.output, offset: BigInt(want.offset) });
      }
      if (want.sat !== null) expect(got!.sat, `${want.id} sat`).toBe(BigInt(want.sat));
    }
    if (v.expect.out_ranges) {
      for (const [vout, ranges] of v.expect.out_ranges.entries()) {
        const got = r.outputs[vout]!.ranges.map((x) => ('start' in x ? [Number(x.start), Number(x.end)] : { unknown: Number(x.unknown) }));
        expect(got, `output ${vout} ranges`).toEqual(ranges);
      }
    }
  });
});
