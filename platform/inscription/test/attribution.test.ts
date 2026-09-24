import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import {
  buildInscriptionScript,
  decodeAttribution,
  decodeCbor,
  encodeAttribution,
  encodeCbor,
  estimateRevealWeight,
  inscriptionScriptLength,
  type Attribution,
} from '../src/index.js';
import { decodeScript, RECIPIENT, REVEAL_PUB, bytes } from './helpers.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const h = (s: string) => hex.decode(s.replace(/\s+/g, ''));

// Hand-computed vectors (RFC 8949 §4.2.1: shortest heads, map keys sorted by their encoded bytes).
//   "artist"  = 66 61 72 74 69 73 74      "studio"  = 66 73 74 75 64 69 6f
//   "artwork" = 67 61 72 74 77 6f 72 6b   "edition" = 67 65 64 69 74 69 6f 6e
//   "bc1qa…"  = 65 …                      "art-1"   = 65 61 72 74 2d 31       "open" = 64 6f 70 65 6e
const ARTIST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ARTIST_HEX = '78 2a' + hex.encode(utf8(ARTIST)); // 42 bytes → PUSHDATA-like 1-byte length head (0x78 = text, 24)
const TWO_KEYS = `a2 66 617274697374 ${ARTIST_HEX} 67 617274776f726b 65 6172742d31`;
const FOUR_KEYS = `a4 66 617274697374 ${ARTIST_HEX} 66 73747564696f 64 6f70656e 67 617274776f726b 65 6172742d31 67 65646974696f6e 07`;

