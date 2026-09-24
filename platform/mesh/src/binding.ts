// A key-binding document (SCRIBBIT EXTENSION; nothing in the FlashyOS material
// defines one). It ties the Ed25519 key an organisation signs invoices, receipts and
// checkpoint heads with to the BIP340 (x-only secp256k1) key it uses on Bitcoin, by
// signing the same canonical bytes with both - so a counterparty who trusts one key
// can trust the other, and a taproot key path on chain can be linked to a receipt.
//
//   { version: 1, org, ed25519: { kid, publicKey }, bip340: { xonlyPubkeyHex },
//     issuedAt, sigEd25519, sigBip340 }
//
// sigEd25519 = base64url(ed25519(canonical(signed fields))) under ed25519.publicKey.
// sigBip340  = hex(bip340_sign(sha256(canonical(signed fields)))) under bip340.xonlyPubkeyHex.
//
// BIP340 uses @noble/curves (already a dependency of @bsh/inscription at the same
// version); a caller may pass its own sign/verify instead.
import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, canonicalBytes, fromBase64Url, hexToBytes, sha256Bytes, toBase64Url } from './canonical.ts';
import { isRecord } from './common.ts';
import { asPrivateKey, keyFingerprint, publicKeyOf } from './keys.ts';

export const BINDING_VERSION = 1;
export const BINDING_WELL_KNOWN = '/.well-known/bsh-key-binding.json';
export const BINDING_SIGNED_FIELDS = ['version', 'org', 'ed25519', 'bip340', 'issuedAt'] as const;

export interface KeyBindingUnsigned {
  version: 1;
  /** The organisation slug (the charter's `slug`). */
  org: string;
  ed25519: { kid: string; publicKey: string };
  bip340: { xonlyPubkeyHex: string };
  /** ISO timestamp. */
  issuedAt: string;
}

export interface KeyBinding extends KeyBindingUnsigned {
  sigEd25519: string;
  sigBip340: string;
}

export type KeyBindingDraft = KeyBindingUnsigned & Partial<Pick<KeyBinding, 'sigEd25519' | 'sigBip340'>>;

export type Bip340Sign = (message32: Uint8Array, secretKey: Uint8Array) => Uint8Array;
export type Bip340Verify = (signature: Uint8Array, message32: Uint8Array, xonlyPublicKey: Uint8Array) => boolean;

/** The default BIP340 implementation: @noble/curves' schnorr. */
export const nobleBip340: { sign: Bip340Sign; verify: Bip340Verify; getPublicKey: (secretKey: Uint8Array) => Uint8Array; randomSecretKey: () => Uint8Array } = {
  sign: (m, k) => schnorr.sign(m, k),
  verify: (s, m, p) => {
    try {
      return schnorr.verify(s, m, p);
    } catch {
      return false;
    }
  },
  getPublicKey: (k) => schnorr.getPublicKey(k),
  randomSecretKey: () => schnorr.utils.randomSecretKey(),
};

const XONLY_RE = /^[0-9a-f]{64}$/;

/** The bytes both signatures cover: the signed fields, canonical. */
export function canonicalBinding(doc: KeyBindingUnsigned | KeyBinding | KeyBindingDraft): Buffer {
  const picked: Record<string, unknown> = {};
  for (const k of BINDING_SIGNED_FIELDS) picked[k] = (doc as unknown as Record<string, unknown>)[k];
  return canonicalBytes(picked);
}

/** The 32-byte message BIP340 signs: sha256 of the canonical binding. */
export const bindingDigest = (doc: KeyBindingUnsigned | KeyBinding | KeyBindingDraft): Uint8Array => new Uint8Array(sha256Bytes(canonicalBinding(doc)));

