import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { Transaction } from '@scure/btc-signer';
import { buildInscriptionScript, decodeInscriptionId, encodeParentId, parseEnvelope, parseEnvelopes } from '../src/index.js';
import { bytes, REVEAL_PUB } from './helpers.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => hex.encode(sha256(b));

/** Minimal hand-rolled script writer, independent of the builder, for malformed / exotic envelopes. */
function script(parts: (number | Uint8Array)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') out.push(p);
    else if (p.length === 0) out.push(0);
    else if (p.length <= 75) out.push(p.length, ...p);
    else if (p.length <= 255) out.push(0x4c, p.length, ...p);
    else out.push(0x4d, p.length & 0xff, p.length >> 8, ...p);
  }
  return Uint8Array.from(out);
}
const head = [REVEAL_PUB, 0xac, 0x00, 0x63, utf8('ord')]; // <key> OP_CHECKSIG OP_FALSE OP_IF "ord"

const json = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

describe('parseEnvelope: inverse of the builder', () => {
  it('round-trips buildInscriptionScript for every body / metadata size', () => {
    const parentId = `${'ab'.repeat(32)}i3`;
    for (const n of [0, 1, 75, 76, 255, 256, 519, 520, 521, 1040, 1041, 5000]) {
      const body = bytes(n, n + 1);
      const metadata = n === 0 ? undefined : body.subarray(0, Math.min(n, 1100));
      const content = { contentType: 'image/webp', body, parentId, metadata };
      const e = parseEnvelope(buildInscriptionScript(REVEAL_PUB, content))!;
      expect(e.contentType).toBe('image/webp');
      expect(e.body).toEqual(body);
      expect(e.hasBody).toBe(true);
      expect(e.parents).toEqual([parentId]);
      if (metadata) expect(e.metadata).toEqual(metadata);
      else expect(e.metadata).toBeUndefined();
      expect(e.flags).toEqual({ pushnum: false, duplicateField: false, incompleteField: false, unrecognizedEvenField: false });
      // The envelope sits after <push32 key> OP_CHECKSIG (34 bytes).
      expect(e.offset).toBe(34);
    }
  });

  it('recovers an empty body as an empty Uint8Array (body tag still present)', () => {
    const e = parseEnvelope(buildInscriptionScript(REVEAL_PUB, { contentType: 'text/plain', body: new Uint8Array() }))!;
    expect(e.hasBody).toBe(true);
    expect(e.body).toEqual(new Uint8Array());
    expect(e.contentType).toBe('text/plain');
  });

  it('returns undefined for a script with no envelope', () => {
    expect(parseEnvelope(script([REVEAL_PUB, 0xac]))).toBeUndefined();
  });
});

describe('parseEnvelope: BSS-0004 envelope vectors', () => {
  const v = json('bss-0004-envelope.json');
  const envs = v.vectors.filter((x: { id: string }) => x.id.startsWith('env-'));
  it('has envelope vectors', () => expect(envs.length).toBeGreaterThanOrEqual(10));
  for (const x of envs) {
    it(`${x.id}: content type, body, parent and metadata decode from the leaf script`, () => {
      const es = parseEnvelopes(hex.decode(x.expected.leafScriptHex));
      expect(es).toHaveLength(1);
      const e = es[0]!;
      expect(e.contentType).toBe(x.input.contentType);
      expect(sha(e.body)).toBe(x.expected.bodySha256);
      const bodyLen = x.input.bodyLength ?? x.input.bodyHex.length / 2;
      expect(e.body.length).toBe(bodyLen);
      expect(e.parents).toEqual(x.input.parentId ? [x.input.parentId] : []);
      if (x.input.metadataLength) {
        expect(e.metadata!.length).toBe(x.input.metadataLength);
        expect(e.fields.filter((f) => f.tag === 5)).toHaveLength(Math.ceil(x.input.metadataLength / 520));
      }
      expect(e.length).toBe(x.expected.leafScriptLength - 34); // envelope = full leaf minus <key> OP_CHECKSIG
    });
  }
  const ids = v.vectors.filter((x: { id: string; expected: { tagValueHex?: string } }) => x.id.startsWith('parent-id-') && x.expected.tagValueHex);
  for (const x of ids) {
    it(`${x.id}: parent tag value decodes back to the inscription id`, () => {
      expect(decodeInscriptionId(hex.decode(x.expected.tagValueHex))).toBe(x.input.inscriptionId);
    });
  }
});

