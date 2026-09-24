// Canonical JSON and the hashes over it.
//
// The rule, byte-identical to @flashyos/verify's canonicalStringify (vendor-shiplog.mjs)
// and to the `canonical()` of flashyos-wdk's interop.ts: keys sorted recursively, arrays
// kept in order, no whitespace, `undefined` members dropped (JSON.stringify's own rule),
// Dates as ISO strings. Every seal, digest and signature in this package is over these bytes.
import { createHash } from 'node:crypto';

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(src)
        .sort()
        .map((k) => [k, sortKeysDeep(src[k])]),
    );
  }
  return value;
}

/** JSON with keys sorted at every depth and no whitespace. Throws for a value JSON cannot carry (undefined, a function). */
export function canonicalStringify(value: unknown): string {
  const out = JSON.stringify(sortKeysDeep(value));
  if (out === undefined) throw new TypeError('value has no JSON representation');
  return out;
}

export const canonicalBytes = (value: unknown): Buffer => Buffer.from(canonicalStringify(value), 'utf8');

export function sha256Bytes(input: string | Uint8Array): Buffer {
  return createHash('sha256').update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).digest();
}

export const sha256Hex = (input: string | Uint8Array): string => sha256Bytes(input).toString('hex');

/** sha256 of the canonical JSON of `value`, hex - the digest every sealed record carries. */
export const digestOf = (value: unknown): string => sha256Hex(canonicalStringify(value));

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** Strict: refuses padding and any character outside the base64url alphabet. */
export function fromBase64Url(text: string): Buffer {
  if (typeof text !== 'string' || !BASE64URL_RE.test(text)) throw new TypeError('not base64url');
  return Buffer.from(text, 'base64url');
}

export const isBase64Url = (text: unknown): text is string => typeof text === 'string' && BASE64URL_RE.test(text);

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError('not hex');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