describe('encodeAttribution: deterministic canonical CBOR', () => {
  it('matches hand-computed bytes (two keys, and all four in canonical key order)', () => {
    expect(hex.encode(encodeAttribution({ artist: ARTIST, artwork: 'art-1' }))).toBe(hex.encode(h(TWO_KEYS)));
    expect(hex.encode(encodeAttribution({ artist: ARTIST, artwork: 'art-1', edition: 7, studio: 'open' }))).toBe(hex.encode(h(FOUR_KEYS)));
    // a short artist string keeps the small head: the README example
    expect(hex.encode(encodeCbor({ artist: 'bc1qa', artwork: 'art-1' }))).toBe('a2' + '66617274697374' + '656263317161' + '67617274776f726b' + '656172742d31');
  });

  it('is independent of property order and of repeated calls', () => {
    const a = encodeAttribution({ studio: 'open', edition: 7, artwork: 'art-1', artist: ARTIST });
    const b = encodeAttribution({ artist: ARTIST, artwork: 'art-1', edition: 7, studio: 'open' });
    expect(a).toEqual(b);
    expect(encodeAttribution({ artist: ARTIST, artwork: 'art-1' })).toEqual(encodeAttribution({ artist: ARTIST, artwork: 'art-1' }));
    expect(hex.encode(encodeCbor({ b: 1, a: 2, aa: 3 }))).toBe('a3' + '6161' + '02' + '6162' + '01' + '626161' + '03'); // a < b < aa (length-first via bytewise on heads)
  });

  it('round-trips, with and without the optional fields', () => {
    for (const a of [
      { artist: ARTIST, artwork: 'art-1' },
      { artist: ARTIST, artwork: 'moonrise-04', edition: 0 },
      { artist: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', artwork: 'x', edition: 4_294_967_296, studio: 'open-studio' },
      { artist: ARTIST, artwork: 'ünïcödé 🙂', studio: 'studio' },
    ] satisfies Attribution[]) {
      expect(decodeAttribution(encodeAttribution(a))).toEqual(a);
    }
  });

  it('validates the fields', () => {
    expect(() => encodeAttribution({ artist: 'not an address!', artwork: 'a' })).toThrow(/artist/);
    expect(() => encodeAttribution({ artist: 'short', artwork: 'a' })).toThrow(/artist/);
    expect(() => encodeAttribution({ artist: ARTIST, artwork: '' })).toThrow(/artwork/);
    expect(() => encodeAttribution({ artist: ARTIST, artwork: 'x'.repeat(129) })).toThrow(/artwork/);
    expect(() => encodeAttribution({ artist: ARTIST, artwork: 'a', edition: -1 })).toThrow(/edition/);
    expect(() => encodeAttribution({ artist: ARTIST, artwork: 'a', edition: 1.5 })).toThrow(/edition/);
    expect(() => encodeAttribution({ artist: ARTIST, artwork: 'a', studio: '' })).toThrow(/studio/);
    expect(() => encodeAttribution({ artist: ARTIST, artwork: 'a', studio: 's'.repeat(65) })).toThrow(/studio/);
    expect(() => encodeAttribution(null as never)).toThrow(/object/);
  });
});

describe('the tiny CBOR codec', () => {
  it('encodes integers in shortest form at every boundary', () => {
    const cases: Array<[number, string]> = [
      [0, '00'],
      [23, '17'],
      [24, '1818'],
      [255, '18ff'],
      [256, '190100'],
      [65535, '19ffff'],
      [65536, '1a00010000'],
      [4_294_967_295, '1affffffff'],
      [4_294_967_296, '1b0000000100000000'],
      [Number.MAX_SAFE_INTEGER, '1b001fffffffffffff'],
    ];
    for (const [n, expected] of cases) {
      expect(hex.encode(encodeCbor(n)), String(n)).toBe(expected);
      expect(decodeCbor(h(expected))).toBe(n);
    }
    expect(() => encodeCbor(-1)).toThrow(/unsigned/);
    expect(() => encodeCbor(1.5)).toThrow(/unsigned/);
    expect(() => encodeCbor(2 ** 53)).toThrow(/unsigned/);
  });

  it('encodes text by UTF-8 byte length with the right head', () => {
    expect(hex.encode(encodeCbor(''))).toBe('60');
    expect(hex.encode(encodeCbor('a'.repeat(23)))).toBe('77' + '61'.repeat(23));
    expect(hex.encode(encodeCbor('a'.repeat(24)))).toBe('7818' + '61'.repeat(24));
    expect(hex.encode(encodeCbor('a'.repeat(256)))).toBe('790100' + '61'.repeat(256));
    expect(hex.encode(encodeCbor('é'))).toBe('62c3a9'); // 2 bytes, 1 code point
    expect(decodeCbor(h('62c3a9'))).toBe('é');
    expect(() => encodeCbor([1] as never)).toThrow(/unsupported/);
    expect(() => encodeCbor(new Uint8Array(1) as never)).toThrow(/unsupported/);
  });

  it('decodes strictly: canonical only, subset only, no trailing bytes', () => {
    expect(decodeCbor(h('a0'))).toEqual({});
    expect(() => decodeCbor(h('1800'))).toThrow(/shortest/); // 0 encoded with a 1-byte argument
    expect(() => decodeCbor(h('190001'))).toThrow(/shortest/);
    expect(() => decodeCbor(h('1a00000100'))).toThrow(/shortest/);
    expect(() => decodeCbor(h('1b00000000ffffffff'))).toThrow(/shortest/);
    expect(() => decodeCbor(h('1b0020000000000000'))).toThrow(/2\^53/);
    expect(() => decodeCbor(h('a2 6162 01 6161 02'))).toThrow(/sorted/); // b before a
    expect(() => decodeCbor(h('a2 6161 01 6161 02'))).toThrow(/sorted|duplicate/);
    expect(() => decodeCbor(h('a1 01 01'))).toThrow(/text strings/); // integer key
    expect(() => decodeCbor(h('20'))).toThrow(/major type 1/); // negative int
    expect(() => decodeCbor(h('4100'))).toThrow(/major type 2/); // byte string
    expect(() => decodeCbor(h('80'))).toThrow(/major type 4/); // array
    expect(() => decodeCbor(h('f6'))).toThrow(/major type 7/); // null
    expect(() => decodeCbor(h('9f'))).toThrow(/indefinite/);
    expect(() => decodeCbor(h('0000'))).toThrow(/trailing/);
    expect(() => decodeCbor(h('6161 00'))).toThrow(/trailing/);
    expect(() => decodeCbor(h('62c3'))).toThrow(/truncated/);
    expect(() => decodeCbor(h('61ff'))).toThrow(); // invalid UTF-8
    expect(() => decodeCbor(new Uint8Array())).toThrow(/truncated/);
    expect(() => decodeCbor('a0' as never)).toThrow(/Uint8Array/);
  });

  it('decodeAttribution ignores unknown keys but checks the known ones', () => {
    const extra = encodeCbor({ artist: ARTIST, artwork: 'a', minter: 'someone', edition: 3 });
    expect(decodeAttribution(extra)).toEqual({ artist: ARTIST, artwork: 'a', edition: 3 });
    expect(() => decodeAttribution(encodeCbor({ artwork: 'a' }))).toThrow(/artist/);
    expect(() => decodeAttribution(encodeCbor({ artist: ARTIST, artwork: 'a', edition: 'seven' }))).toThrow(/edition/);
    expect(() => decodeAttribution(encodeCbor({ artist: ARTIST, artwork: 'a', studio: 1 }))).toThrow(/studio/);
    expect(() => decodeAttribution(encodeCbor(1))).toThrow(/map/);
    expect(() => decodeAttribution(encodeCbor('x'))).toThrow(/map/);
  });
});

describe('attribution in the envelope', () => {
  const attribution: Attribution = { artist: ARTIST, artwork: 'moonrise-04', edition: 7, studio: 'open' };
  const encoded = encodeAttribution(attribution);
  const body = bytes(10, 3);

  it('lands in tag 5 exactly as encodeAttribution emits it, and an explicit metadata wins', () => {
    const script = buildInscriptionScript(REVEAL_PUB, { contentType: 'image/webp', body, attribution });
    const ops = decodeScript(script);
    expect(ops[6]).toEqual({ opcode: 10, data: utf8('image/webp') });
    expect(ops[7]).toEqual({ opcode: 1, data: Uint8Array.of(5) });
    expect(ops[8]!.data).toEqual(encoded);
    expect(decodeAttribution(ops[8]!.data!)).toEqual(attribution);
    expect(ops[9]).toEqual({ opcode: 0, data: new Uint8Array() }); // body tag
    expect(ops[10]!.data).toEqual(body);
    // identical to passing the bytes as metadata
    expect(script).toEqual(buildInscriptionScript(REVEAL_PUB, { contentType: 'image/webp', body, metadata: encoded }));
    // explicit metadata wins over attribution
    const explicit = buildInscriptionScript(REVEAL_PUB, { contentType: 'image/webp', body, metadata: bytes(7, 9), attribution });
    expect(decodeScript(explicit)[8]!.data).toEqual(bytes(7, 9));
    // an empty explicit metadata omits tag 5 even with an attribution
    expect(decodeScript(buildInscriptionScript(REVEAL_PUB, { contentType: 'image/webp', body, metadata: new Uint8Array(), attribution }))[7]).toEqual({ opcode: 0, data: new Uint8Array() });
    // invalid attribution is refused at build time
    expect(() => buildInscriptionScript(REVEAL_PUB, { contentType: 'image/webp', body, attribution: { artist: 'nope', artwork: 'a' } })).toThrow(/artist/);
  });

  it('is accounted for in inscriptionScriptLength and estimateRevealWeight', () => {
    const plain = { contentType: 'image/webp', body };
    const withAttr = { ...plain, attribution };
    const withMeta = { ...plain, metadata: encoded };
    const push = (n: number) => (n <= 75 ? 1 + n : n <= 255 ? 2 + n : 3 + n); // minimal push: direct / PUSHDATA1 / PUSHDATA2
    const extra = 2 /* 0x01 0x05 tag push */ + push(encoded.length); // 93 bytes here → PUSHDATA1
    expect(encoded.length).toBeGreaterThan(75);
    expect(inscriptionScriptLength(withAttr)).toBe(buildInscriptionScript(REVEAL_PUB, withAttr).length);
    expect(inscriptionScriptLength(withAttr)).toBe(inscriptionScriptLength(plain) + extra);
    expect(inscriptionScriptLength(withAttr)).toBe(inscriptionScriptLength(withMeta));
    for (const withParent of [false, true]) {
      const w = (content: typeof plain) => estimateRevealWeight({ content, withParent, recipientScript: RECIPIENT.script });
      expect(w(withAttr)).toBe(w(withMeta));
      expect(w(withAttr)).toBe(w(plain) + extra); // witness bytes weigh 1 WU each
    }
  });
});
