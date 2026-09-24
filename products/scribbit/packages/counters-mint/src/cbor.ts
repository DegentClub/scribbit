/**
 * The slice of CBOR (RFC 8949) Counterparty Core's `cbor2.dumps` produces for
 * its taproot messages: unsigned integers, booleans, null, text strings, byte
 * strings and arrays. Used only to size an envelope before compose — the bytes
 * that go on chain always come from Core.
 */

export type CborValue = bigint | number | boolean | null | string | Uint8Array | CborValue[];

function head(major: number, n: bigint): number[] {
  const m = major << 5;
  if (n < 24n) return [m | Number(n)];
  if (n <= 0xffn) return [m | 24, Number(n)];
  if (n <= 0xffffn) return [m | 25, Number(n >> 8n), Number(n & 0xffn)];
  if (n <= 0xffffffffn) {
    const out = [m | 26];
    for (let i = 3; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
    return out;
  }
  if (n <= 0xffffffffffffffffn) {
    const out = [m | 27];
    for (let i = 7; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
    return out;
  }
  throw new Error('CBOR: integer exceeds 64 bits');
}

export function cborEncode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const out = {
    push(...bytes: number[]): void {
      parts.push(Uint8Array.from(bytes));
      total += bytes.length;
    },
    bytes(b: Uint8Array): void {
      parts.push(b);
      total += b.length;
    },
  };
  const write = (v: CborValue): void => {
    if (v === null) {
      out.push(0xf6);
    } else if (typeof v === 'boolean') {
      out.push(v ? 0xf5 : 0xf4);
    } else if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('CBOR: only integers are encoded');
      if (v < 0) out.push(...head(1, BigInt(-v) - 1n));
      else out.push(...head(0, BigInt(v)));
    } else if (typeof v === 'bigint') {
      if (v < 0n) out.push(...head(1, -v - 1n));
      else out.push(...head(0, v));
    } else if (typeof v === 'string') {
      const bytes = new TextEncoder().encode(v);
      out.push(...head(3, BigInt(bytes.length)));
      out.bytes(bytes);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, BigInt(v.length)));
      out.bytes(v);
    } else if (Array.isArray(v)) {
      out.push(...head(4, BigInt(v.length)));
      for (const item of v) write(item);
    } else {
      throw new Error('CBOR: unsupported value');
    }
  };
  write(value);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
