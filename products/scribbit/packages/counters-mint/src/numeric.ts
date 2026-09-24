/**
 * Exact integer handling for Counterparty quantities (unsigned 64-bit).
 * Doubles are exact only to 2^53-1 and JSON.parse rounds larger literals
 * during parsing; XCP-69's 10^16 hard cap sits above that line, so equality
 * checks and compose parameters must see exact digits. BigInt throughout.
 *
 * Ported from counters.fun `packages/counters/src/numeric.ts` (the subset the
 * mint engine needs).
 */

/** A raw quantity as parsed: `number` within the safe range, `string` above it. */
export type Raw = number | string;
export type RawLike = Raw | bigint;

/** Raw units per whole unit of a divisible asset. */
export const SATS_PER_UNIT = 100_000_000n;

/**
 * Quote integer literals outside the double-safe range. Walks the text so
 * digits inside string literals are untouched; fractions/exponents pass.
 */
export function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = i;
      if (text[i] === '-') i += 1;
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i += 1;
      let isInteger = true;
      if (i < text.length && (text[i] === '.' || text[i] === 'e' || text[i] === 'E')) {
        isInteger = false;
        while (i < text.length && /[0-9eE+\-.]/.test(text[i]!)) i += 1;
      }
      const literal = text.slice(start, i);
      out += isInteger && !Number.isSafeInteger(Number(literal)) ? `"${literal}"` : literal;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** JSON.parse with integers above 2^53-1 preserved as strings. */
export function parseJsonLossless<T = unknown>(text: string): T {
  return JSON.parse(quoteUnsafeIntegers(text)) as T;
}

/** Exact bigint, or null for non-integers, unsafe doubles, and null/undefined. */
export function toBigInt(value: RawLike | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

/** {@link toBigInt} with zero substituted for unreadable values. */
export function big(value: RawLike | null | undefined): bigint {
  return toBigInt(value) ?? 0n;
}

/**
 * Exact decimal digits for a compose parameter — the last gate before signing.
 * Unsafe doubles throw; strings and bigints pass through.
 */
export function quantityParam(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) throw new Error(`Refusing to compose a non-finite quantity (${value}).`);
  if (!Number.isInteger(value)) throw new Error(`Refusing to compose a fractional quantity (${value}).`);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Quantity ${value} is past the exact range of a JavaScript number. Pass it as a string or bigint.`);
  }
  return value.toString();
}
