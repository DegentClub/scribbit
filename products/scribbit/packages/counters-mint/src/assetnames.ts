/**
 * Counterparty asset names, as consensus accepts them.
 *
 * Three shapes. A *named* asset is 4–12 uppercase letters not starting with
 * A (that prefix is reserved) and costs 0.5 XCP, burned. A *numeric* asset is
 * `A` followed by an integer in (26^12, 2^64) and is free — Core never picks
 * one for you, so a "leave it blank" flow has to draw the number client-side.
 * A *subasset* is `PARENT.child`, free since block 866,000, and only the
 * parent's owner can issue it.
 *
 * Ported from counters.fun `packages/counters/src/assetnames.ts`; the asset-id
 * arithmetic mirrors Core's `ledger/issuances.py:generate_asset_id` and
 * `utils/assetnames.py:compact_subasset_longname`.
 */

export const NUMERIC_MIN = 26n ** 12n + 1n;
export const NUMERIC_MAX = 2n ** 64n - 1n;

/** Names consensus will never let anyone issue. */
export const RESERVED: ReadonlySet<string> = new Set(['BTC', 'XCP']);

/** Raw XCP burned to issue a named asset (0.5 XCP). */
export const NAMED_ISSUANCE_BURN_XCP = 50_000_000n;

const NAMED = /^[B-Z][A-Z]{3,11}$/;
const NUMERIC = /^A\d{1,20}$/;
/** Counterparty's subasset alphabet; the whole longname is capped at 250. */
const SUBASSET_CHILD = /^[a-zA-Z0-9.\-_@!]{1,250}$/;
const SUBASSET_DIGITS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_@!';

export type AssetNameKind = 'named' | 'numeric' | 'subasset';
export type AssetNameClass = AssetNameKind | 'invalid';

export type AssetNameProblem =
  | 'reserved'
  | 'numeric-out-of-range'
  | 'named-shape'
  | 'subasset-parent'
  | 'subasset-child'
  | 'subasset-length';

export type AssetNameCheck =
  | { ok: true; kind: AssetNameKind; parent?: string }
  | { ok: false; reason: AssetNameProblem };

export function isNumericAssetName(name: string): boolean {
  if (!NUMERIC.test(name)) return false;
  const value = BigInt(name.slice(1));
  return value >= NUMERIC_MIN && value <= NUMERIC_MAX;
}

/** Classify a name the way `assetnames.py` will, with the node's reason on failure. */
export function checkAssetName(raw: string): AssetNameCheck {
  const name = raw.trim();
  if (RESERVED.has(name)) return { ok: false, reason: 'reserved' };

  const dot = name.indexOf('.');
  if (dot >= 0) {
    const parent = name.slice(0, dot);
    const child = name.slice(dot + 1);
    const parentCheck = checkAssetName(parent);
    if (!parentCheck.ok || parentCheck.kind === 'subasset') return { ok: false, reason: 'subasset-parent' };
    if (!SUBASSET_CHILD.test(child)) return { ok: false, reason: 'subasset-child' };
    if (name.length > 250) return { ok: false, reason: 'subasset-length' };
    return { ok: true, kind: 'subasset', parent };
  }

  if (name.startsWith('A') && /^A\d*$/.test(name)) {
    return isNumericAssetName(name) ? { ok: true, kind: 'numeric' } : { ok: false, reason: 'numeric-out-of-range' };
  }

  if (NAMED.test(name)) return { ok: true, kind: 'named' };
  return { ok: false, reason: 'named-shape' };
}

/** The shape of a name: `named`, `numeric` (`A<n>`), `subasset` (`PARENT.child`) or `invalid`. */
export function classifyAssetName(name: string): AssetNameClass {
  const check = checkAssetName(name);
  return check.ok ? check.kind : 'invalid';
}

/**
 * A numeric asset name drawn with real randomness. Front-running protection:
 * a predictable name can be issued out from under a launch. Uniform over the
 * valid range up to the (negligible) modulo bias of 64 random bits.
 */
export function randomNumericAsset(): string {
  const span = NUMERIC_MAX - NUMERIC_MIN;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `A${NUMERIC_MIN + (value % span)}`;
}

/**
 * XCP burned to issue this name, in raw units: 0.5 XCP for a named asset,
 * nothing for numeric names and subassets. Throws on an invalid name.
 */
export function issuanceBurnXcp(name: string): bigint {
  const kind = classifyAssetName(name);
  if (kind === 'invalid') throw new Error(`not a valid asset name: ${name}`);
  return kind === 'named' ? NAMED_ISSUANCE_BURN_XCP : 0n;
}

/** Core's `generate_asset_id`: base-26 for named assets, the number itself for `A<n>`. */
export function assetId(name: string): bigint {
  if (name === 'BTC') return 0n;
  if (name === 'XCP') return 1n;
  if (name.startsWith('A')) {
    if (!isNumericAssetName(name)) throw new Error(`numeric asset name not in range: ${name}`);
    return BigInt(name.slice(1));
  }
  if (!NAMED.test(name)) throw new Error(`not a valid named asset: ${name}`);
  let n = 0n;
  for (const c of name) n = n * 26n + BigInt(c.charCodeAt(0) - 65);
  return n;
}

/** Core's `compact_subasset_longname`: the child name as a big-endian base-68 integer. */
export function compactSubassetLongname(longname: string): Uint8Array {
  let n = 0n;
  for (const c of longname) {
    const digit = SUBASSET_DIGITS.indexOf(c);
    if (digit < 0) throw new Error(`invalid subasset character: ${c}`);
    n = n * 68n + BigInt(digit + 1);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from(out);
}
