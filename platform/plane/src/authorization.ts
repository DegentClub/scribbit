// SpendAuthorization - FlashyOS docs/wallet/spec.md §6 and schema/spend-authorization.json,
// field for field: a single-use (the id is the nonce), short-lived (300 s), Ed25519-signed
// capability naming exactly what may happen. Canonical form: every field but `sig`, keys
// sorted, no whitespace (@bsh/mesh's canonical JSON, byte-identical to theirs).
//
// The signer's side is `verifyAuthorization`: signature under a key it already trusts,
// the window, then - re-deriving the record from the ACTUAL call, not from the
// authorization - chain, kind, asset and destination must match and amount <= maxAmount;
// only then is the nonce consumed, so a refused call does not burn it, and a second use
// is REPLAY.
import { sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { AMOUNT_RE, asPrivateKey, canonicalBytes, CHAIN_RE, fromBase64Url, normalizePem, toBase64Url } from '@bsh/mesh';
import { AUTHORIZATION_TTL_MS } from './decide.ts';
import { normalizeAddress, OPERATION_KINDS, type OperationKind } from './record.ts';
import type { NonceStore } from './store/types.ts';

export const SPEND_AUTHORIZATION_SCHEMA_ID = 'https://flashyos.com/schema/wallet/spend-authorization.json';
export const AUTHORIZATION_CLOCK_SKEW_MS = 30_000;

export interface SpendAuthorizationPayload {
  /** The nonce. Single use. */
  id: string;
  orgId: string;
  agentName: string;
  chain: string;
  kind: OperationKind;
  asset: string;
  /** Inclusive ceiling, base units. */
  maxAmount: string;
  destination: string | null;
  reservationId: string;
  decisionId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SpendAuthorization extends SpendAuthorizationPayload {
  /** base64url(ed25519(canonical payload)). */
  sig: string;
}

export const AUTHORIZATION_SIGNED_FIELDS = ['id', 'orgId', 'agentName', 'chain', 'kind', 'asset', 'maxAmount', 'destination', 'reservationId', 'decisionId', 'issuedAt', 'expiresAt'] as const;

export function canonicalAuthorization(a: SpendAuthorizationPayload | SpendAuthorization): Buffer {
  const picked: Record<string, unknown> = {};
  for (const k of AUTHORIZATION_SIGNED_FIELDS) picked[k] = (a as unknown as Record<string, unknown>)[k];
  return canonicalBytes(picked);
}

export function signAuthorization(payload: SpendAuthorizationPayload, privateKey: string | KeyObject): SpendAuthorization {
  return { ...payload, sig: toBase64Url(edSign(null, canonicalAuthorization(payload), asPrivateKey(privateKey))) };
}

export type AuthorizationCheck =
  | { ok: true; kid?: string }
  | { ok: false; code: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' | 'REPLAY' | 'MISMATCH'; detail: string };

const isIso = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

export function isSpendAuthorization(v: unknown): v is SpendAuthorization {
  const a = v as SpendAuthorization;
  return (
    !!a && typeof a === 'object' && !Array.isArray(a) &&
    Object.keys(a).every((k) => k === 'sig' || (AUTHORIZATION_SIGNED_FIELDS as readonly string[]).includes(k)) &&
    nonEmpty(a.id) && nonEmpty(a.orgId) && nonEmpty(a.agentName) && typeof a.chain === 'string' && CHAIN_RE.test(a.chain) &&
    (OPERATION_KINDS as readonly string[]).includes(a.kind) && nonEmpty(a.asset) && typeof a.maxAmount === 'string' && AMOUNT_RE.test(a.maxAmount) &&
    (a.destination === null || nonEmpty(a.destination)) && nonEmpty(a.reservationId) && nonEmpty(a.decisionId) &&
    isIso(a.issuedAt) && isIso(a.expiresAt) && nonEmpty(a.sig)
  );
}

/** What the signer is actually being asked to do, derived from the call's own arguments. */
export interface ActualOperation {
  chain: string;
  kind: OperationKind;
  asset: string;
  amount: string | bigint;
  destination: string | null;
}

export interface VerifyAuthorizationOptions {
  /** Public keys (SPKI PEM) the verifier trusts: a plane document's keys, retired ones included. */
  trustedKeys: readonly string[];
  now?: Date;
  /** With a nonce store the authorization is consumed on success; a second use is REPLAY. */
  nonces?: NonceStore;
  /** The call to check against the authorization. */
  operation?: ActualOperation;
  /** Longest window accepted (default 300 s): an authorization claiming a longer life is MALFORMED. */
  maxTtlMs?: number;
}

/** Never throws (a failing nonce store aside). Order: shape, signature, window, match, nonce. */
export async function verifyAuthorization(auth: unknown, options: VerifyAuthorizationOptions): Promise<AuthorizationCheck> {
  if (!isSpendAuthorization(auth)) return { ok: false, code: 'MALFORMED', detail: 'not a SpendAuthorization' };
  const issued = Date.parse(auth.issuedAt);
  const expires = Date.parse(auth.expiresAt);
  const maxTtl = options.maxTtlMs ?? AUTHORIZATION_TTL_MS;
  if (expires <= issued || expires - issued > maxTtl) return { ok: false, code: 'MALFORMED', detail: `window of ${expires - issued} ms is not within (0, ${maxTtl}]` };

  let verified = false;
  const bytes = canonicalAuthorization(auth);
  let sig: Buffer;
  try {
    sig = fromBase64Url(auth.sig);
  } catch {
    return { ok: false, code: 'BAD_SIGNATURE', detail: 'sig is not base64url' };
  }
  for (const pem of options.trustedKeys) {
    try {
      if (edVerify(null, bytes, createPublicKey(pem), sig)) {
        verified = true;
        break;
      }
    } catch {
      // a key that does not parse verifies nothing
    }
  }
  if (!verified) return { ok: false, code: 'BAD_SIGNATURE', detail: 'the signature does not verify under any trusted key' };

  const now = (options.now ?? new Date()).getTime();
  if (now + AUTHORIZATION_CLOCK_SKEW_MS < issued) return { ok: false, code: 'NOT_YET_VALID', detail: `issued at ${auth.issuedAt}` };
  if (now > expires) return { ok: false, code: 'EXPIRED', detail: `expired at ${auth.expiresAt}` };

  const op = options.operation;
  if (op) {
    const mismatch: string[] = [];
    if (op.chain !== auth.chain) mismatch.push(`chain ${op.chain} != ${auth.chain}`);
    if (op.kind !== auth.kind) mismatch.push(`kind ${op.kind} != ${auth.kind}`);
    const asset = op.asset === 'native' ? op.asset : normalizeAddress(op.chain, op.asset);
    if (asset !== auth.asset) mismatch.push(`asset ${op.asset} != ${auth.asset}`);
    const dest = op.destination === null ? null : normalizeAddress(op.chain, op.destination);
    if (dest !== auth.destination) mismatch.push(`destination ${op.destination ?? 'null'} != ${auth.destination ?? 'null'}`);
    let amount: bigint | undefined;
    try {
      amount = typeof op.amount === 'bigint' ? op.amount : AMOUNT_RE.test(op.amount) ? BigInt(op.amount) : undefined;
    } catch {
      amount = undefined;
    }
    if (amount === undefined || amount < 0n) mismatch.push(`amount ${String(op.amount)} is not an amount`);
    else if (amount > BigInt(auth.maxAmount)) mismatch.push(`amount ${amount} > maxAmount ${auth.maxAmount}`);
    if (mismatch.length) return { ok: false, code: 'MISMATCH', detail: mismatch.join('; ') };
  }

  if (options.nonces && !(await options.nonces.consume(`authz:${auth.id}`, auth.expiresAt))) return { ok: false, code: 'REPLAY', detail: `authorization ${auth.id} was already used` };
  return { ok: true };
}

/** In-memory nonce store: forgets a nonce once it has expired (it can no longer verify anyway). */
export class MemoryNonceStore implements NonceStore {
  private readonly used = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  async consume(id: string, expiresAt: string): Promise<boolean> {
    const t = this.now();
    if (this.used.size > 10_000) for (const [k, exp] of this.used) if (exp < t) this.used.delete(k);
    if (this.used.has(id)) return false;
    this.used.set(id, Date.parse(expiresAt) || t);
    return true;
  }
}

/** True when two PEMs are the same key. */
export const samePem = (a: string, b: string): boolean => normalizePem(a) === normalizePem(b);
