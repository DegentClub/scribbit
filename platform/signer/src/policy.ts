/**
 * Policies: pure, side-effect-free inspections of a signing request that the signer runs BEFORE it
 * touches a key. A policy sees a normalised view of the request (never the PSBT bytes it would have to
 * parse itself, never key material) and answers allow / deny with a reason that ends up in the audit log.
 */

/**
 * A denial carries a human-readable `reason` and, for built-in policies, a stable machine `code`
 * (snake_case, e.g. `fee_above_cap`) that is copied to the audit record's `denialCode`. Codes are an open
 * set: new policies add new codes, existing codes never change meaning.
 */
export type PolicyDecision = { allow: true } | { allow: false; reason: string; code?: string };

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
export const deny = (reason: string, code?: string): PolicyDecision => ({ allow: false, reason, ...(code ? { code } : {}) });

/** All policies must allow; the first denial wins (evaluated in order, sequentially). */
export function allOf<T>(policies: readonly Policy<T>[], name = 'all-of'): Policy<T> {
  return {
    name,
    async inspect(req) {
      for (const p of policies) {
        const d = await p.inspect(req);
        if (!d.allow) return deny(`${p.name}: ${d.reason}`, d.code);
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
    inspect: (r) => (set.has(r.sighashType) ? allow : deny(`sighash type ${hexByte(r.sighashType)} is not allowed`, 'sighash_not_allowed')),
  };
}

/** The input being signed may not be worth more than `maxSats`. */
export function maxInputValue(maxSats: bigint): Policy<TaprootKeyPathInspection> {
  return {
    name: 'max-input-value',
    inspect: (r) => (r.input.amount <= maxSats ? allow : deny(`input value ${r.input.amount} exceeds ${maxSats} sats`, 'input_value_above_cap')),
  };
}

/** The transaction's fee (all inputs known) may not exceed `maxSats`: catches fee-burning and bad PSBTs. */
export function maxFee(maxSats: bigint): Policy<TaprootKeyPathInspection> {
  return {
    name: 'max-fee',
    inspect: (r) => (r.fee >= 0n && r.fee <= maxSats ? allow : deny(`fee ${r.fee} sats is outside [0, ${maxSats}]`, r.fee < 0n ? 'fee_negative' : 'fee_above_cap')),
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
        return deny(`output ${i} (${o.address ?? o.script}) is not in the allowlist`, 'output_not_allowed');
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
    inspect: (r) => (set.has(r.purpose) ? allow : deny(`purpose "${r.purpose}" is not allowed`, 'purpose_not_allowed')),
  };
}

/** Restrict which principals (API key ids) may use a given key. */
export function principalAllowlist(byKey: Readonly<Record<string, readonly string[]>>): Policy<{ keyId: string; principal: string }> {
  return {
    name: 'principal-allowlist',
    inspect(r) {
      const list = byKey[r.keyId];
      if (!list) return deny(`key "${r.keyId}" has no principal allowlist`, 'principal_not_allowed');
      return list.includes(r.principal) ? allow : deny(`principal "${r.principal}" may not use key "${r.keyId}"`, 'principal_not_allowed');
    },
  };
}

const hexByte = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/**
 * Route by key id: requests for a key in `byKey` get that key's policy (its decision is returned unchanged),
 * any other key is denied with `key_not_covered`. Use it when one instance serves several keys that each need
 * their own shape policy, so a key without one can never fall through to "allow".
 */
export function forKeys(byKey: Readonly<Record<string, Policy<TaprootKeyPathInspection>>>, name = 'per-key'): Policy<TaprootKeyPathInspection> {
  return {
    name,
    inspect(r) {
      const p = Object.hasOwn(byKey, r.keyId) ? byKey[r.keyId] : undefined;
      return p ? p.inspect(r) : deny(`key_not_covered: key "${r.keyId}" has no ${name} policy on this instance`, 'key_not_covered');
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// parentReturn: the degent collection-parent co-signing shape (degent ADR-0002 §3, ADR-0005).

/** P2TR dust: the smallest output the parent-return policy accepts after output 0 by default. */
export const P2TR_DUST_SATS = 330n;

/** Stable denial codes of `parentReturn` (also the substring after `parent-return: ` in the reason). */
export const PARENT_RETURN_DENIAL_CODES = [
  'key_not_covered',
  'input_index_not_allowed',
  'sighash_not_allowed',
  'too_few_inputs',
  'too_many_inputs',
  'too_few_outputs',
  'too_many_outputs',
  'parent_return_script_mismatch',
  'parent_return_value_mismatch',
  'postage_below_dust',
  'fee_negative',
  'fee_above_cap',
] as const;
export type ParentReturnDenialCode = (typeof PARENT_RETURN_DENIAL_CODES)[number];

export interface ParentReturnPolicyConfig {
  kind?: 'parentReturn';
  /** The collection key this policy governs; any other key id is denied (`key_not_covered`). */
  keyId: string;
  /**
   * scriptPubKey (hex) output 0 must pay. Default: the key-path P2TR script of `keyId` itself, i.e. the input
   * being signed (the signer has already proven that input pays `p2tr(key)`, else `input_mismatch`).
   */
  returnScript?: string;
  /** The only input index that may be signed (the parent). Default 0; output 0 returns THIS input. */
  inputIndex?: number;
  /** Inputs must number between 2 (parent + funding commit) and this. Default 2 (exact shape). */
  maxInputs?: number;
  /** Outputs must number between 2 (parent return + child) and this. Default 2 (exact shape). */
  maxOutputs?: number;
  /** Every output after output 0 must carry at least this many sats. Default 330 (P2TR dust). */
  minPostageSats?: bigint | number;
  /** Transaction fee (sum inputs - sum outputs) must be in [0, maxFeeSats]. Required. */
  maxFeeSats: bigint | number;
  /** BIP341 hash types the parent may be signed with. Default [0x00] (SIGHASH_DEFAULT commits to everything). */
  allowedSighash?: readonly number[];
}

function sats(v: bigint | number | undefined, what: string, dflt?: bigint): bigint {
  if (v === undefined) {
    if (dflt === undefined) throw new TypeError(`parentReturn: ${what} is required`);
    return dflt;
  }
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new TypeError(`parentReturn: ${what} must be an integer number of sats`);
  const b = BigInt(v);
  if (b < 0n) throw new TypeError(`parentReturn: ${what} must be non-negative`);
  return b;
}

/**
 * Pin a co-signature to the parent-return shape. The key may sign input `inputIndex` (0) of a transaction only if:
 *
 * - it has 2..maxInputs inputs (the parent + the minter's commit) and 2..maxOutputs outputs;
 * - the input is signed with an allowed hash type (default SIGHASH_DEFAULT only);
 * - output 0 pays `returnScript` (default: the key's own P2TR script, i.e. the collection address) with EXACTLY
 *   the signed input's value (ord puts the child on the first sat after the parent's, so a larger output 0
 *   would swallow the child and a smaller one would leak parent value);
 * - every other output carries >= minPostageSats (default 330);
 * - the fee is within [0, maxFeeSats].
 *
 * It works on the lean PSBT the degent mint sends (unsigned tx + `witnessUtxo` for every input, nothing else):
 * it needs no leaf script, signature or taproot metadata on the other inputs. It cannot see which recipient the
 * order recorded; the mint's own policy (gate 1) and the minter's 0x81 signature on input 1 pin that.
 */
export function parentReturn(config: ParentReturnPolicyConfig): Policy<TaprootKeyPathInspection> {
  if (config.kind !== undefined && config.kind !== 'parentReturn') throw new TypeError(`parentReturn: unexpected kind "${String(config.kind)}"`);
  if (typeof config.keyId !== 'string' || !config.keyId) throw new TypeError('parentReturn: keyId is required');
  const inputIndex = config.inputIndex ?? 0;
  const maxInputs = config.maxInputs ?? 2;
  const maxOutputs = config.maxOutputs ?? 2;
  for (const [k, v, min] of [['inputIndex', inputIndex, 0], ['maxInputs', maxInputs, 2], ['maxOutputs', maxOutputs, 2]] as const)
    if (!Number.isInteger(v) || v < min) throw new TypeError(`parentReturn: ${k} must be an integer >= ${min}`);
  if (inputIndex >= maxInputs) throw new TypeError('parentReturn: inputIndex must be < maxInputs');
  const returnScript = config.returnScript?.toLowerCase();
  if (returnScript !== undefined && !/^([0-9a-f]{2}){1,80}$/.test(returnScript)) throw new TypeError('parentReturn: returnScript must be scriptPubKey hex');
  const minPostage = sats(config.minPostageSats, 'minPostageSats', P2TR_DUST_SATS);
  const maxFeeSats = sats(config.maxFeeSats, 'maxFeeSats');
  const sighash = new Set(config.allowedSighash ?? [0x00]);
  if (sighash.size === 0) throw new TypeError('parentReturn: allowedSighash must not be empty');

  const no = (code: ParentReturnDenialCode, detail: string): PolicyDecision => deny(`${code}: ${detail}`, code);

  return {
    name: 'parent-return',
    inspect(r) {
      if (r.keyId !== config.keyId) return no('key_not_covered', `key "${r.keyId}" is not the parent key "${config.keyId}" of this policy`);
      if (r.inputIndex !== inputIndex) return no('input_index_not_allowed', `only input ${inputIndex} (the parent) may be signed, not input ${r.inputIndex}`);
      if (!sighash.has(r.sighashType)) return no('sighash_not_allowed', `sighash type ${hexByte(r.sighashType)} is not allowed for the parent`);
      if (r.inputs.length < 2) return no('too_few_inputs', `expected the parent and a commit input, got ${r.inputs.length} input(s)`);
      if (r.inputs.length > maxInputs) return no('too_many_inputs', `${r.inputs.length} inputs, at most ${maxInputs} allowed`);
      if (r.outputs.length < 2) return no('too_few_outputs', `expected the parent return and a child output, got ${r.outputs.length} output(s)`);
      if (r.outputs.length > maxOutputs) return no('too_many_outputs', `${r.outputs.length} outputs, at most ${maxOutputs} allowed`);

      const parent = r.inputs[inputIndex] ?? r.input;
      const expectedScript = returnScript ?? parent.script.toLowerCase();
      const out0 = r.outputs[0]!;
      if (out0.script.toLowerCase() !== expectedScript)
        return no('parent_return_script_mismatch', `output 0 pays ${out0.address ?? out0.script}, not the parent return script ${expectedScript}`);
      if (out0.amount !== parent.amount)
        return no('parent_return_value_mismatch', `output 0 carries ${out0.amount} sats, the parent input ${parent.amount} sats; they must be equal`);
      for (let i = 1; i < r.outputs.length; i++) {
        const o = r.outputs[i]!;
        if (o.amount < minPostage) return no('postage_below_dust', `output ${i} carries ${o.amount} sats, below the ${minPostage}-sat minimum`);
      }
      if (r.fee < 0n) return no('fee_negative', `outputs exceed inputs by ${-r.fee} sats`);
      if (r.fee > maxFeeSats) return no('fee_above_cap', `fee ${r.fee} sats exceeds the ${maxFeeSats}-sat cap`);
      return allow;
    },
  };
}
