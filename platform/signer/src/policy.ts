/**
 * Policies: pure, side-effect-free inspections of a signing request that the signer runs BEFORE it
 * touches a key. A policy sees a normalised view of the request (never the PSBT bytes it would have to
 * parse itself, never key material) and answers allow / deny with a reason that ends up in the audit log.
 */

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

export interface Policy<TReq> {
  /** Stable name for the audit record (`policy:<name>` on a denial). */
  readonly name: string;
  inspect(request: TReq): PolicyDecision | Promise<PolicyDecision>;
}

/** What a policy sees for a taproot key-path signing request. Derived by the signer from the PSBT. */
export interface TaprootKeyPathInspection {
  kind: 'taproot-keypath';
  keyId: string;
  inputIndex: number;
  /** BIP341 hash type actually used (0x00 = SIGHASH_DEFAULT). */
  sighashType: number;
  input: { txid: string; vout: number; amount: bigint; script: string };
  /** Every input's prevout: a policy can bound the total spend. */
  inputs: Array<{ txid: string; vout: number; amount: bigint; script: string }>;
  outputs: Array<{ amount: bigint; script: string; address?: string }>;
  version: number;
  lockTime: number;
  /** Sum(inputs) - Sum(outputs); defined only when every prevout is known (it always is here). */
  fee: bigint;
  /** Caller identity as authenticated by the service (API key id) or `local` for in-process use. */
  principal: string;
}

/** What a policy sees for a raw Schnorr digest request (attestations). */
export interface SchnorrDigestInspection {
  kind: 'schnorr-digest';
  keyId: string;
  purpose: string;
  digest32: string;
  principal: string;
}

export const allow: PolicyDecision = { allow: true };
export const deny = (reason: string): PolicyDecision => ({ allow: false, reason });

/** All policies must allow; the first denial wins (evaluated in order, sequentially). */
export function allOf<T>(policies: readonly Policy<T>[], name = 'all-of'): Policy<T> {
  return {
    name,
    async inspect(req) {
      for (const p of policies) {
        const d = await p.inspect(req);
        if (!d.allow) return deny(`${p.name}: ${d.reason}`);
      }
      return allow;
    },
  };
}

export const allowAll = <T>(): Policy<T> => ({ name: 'allow-all', inspect: () => allow });
export const denyAll = <T>(reason = 'signing disabled'): Policy<T> => ({ name: 'deny-all', inspect: () => deny(reason) });

/** Only these BIP341 hash types may be signed (default: SIGHASH_DEFAULT and SIGHASH_ALL). */
export function allowedSighashTypes(types: readonly number[] = [0x00, 0x01]): Policy<TaprootKeyPathInspection> {
  const set = new Set(types);
  return {
    name: 'sighash',
    inspect: (r) => (set.has(r.sighashType) ? allow : deny(`sighash type 0x${r.sighashType.toString(16).padStart(2, '0')} is not allowed`)),
  };
}

/** The input being signed may not be worth more than `maxSats`. */
export function maxInputValue(maxSats: bigint): Policy<TaprootKeyPathInspection> {
  return {
    name: 'max-input-value',
    inspect: (r) => (r.input.amount <= maxSats ? allow : deny(`input value ${r.input.amount} exceeds ${maxSats} sats`)),
  };
}

/** The transaction's fee (all inputs known) may not exceed `maxSats`: catches fee-burning and bad PSBTs. */
export function maxFee(maxSats: bigint): Policy<TaprootKeyPathInspection> {
  return {
    name: 'max-fee',
    inspect: (r) => (r.fee >= 0n && r.fee <= maxSats ? allow : deny(`fee ${r.fee} sats is outside [0, ${maxSats}]`)),
  };
}

/**
 * Every output must pay one of the allowed scriptPubKeys (hex) or addresses. Use for keys that only ever
 * return funds to a fixed treasury / collection address.
 */
export function outputAllowlist(allowed: readonly string[]): Policy<TaprootKeyPathInspection> {
  const set = new Set(allowed.map((s) => s.toLowerCase()));
  return {
    name: 'output-allowlist',
    inspect(r) {
      for (const [i, o] of r.outputs.entries()) {
        if (set.has(o.script.toLowerCase()) || (o.address && set.has(o.address.toLowerCase()))) continue;
        return deny(`output ${i} (${o.address ?? o.script}) is not in the allowlist`);
      }
      return allow;
    },
  };
}

/** Attestation purposes a key may sign. `blockspace.certify` etc. Unknown purposes are always denied. */
export function purposeAllowlist(purposes: readonly string[]): Policy<SchnorrDigestInspection> {
  const set = new Set(purposes);
  return {
    name: 'purpose-allowlist',
    inspect: (r) => (set.has(r.purpose) ? allow : deny(`purpose "${r.purpose}" is not allowed`)),
  };
}

/** Restrict which principals (API key ids) may use a given key. */
export function principalAllowlist(byKey: Readonly<Record<string, readonly string[]>>): Policy<{ keyId: string; principal: string }> {
  return {
    name: 'principal-allowlist',
    inspect(r) {
      const list = byKey[r.keyId];
      if (!list) return deny(`key "${r.keyId}" has no principal allowlist`);
      return list.includes(r.principal) ? allow : deny(`principal "${r.principal}" may not use key "${r.keyId}"`);
    },
  };
}
