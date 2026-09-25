/**
 * The policy-constrained signer. Every request goes: validate → inspect (derive facts) → policy →
 * key provider → verify → audit. A denial never reaches the key provider; a key-provider failure is
 * audited as `error`. Nothing here holds key material: that stays behind `KeyProvider`.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { p2tr } from '@scure/btc-signer';
import type { AuditLog, AuditRecord } from './audit.js';
import { SignerError, isSignerError } from './errors.js';
import type { KeyProvider } from './key-provider.js';
import {
  allOf,
  allowAll,
  allowedSighashTypes,
  purposeAllowlist,
  type Policy,
  type SchnorrDigestInspection,
  type TaprootKeyPathInspection,
} from './policy.js';
import { attachKeyPathSignature, inspectTaprootKeyPath, type BitcoinNetwork } from './taproot.js';

export interface SignTaprootKeyPathRequest {
  psbtBase64: string;
  inputIndex: number;
  keyId: string;
  /** Also finalize the input (tapKeySig → final witness). Default false. */
  finalize?: boolean;
}

export interface SignTaprootKeyPathResult {
  psbtBase64: string;
  keyId: string;
  inputIndex: number;
  sighashType: number;
  /** 64-byte BIP340 signature, hex (without the sighash byte). */
  signature: string;
  /** BIP341 sighash that was signed, hex. */
  digest: string;
  /** Present when `finalize` produced a complete transaction. */
  txid?: string;
}

export interface SignSchnorrDigestRequest {
  keyId: string;
  /** 32-byte digest, hex. The signer never hashes for the caller: the purpose defines the preimage. */
  digest32: string;
  /** Must be on the purpose allowlist (e.g. `blockspace.certify`). */
  purpose: string;
}

export interface SignSchnorrDigestResult {
  keyId: string;
  purpose: string;
  digest32: string;
  signature: string;
  /** x-only public key (untweaked) the signature verifies against, hex. */
  publicKey: string;
}

/** Per-call context: who asked (audit) and the request id to correlate with edge logs. */
export interface CallContext {
  principal?: string;
  requestId?: string;
}

export interface SignerOptions {
  keys: KeyProvider;
  audit: AuditLog;
  /** Attestation purposes that may be signed. Empty = digest signing disabled. */
  allowedPurposes: readonly string[];
  /** Extra taproot policies (all must allow). A sighash-type policy is always applied first. */
  taprootPolicies?: readonly Policy<TaprootKeyPathInspection>[];
  /** Extra digest policies (all must allow). The purpose allowlist is always applied first. */
  digestPolicies?: readonly Policy<SchnorrDigestInspection>[];
  /** Hash types the taproot path may sign. Default DEFAULT + ALL. */
  allowedSighashTypes?: readonly number[];
  /** Network used to render output addresses for policies and audit records. */
  network?: BitcoinNetwork;
  now?: () => number;
  idGenerator?: () => string;
}

const HEX32 = /^[0-9a-fA-F]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PURPOSE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)*$/;

export class Signer {
  private readonly taprootPolicy: Policy<TaprootKeyPathInspection>;
  private readonly digestPolicy: Policy<SchnorrDigestInspection>;
  private readonly now: () => number;
  private readonly nextId: () => string;
  readonly network: BitcoinNetwork;

  constructor(private readonly o: SignerOptions) {
    this.taprootPolicy = allOf([allowedSighashTypes(o.allowedSighashTypes), ...(o.taprootPolicies ?? [allowAll()])], 'taproot');
    this.digestPolicy = allOf([purposeAllowlist(o.allowedPurposes), ...(o.digestPolicies ?? [allowAll()])], 'digest');
    this.now = o.now ?? Date.now;
    this.nextId = o.idGenerator ?? (() => crypto.randomUUID());
    this.network = o.network ?? 'mainnet';
  }

  keyIds(): Promise<string[]> {
    return this.o.keys.keyIds();
  }

  /** x-only public key + the key-path P2TR output key derived from it, hex. */
  async publicKey(keyId: string): Promise<{ keyId: string; xOnlyPublicKey: string; tweakedPublicKey: string }> {
    assertKeyId(keyId);
    const x = await this.o.keys.publicKey(keyId);
    return { keyId, xOnlyPublicKey: hex.encode(x), tweakedPublicKey: hex.encode(p2tr(x).tweakedPubkey) };
  }