describe('parseEnvelope: BSS-0005 reveal witness stack', () => {
  const v = json('bss-0005-reveal.json');
  const vec = v.vectors.find((x: { expected: { finalTxHex?: string } }) => x.expected.finalTxHex)!;
  it(`${vec.id}: parses the inscription out of the finalized reveal witness`, () => {
    const tx = Transaction.fromRaw(hex.decode(vec.expected.finalTxHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
    // Find the input whose witness is a script-path spend (script + control block, not a lone keypath sig).
    let witness: Uint8Array[] | undefined;
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness;
      if (w && w.length >= 2) witness = w as Uint8Array[];
    }
    const e = parseEnvelope(witness!)!; // pass the whole stack; the tapscript leaf is selected automatically
    expect(e.contentType).toBe(vec.input.content.contentType);
    expect(e.body.length).toBe(Number(vec.input.content.bodyLength));
    // bodyRule: body[i] = i mod 251
    expect([...e.body]).toEqual(Array.from({ length: e.body.length }, (_, i) => i % 251));
    expect(e.parents).toEqual([vec.input.content.parentId]);
  });
});

describe('parseEnvelope: all ord tags', () => {
  it('decodes pointer (2), metaprotocol (7), content encoding (9), delegate (11)', () => {
    const delegate = `${'12'.repeat(32)}i256`;
    const s = script([
      ...head,
      Uint8Array.of(1), utf8('text/plain'),
      Uint8Array.of(2), Uint8Array.of(0x10, 0x27), // 10000 LE
      Uint8Array.of(7), utf8('brc-20'),
      Uint8Array.of(9), utf8('br'),
      Uint8Array.of(11), encodeParentId(delegate),
      new Uint8Array(), utf8('hi'),
      0x68,
    ]);
    const e = parseEnvelope(s)!;
    expect(e).toMatchObject({ contentType: 'text/plain', pointer: 10000, metaprotocol: 'brc-20', contentEncoding: 'br', delegate });
    expect(e.fields.map((f) => f.name)).toEqual(['content_type', 'pointer', 'metaprotocol', 'content_encoding', 'delegate']);
    expect(e.body).toEqual(utf8('hi'));
  });

  it('reports every parent and concatenates chunked metadata', () => {
    const p1 = encodeParentId(`${'aa'.repeat(32)}i0`);
    const p2 = encodeParentId(`${'bb'.repeat(32)}i1`);
    const e = parseEnvelope(script([...head, Uint8Array.of(3), p1, Uint8Array.of(3), p2, Uint8Array.of(5), utf8('me'), Uint8Array.of(5), utf8('ta'), new Uint8Array(), 0x68]))!;
    expect(e.parents).toEqual([`${'aa'.repeat(32)}i0`, `${'bb'.repeat(32)}i1`]);
    expect(e.metadata).toEqual(utf8('meta'));
    expect(e.flags.duplicateField).toBe(false); // parent and metadata may repeat
  });
});

describe('parseEnvelope: malformed and exotic input', () => {
  it('a repeated non-repeatable tag sets duplicateField', () => {
    const e = parseEnvelope(script([...head, Uint8Array.of(1), utf8('a'), Uint8Array.of(1), utf8('b'), new Uint8Array(), 0x68]))!;
    expect(e.flags.duplicateField).toBe(true);
    expect(e.contentType).toBe('a'); // first wins
  });

  it('a tag with no value sets incompleteField', () => {
    const e = parseEnvelope(script([...head, Uint8Array.of(1), 0x68]))!;
    expect(e.flags.incompleteField).toBe(true);
  });

  it('an unknown even tag sets unrecognizedEvenField; an odd one does not', () => {
    expect(parseEnvelope(script([...head, Uint8Array.of(22), utf8('x'), 0x68]))!.flags.unrecognizedEvenField).toBe(true);
    expect(parseEnvelope(script([...head, Uint8Array.of(21), utf8('x'), 0x68]))!.flags.unrecognizedEvenField).toBe(false);
  });

  it('OP_1..OP_16 / OP_1NEGATE numeric pushes set pushnum but still decode', () => {
    const e = parseEnvelope(script([...head, 0x51, utf8('text/plain'), 0x68]))!;
    expect(e.flags.pushnum).toBe(true);
    expect(e.contentType).toBe('text/plain');
  });

  it('is not an envelope: missing OP_ENDIF, a non-push opcode inside, a wrong protocol id', () => {
    expect(parseEnvelopes(script([...head, Uint8Array.of(1), utf8('a')]))).toHaveLength(0);
    expect(parseEnvelopes(script([...head, Uint8Array.of(1), 0x75, utf8('a'), 0x68]))).toHaveLength(0);
    expect(parseEnvelopes(script([REVEAL_PUB, 0xac, 0x00, 0x63, utf8('orx'), 0x68]))).toHaveLength(0);
  });

  it('a truncated push at the end yields no envelope rather than throwing', () => {
    expect(() => parseEnvelopes(Uint8Array.of(0x00, 0x63, 0x03, 0x6f, 0x72, 0x64, 0x4c))).not.toThrow();
    expect(parseEnvelopes(Uint8Array.of(0x00, 0x63, 0x03, 0x6f, 0x72, 0x64, 0x4c))).toHaveLength(0);
  });

  it('finds two inscriptions in one script, in order', () => {
    const one = [0x00, 0x63, utf8('ord'), Uint8Array.of(1), utf8('a'), new Uint8Array(), 0x68];
    const two = [0x00, 0x63, utf8('ord'), Uint8Array.of(1), utf8('b'), new Uint8Array(), 0x68];
    const es = parseEnvelopes(script([REVEAL_PUB, 0xac, ...one, ...two]));
    expect(es.map((e) => e.contentType)).toEqual(['a', 'b']);
  });

  it('decodeInscriptionId rejects wrong lengths', () => {
    expect(decodeInscriptionId(new Uint8Array(31))).toBeUndefined();
    expect(decodeInscriptionId(new Uint8Array(37))).toBeUndefined();
  });

  it('selects the tapscript from a witness stack and skips the annex', () => {
    const leaf = buildInscriptionScript(REVEAL_PUB, { contentType: 'text/plain', body: utf8('hi') });
    const controlBlock = new Uint8Array(33).fill(0xc0);
    const annex = Uint8Array.of(0x50, 1, 2, 3);
    expect(parseEnvelope([leaf, controlBlock])!.contentType).toBe('text/plain');
    expect(parseEnvelope([leaf, controlBlock, annex])!.contentType).toBe('text/plain');
    expect(parseEnvelope([leaf])).toBeUndefined(); // no control block => not a script-path witness
  });
});