export function createBindingUnsigned(input: { org: string; ed25519PublicKey: string; xonlyPubkeyHex: string; issuedAt?: string }): KeyBindingUnsigned {
  if (!input.org) throw new TypeError('org is required');
  if (!XONLY_RE.test(input.xonlyPubkeyHex)) throw new TypeError('xonlyPubkeyHex is 32 bytes of lowercase hex');
  const publicKey = createPublicKey(input.ed25519PublicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new TypeError('ed25519PublicKey is not an Ed25519 key');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    version: 1,
    org: input.org,
    ed25519: { kid: keyFingerprint(pem), publicKey: pem },
    bip340: { xonlyPubkeyHex: input.xonlyPubkeyHex },
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
}

/** Adds `sigEd25519`. The private key must be the one `ed25519.publicKey` names. */
export function signBindingEd25519<T extends KeyBindingDraft>(doc: T, privateKey: string | KeyObject): T & { sigEd25519: string } {
  const key = asPrivateKey(privateKey);
  if (keyFingerprint(publicKeyOf(key)) !== doc.ed25519.kid) throw new Error('the private key is not the one ed25519.kid names');
  return { ...doc, sigEd25519: toBase64Url(edSign(null, canonicalBinding(doc), key)) };
}

/** Adds `sigBip340`. `secretKey` is the 32-byte secp256k1 secret whose x-only public key `bip340.xonlyPubkeyHex` names. */
export function signBindingBip340<T extends KeyBindingDraft>(doc: T, secretKey: Uint8Array, sign: Bip340Sign = nobleBip340.sign): T & { sigBip340: string } {
  return { ...doc, sigBip340: bytesToHex(sign(bindingDigest(doc), secretKey)) };
}

export function signBinding(doc: KeyBindingUnsigned, keys: { ed25519PrivateKey: string | KeyObject; bip340SecretKey: Uint8Array; bip340Sign?: Bip340Sign }): KeyBinding {
  return signBindingBip340(signBindingEd25519(doc, keys.ed25519PrivateKey), keys.bip340SecretKey, keys.bip340Sign);
}

export type BindingCheck = { ok: true } | { ok: false; code: 'MALFORMED' | 'BAD_KID' | 'UNSIGNED' | 'BAD_ED25519_SIGNATURE' | 'BAD_BIP340_SIGNATURE'; detail: string };

function shapeOf(doc: unknown): { ok: true; doc: KeyBindingDraft } | { ok: false; code: 'MALFORMED' | 'BAD_KID'; detail: string } {
  if (!isRecord(doc) || doc.version !== BINDING_VERSION || typeof doc.org !== 'string' || !doc.org || typeof doc.issuedAt !== 'string')
    return { ok: false, code: 'MALFORMED', detail: 'a binding carries version 1, org and issuedAt' };
  const ed = doc.ed25519;
  const bip = doc.bip340;
  if (!isRecord(ed) || typeof ed.kid !== 'string' || typeof ed.publicKey !== 'string') return { ok: false, code: 'MALFORMED', detail: 'ed25519 carries kid and publicKey' };
  if (!isRecord(bip) || typeof bip.xonlyPubkeyHex !== 'string' || !XONLY_RE.test(bip.xonlyPubkeyHex)) return { ok: false, code: 'MALFORMED', detail: 'bip340.xonlyPubkeyHex is 32 bytes of lowercase hex' };
  let kid: string;
  try {
    kid = keyFingerprint(ed.publicKey);
  } catch (err) {
    return { ok: false, code: 'MALFORMED', detail: (err as Error).message };
  }
  if (kid !== ed.kid) return { ok: false, code: 'BAD_KID', detail: `ed25519.kid is not the fingerprint of the key it carries (${kid})` };
  return { ok: true, doc: doc as unknown as KeyBindingDraft };
}

export function verifyBindingEd25519(doc: unknown): BindingCheck {
  const shape = shapeOf(doc);
  if (!shape.ok) return shape;
  const d = shape.doc;
  if (typeof d.sigEd25519 !== 'string' || !d.sigEd25519) return { ok: false, code: 'UNSIGNED', detail: 'no sigEd25519' };
  try {
    const ok = edVerify(null, canonicalBinding(d), createPublicKey(d.ed25519.publicKey), fromBase64Url(d.sigEd25519));
    return ok ? { ok: true } : { ok: false, code: 'BAD_ED25519_SIGNATURE', detail: 'sigEd25519 does not verify under ed25519.publicKey' };
  } catch (err) {
    return { ok: false, code: 'BAD_ED25519_SIGNATURE', detail: (err as Error).message };
  }
}

export function verifyBindingBip340(doc: unknown, verify: Bip340Verify = nobleBip340.verify): BindingCheck {
  const shape = shapeOf(doc);
  if (!shape.ok) return shape;
  const d = shape.doc;
  if (typeof d.sigBip340 !== 'string' || !d.sigBip340) return { ok: false, code: 'UNSIGNED', detail: 'no sigBip340' };
  try {
    const sig = hexToBytes(d.sigBip340);
    if (sig.length !== 64) return { ok: false, code: 'BAD_BIP340_SIGNATURE', detail: 'a BIP340 signature is 64 bytes' };
    const ok = verify(sig, bindingDigest(d), hexToBytes(d.bip340.xonlyPubkeyHex));
    return ok ? { ok: true } : { ok: false, code: 'BAD_BIP340_SIGNATURE', detail: 'sigBip340 does not verify under bip340.xonlyPubkeyHex' };
  } catch (err) {
    return { ok: false, code: 'BAD_BIP340_SIGNATURE', detail: (err as Error).message };
  }
}

/** Both signatures, both keys. */
export function verifyBinding(doc: unknown, options: { bip340Verify?: Bip340Verify } = {}): BindingCheck {
  const ed = verifyBindingEd25519(doc);
  if (!ed.ok) return ed;
  return verifyBindingBip340(doc, options.bip340Verify);
}
