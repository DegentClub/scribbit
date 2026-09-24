// Ed25519 keys as FlashyOS carries them: SPKI PEM public keys, PKCS#8 PEM private
// keys, and the key id (`kid`) = sha256 of the SPKI DER, hex - the same key in any PEM
// formatting has one kid (interop.ts, keyFingerprint). node:crypto only.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export const PEM_PUBLIC_KEY_RE = /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/;

export const asPrivateKey = (pem: string | KeyObject): KeyObject => (typeof pem === 'string' ? createPrivateKey(pem) : pem);
export const asPublicKey = (pem: string | KeyObject): KeyObject => (typeof pem === 'string' ? createPublicKey(pem) : pem);

/** Two PEMs are the same key when they agree with whitespace removed. */
export const normalizePem = (pem: string): string => pem.replace(/\s+/g, '');

/** A key's id: sha256 of its SPKI DER, hex. Throws for a string that is not a public key. */
export function keyFingerprint(publicKeyPem: string | KeyObject): string {
  return createHash('sha256').update(asPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');
}

/** True when the PEM parses as an Ed25519 public key. Never throws. */
export function isEd25519PublicKey(pem: unknown): pem is string {
  if (typeof pem !== 'string') return false;
  try {
    return createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export interface Ed25519KeyPair {
  /** PKCS#8 PEM. Never publish, never commit. */
  privateKey: string;
  /** SPKI PEM. */
  publicKey: string;
  kid: string;
}

export function generateKeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pub, kid: keyFingerprint(pub) };
}

/** The SPKI PEM of the public half of a private key. */
export const publicKeyOf = (privateKey: string | KeyObject): string => createPublicKey(asPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' }).toString();
