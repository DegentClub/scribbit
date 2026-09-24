import { concatBytes, utf8 } from './bytes.js';

/**
 * Attribution metadata for an inscription (ord reads envelope tag 5 as CBOR and shows it as the
 * inscription's metadata). Encoded as a minimal *canonical* CBOR map so the same attribution always
 * yields the same bytes (and the same commit address / reveal weight).
 */
export interface Attribution {
  /** Bitcoin address of the artist (the payee of the royalty output). */
  artist: string;
  /** Artwork id, owned by the product. */
  artwork: string;
  /** Edition number within the artwork (non-negative integer). */
  edition?: number;
  /** Studio / collection slug. */
  studio?: string;
}

/** The CBOR subset this module speaks: unsigned integers, text strings and maps with text keys. */
export type CborValue = number | string | CborMap;
export interface CborMap {
  [key: string]: CborValue;
}

const MAJOR_UINT = 0;
const MAJOR_TEXT = 3;
const MAJOR_MAP = 5;
const TWO_32 = 0x1_0000_0000;

// ------------------------------------------------------------------------------------------ encoder

/** Shortest-form head (RFC 8949 §4.2.1): the argument uses the fewest bytes that hold it. */
function head(major: number, n: number): Uint8Array {
  const mt = major << 5;
  if (n < 24) return Uint8Array.of(mt | n);
  if (n <= 0xff) return Uint8Array.of(mt | 24, n);
  if (n <= 0xffff) return Uint8Array.of(mt | 25, n >>> 8, n & 0xff);
  if (n <= 0xffff_ffff) return Uint8Array.of(mt | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const hi = Math.floor(n / TWO_32);
  const lo = n % TWO_32;
  return Uint8Array.of(mt | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
}

/** Bytewise lexicographic order; a proper prefix sorts first. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Deterministic CBOR (RFC 8949 §4.2.1) for the subset: shortest heads, definite lengths, map keys sorted by
 * their encoded bytes, no duplicates. Unsigned safe integers, strings and plain objects only.
 */
export function encodeCbor(value: CborValue): Uint8Array {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`cbor: unsigned safe integer expected, got ${value}`);
    return head(MAJOR_UINT, value);
  }
  if (typeof value === 'string') {
    const b = utf8(value);
    return concatBytes(head(MAJOR_TEXT, b.length), b);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const entries = Object.entries(value).map(([k, v]) => ({ key: encodeCbor(k), value: encodeCbor(v) }));
    entries.sort((x, y) => compareBytes(x.key, y.key));
    return concatBytes(head(MAJOR_MAP, entries.length), ...entries.flatMap((e) => [e.key, e.value]));
  }
  throw new TypeError(`cbor: unsupported value ${String(value)}`);
}

// ------------------------------------------------------------------------------------------ decoder

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('cbor: truncated');
    return this.buf[this.pos++]!;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('cbor: truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Head → (major, argument). Rejects indefinite lengths and non-shortest arguments (canonical only). */
  head(): { major: number; n: number } {
    const b = this.byte();
    const major = b >> 5;
    const info = b & 0x1f;
    if (info < 24) return { major, n: info };
    if (info === 24) {
      const n = this.byte();
      if (n < 24) throw new Error('cbor: non-canonical (argument not in shortest form)');
      return { major, n };
    }
    if (info === 25) {
      const n = (this.byte() << 8) | this.byte();
      if (n <= 0xff) throw new Error('cbor: non-canonical (argument not in shortest form)');
      return { major, n };
    }
    if (info === 26) {
      const n = ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
      if (n <= 0xffff) throw new Error('cbor: non-canonical (argument not in shortest form)');
      return { major, n };
    }
    if (info === 27) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.byte());
      if (v <= 0xffff_ffffn) throw new Error('cbor: non-canonical (argument not in shortest form)');
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('cbor: integer above 2^53-1');
      return { major, n: Number(v) };
    }
    throw new Error(`cbor: unsupported additional information ${info} (indefinite lengths are not canonical)`);
  }

  value(): CborValue {
    const { major, n } = this.head();
    switch (major) {
      case MAJOR_UINT:
        return n;
      case MAJOR_TEXT: {
        const b = this.bytes(n);
        return new TextDecoder('utf-8', { fatal: true }).decode(b);
      }
      case MAJOR_MAP: {
        const out: CborMap = {};
        let prevKey: Uint8Array | undefined;
        for (let i = 0; i < n; i++) {
          const keyStart = this.pos;
          const key = this.value();
          if (typeof key !== 'string') throw new Error('cbor: map keys must be text strings');
          const keyBytes = this.buf.subarray(keyStart, this.pos);
          if (prevKey && compareBytes(prevKey, keyBytes) >= 0) throw new Error('cbor: non-canonical (map keys not sorted / duplicate)');
          prevKey = keyBytes;
          out[key] = this.value();
        }
        return out;
      }
      default:
        throw new Error(`cbor: unsupported major type ${major}`);
    }
  }
}