  async signTaprootKeyPath(req: SignTaprootKeyPathRequest, ctx: CallContext = {}): Promise<SignTaprootKeyPathResult> {
    const started = this.now();
    const principal = ctx.principal ?? 'local';
    const details: Record<string, unknown> = { inputIndex: req?.inputIndex };
    const record = (decision: AuditRecord['decision'], reason?: string, denialCode?: string) =>
      this.audit({ kind: 'taproot-keypath', keyId: String(req?.keyId), principal, decision, reason, denialCode, requestId: ctx.requestId, started, details });

    try {
      if (!req || typeof req.psbtBase64 !== 'string' || !req.psbtBase64) throw new SignerError('invalid_request', 'psbtBase64 is required');
      assertKeyId(req.keyId);
      const xonly = await this.o.keys.publicKey(req.keyId);
      const insp = inspectTaprootKeyPath(req.psbtBase64, req.inputIndex, xonly, this.network);
      Object.assign(details, {
        sighashType: insp.sighashType,
        digest: hex.encode(insp.digest),
        input: { ...insp.input, amount: insp.input.amount.toString() },
        outputs: insp.outputs.map((o) => ({ amount: o.amount.toString(), address: o.address ?? o.script })),
        fee: insp.fee.toString(),
        finalize: req.finalize === true,
      });
      const view: TaprootKeyPathInspection = {
        kind: 'taproot-keypath',
        keyId: req.keyId,
        inputIndex: insp.inputIndex,
        sighashType: insp.sighashType,
        input: insp.input,
        inputs: insp.inputs,
        outputs: insp.outputs,
        version: insp.version,
        lockTime: insp.lockTime,
        fee: insp.fee,
        principal,
      };
      const decision = await this.taprootPolicy.inspect(view);
      if (!decision.allow) {
        await record('deny', decision.reason, decision.code);
        throw new SignerError('policy_denied', decision.reason);
      }
      const sig = await this.o.keys.sign(req.keyId, insp.digest, { tweak: 'bip341' });
      const out = attachKeyPathSignature(insp, sig, req.finalize === true);
      if (out.txid) details.txid = out.txid;
      await record('allow');
      return {
        psbtBase64: out.psbtBase64,
        keyId: req.keyId,
        inputIndex: insp.inputIndex,
        sighashType: insp.sighashType,
        signature: hex.encode(sig),
        digest: hex.encode(insp.digest),
        ...(out.txid ? { txid: out.txid } : {}),
      };
    } catch (e) {
      if (isSignerError(e) && e.code === 'policy_denied') throw e; // already audited as deny
      const err = isSignerError(e) ? e : new SignerError('key_provider_error', 'signing failed', { cause: e });
      await record('error', `${err.code}: ${err.message}`);
      throw err;
    }
  }

  async signSchnorrDigest(req: SignSchnorrDigestRequest, ctx: CallContext = {}): Promise<SignSchnorrDigestResult> {
    const started = this.now();
    const principal = ctx.principal ?? 'local';
    const details: Record<string, unknown> = { purpose: req?.purpose, digest: req?.digest32 };
    const record = (decision: AuditRecord['decision'], reason?: string, denialCode?: string) =>
      this.audit({ kind: 'schnorr-digest', keyId: String(req?.keyId), principal, decision, reason, denialCode, requestId: ctx.requestId, started, details });

    try {
      if (!req) throw new SignerError('invalid_request', 'request body is required');
      assertKeyId(req.keyId);
      if (typeof req.purpose !== 'string' || !PURPOSE.test(req.purpose)) throw new SignerError('invalid_request', 'purpose must be a dotted lowercase name');
      if (typeof req.digest32 !== 'string' || !HEX32.test(req.digest32)) throw new SignerError('invalid_request', 'digest32 must be 32 bytes of hex');
      const digest = hex.decode(req.digest32.toLowerCase());
      const view: SchnorrDigestInspection = { kind: 'schnorr-digest', keyId: req.keyId, purpose: req.purpose, digest32: req.digest32.toLowerCase(), principal };
      const decision = await this.digestPolicy.inspect(view);
      if (!decision.allow) {
        await record('deny', decision.reason, decision.code);
        throw new SignerError('policy_denied', decision.reason);
      }
      const pub = await this.o.keys.publicKey(req.keyId);
      const sig = await this.o.keys.sign(req.keyId, digest);
      if (sig.length !== 64 || !schnorr.verify(sig, digest, pub)) throw new SignerError('signature_invalid', 'signature does not verify against the key');
      await record('allow');
      return { keyId: req.keyId, purpose: req.purpose, digest32: req.digest32.toLowerCase(), signature: hex.encode(sig), publicKey: hex.encode(pub) };
    } catch (e) {
      if (isSignerError(e) && e.code === 'policy_denied') throw e;
      const err = isSignerError(e) ? e : new SignerError('key_provider_error', 'signing failed', { cause: e });
      await record('error', `${err.code}: ${err.message}`);
      throw err;
    }
  }

  private async audit(a: {
    kind: AuditRecord['kind'];
    keyId: string;
    principal: string;
    decision: AuditRecord['decision'];
    reason?: string;
    denialCode?: string;
    requestId?: string;
    started: number;
    details: Record<string, unknown>;
  }): Promise<void> {
    const rec: AuditRecord = {
      id: this.nextId(),
      at: new Date(this.now()).toISOString(),
      kind: a.kind,
      keyId: a.keyId,
      principal: a.principal,
      decision: a.decision,
      ...(a.reason ? { reason: a.reason } : {}),
      ...(a.denialCode ? { denialCode: a.denialCode } : {}),
      ...(a.requestId ? { requestId: a.requestId } : {}),
      durationMs: Math.max(0, this.now() - a.started),
      details: a.details,
    };
    await this.o.audit.append(rec);
  }
}

function assertKeyId(keyId: unknown): asserts keyId is string {
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new SignerError('invalid_request', 'keyId is required (alphanumerics, ".", "_", "-")');
}