/** Strict inverse of `encodeCbor`: rejects anything outside the subset, non-canonical forms and trailing bytes. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('cbor: Uint8Array expected');
  const r = new Reader(bytes);
  const v = r.value();
  if (r.pos !== bytes.length) throw new Error(`cbor: ${bytes.length - r.pos} trailing byte(s)`);
  return v;
}

// ------------------------------------------------------------------------------------------ attribution

const ADDRESS = /^[a-zA-Z0-9]{14,100}$/; // base58 / bech32 alphabets, any network
const MAX_ARTWORK = 128;
const MAX_STUDIO = 64;

function validateAttribution(a: Attribution): Attribution {
  if (!a || typeof a !== 'object') throw new TypeError('attribution must be an object');
  if (typeof a.artist !== 'string' || !ADDRESS.test(a.artist)) throw new Error('attribution.artist must be a bitcoin address (14..100 alphanumerics)');
  if (typeof a.artwork !== 'string' || a.artwork.length === 0 || a.artwork.length > MAX_ARTWORK) throw new Error(`attribution.artwork must be 1..${MAX_ARTWORK} characters`);
  const out: Attribution = { artist: a.artist, artwork: a.artwork };
  if (a.edition !== undefined) {
    if (!Number.isSafeInteger(a.edition) || a.edition < 0) throw new Error('attribution.edition must be a non-negative integer');
    out.edition = a.edition;
  }
  if (a.studio !== undefined) {
    if (typeof a.studio !== 'string' || a.studio.length === 0 || a.studio.length > MAX_STUDIO) throw new Error(`attribution.studio must be 1..${MAX_STUDIO} characters`);
    out.studio = a.studio;
  }
  return out;
}

/**
 * Attribution → canonical CBOR map `{ artist, artwork, [edition], [studio] }` (keys in canonical order:
 * `artist`, `studio`, `artwork`, `edition`). Deterministic: the same attribution always yields the same bytes.
 */
export function encodeAttribution(attribution: Attribution): Uint8Array {
  const a = validateAttribution(attribution);
  const map: CborMap = { artist: a.artist, artwork: a.artwork };
  if (a.edition !== undefined) map.edition = a.edition;
  if (a.studio !== undefined) map.studio = a.studio;
  return encodeCbor(map);
}

/** Inverse of `encodeAttribution`. Unknown keys are ignored; known keys must have the right type. */
export function decodeAttribution(bytes: Uint8Array): Attribution {
  const v = decodeCbor(bytes);
  if (typeof v !== 'object') throw new Error('attribution: CBOR map expected');
  const a: Attribution = { artist: v.artist as string, artwork: v.artwork as string };
  if (v.edition !== undefined) a.edition = v.edition as number;
  if (v.studio !== undefined) a.studio = v.studio as string;
  return validateAttribution(a);
}
