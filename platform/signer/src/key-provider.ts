/**
 * The key boundary. A `KeyProvider` is the ONLY thing that ever sees a private key; the signer above it
 * hands over a 32-byte digest and gets back a 64-byte BIP340 signature. Swapping the software providers
 * for an HSM changes nothing above this file.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { taprootTweakPrivKey } from '@scure/btc-signer/utils.js';
import { readFileSync, statSync } from 'node:fs';
import { SignerError } from './errors.js';

export interface SignOptions {
  /**
   * `bip341`: sign with the taproot-tweaked key (BIP341 key-path spend). `merkleRoot` is the script tree
   * root committed to by the output key; omitted = no script tree (the common key-path-only case).
   * Software providers derive the tweaked key on the fly; see `HsmKeyProvider` for what an HSM needs.
   */
  tweak?: 'bip341';
  merkleRoot?: Uint8Array;
}

export interface KeyProvider {
  /** x-only (32-byte) BIP340 public key of the UNTWEAKED key. Throws `unknown_key`. */
  publicKey(keyId: string): Promise<Uint8Array>;
  /** BIP340 Schnorr signature (64 bytes, no sighash byte) over a 32-byte message. */
  sign(keyId: string, msg32: Uint8Array, opts?: SignOptions): Promise<Uint8Array>;
  /** Key ids this provider serves (for health / discovery; never the keys). */
  keyIds(): Promise<string[]>;
}

/**
 * PKCS#11-style hardware key provider. Implementations wrap a vendor library (`pkcs11js`, CloudHSM,
 * YubiHSM, a Ledger/Coldcard host bridge, an enclave RPC) behind this shape:
 *
 *   init(): load the library / open the session (idempotent)
 *   login(): authenticate the operator PIN / attestation (from the secret store, never from argv)
 *   sign(): C_Sign with the key handle found by label = keyId
 *   close(): C_Logout + C_CloseSession
 *
 * BIP340 in hardware. Most PKCS#11 modules do not implement BIP340 Schnorr (`CKM_ECDSA` only), so the
 * options today are: (a) a module that ships a Schnorr mechanism (e.g. Securosys HSM `CKM_SCHNORR`,
 * Thales Luna with the BIP340 extension, AWS CloudHSM custom mechanism, Fortanix DSM `BIP340`) —
 * `sign()` maps `SIGN_MECHANISM` to it; (b) a software enclave (Nitro/SEV) running noble-curves, exposed as
 * this interface, where the enclave measurement is the trust anchor; (c) MuSig2/FROST, where the HSM holds
 * one share. The taproot tweak: an HSM cannot add a scalar to a stored private key, so a key used for
 * key-path spends is either **generated already tweaked** (`tweakedInHardware: true`; the provider then
 * ignores `opts.tweak`, and `publicKey()` must still return the untweaked x-only key for output-script
 * verification — store it as key metadata), or the module supports a "sign with tweak" mechanism. Never
 * export the key to tweak it in software: that defeats the HSM.
 */
export interface HsmKeyProvider extends KeyProvider {
  init(): Promise<void>;
  login(credentials: { pin: string } | { attestation: string }): Promise<void>;
  close(): Promise<void>;
  /** Vendor/mechanism the provider will use for `sign`, for the audit log and health endpoint. */
  readonly mechanism: string;
  /** Keys that were generated inside the HSM with the taproot tweak applied (see above). */
  readonly tweakedInHardware: ReadonlySet<string>;
}

export class KeyNotFoundError extends SignerError {
  constructor(keyId: string) {
    super('unknown_key', `unknown key "${keyId}"`);
  }
}

function assert32(bytes: Uint8Array, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new SignerError('invalid_request', `${what} must be 32 bytes`);
}

/** Software provider over in-memory secrets. Base class for the file and env providers; usable directly in tests. */
export class InMemoryKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(entries: Iterable<[keyId: string, privateKey: Uint8Array | string]> = []) {
    for (const [id, k] of entries) this.add(id, k);
  }

  add(keyId: string, privateKey: Uint8Array | string): this {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) throw new SignerError('invalid_request', `invalid key id "${keyId}"`);
    const priv = typeof privateKey === 'string' ? hex.decode(privateKey.trim().toLowerCase()) : privateKey;
    assert32(priv, `private key for "${keyId}"`);
    schnorr.getPublicKey(priv); // throws on an out-of-range scalar
    this.keys.set(keyId, priv);
    return this;
  }

  private key(keyId: string): Uint8Array {
    const k = this.keys.get(keyId);
    if (!k) throw new KeyNotFoundError(keyId);
    return k;
  }

  async keyIds(): Promise<string[]> {
    return [...this.keys.keys()];
  }

  async publicKey(keyId: string): Promise<Uint8Array> {
    return schnorr.getPublicKey(this.key(keyId));
  }

  async sign(keyId: string, msg32: Uint8Array, opts: SignOptions = {}): Promise<Uint8Array> {
    assert32(msg32, 'message');
    const priv = this.key(keyId);
    const signingKey = opts.tweak === 'bip341' ? taprootTweakPrivKey(priv, opts.merkleRoot ?? new Uint8Array()) : priv;
    return schnorr.sign(msg32, signingKey);
  }
}

export interface KeyFileEntry {
  id: string;
  privateKeyHex: string;
}

/**
 * DEVELOPMENT ONLY. Keys from a JSON file `{ "keys": [{ "id": "...", "privateKeyHex": "..." }] }`. The
 * file must be mode 0600 (or stricter) and owned by the current user; anything group/world readable is
 * refused at startup so a misconfigured deploy fails loudly instead of running on a readable key.
 */
export class FileKeyProvider extends InMemoryKeyProvider {
  static fromFile(path: string, opts: { allowInsecureMode?: boolean } = {}): FileKeyProvider {
    const st = statSync(path);
    if (!opts.allowInsecureMode && process.platform !== 'win32') {
      if ((st.mode & 0o077) !== 0)
        throw new SignerError('key_provider_error', `key file ${path} is mode ${(st.mode & 0o777).toString(8)}; it must be 0600`);
      if (typeof process.getuid === 'function' && st.uid !== process.getuid())
        throw new SignerError('key_provider_error', `key file ${path} is not owned by the current user`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new SignerError('key_provider_error', `key file ${path} is not valid JSON`, { cause: e });
    }
    const list = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { keys?: unknown }).keys)
      ? ((parsed as { keys: unknown[] }).keys as KeyFileEntry[])
      : undefined;
    if (!list) throw new SignerError('key_provider_error', `key file ${path}: expected { "keys": [...] }`);
    const p = new FileKeyProvider();
    for (const e of list) {
      if (typeof e?.id !== 'string' || typeof e?.privateKeyHex !== 'string')
        throw new SignerError('key_provider_error', `key file ${path}: every entry needs id and privateKeyHex`);
      p.add(e.id, e.privateKeyHex);
    }
    return p;
  }
}

/**
 * Keys from environment variables `<prefix><KEY_ID>=<hex>` where KEY_ID is the key id upper-cased with
 * `-` and `.` replaced by `_` (`signer.blockspace-certify` → `SIGNER_KEY_SIGNER_BLOCKSPACE_CERTIFY`).
 * Only variables matching the prefix are read, and the process should scrub them after startup.
 */
export class EnvKeyProvider extends InMemoryKeyProvider {
  static envName(prefix: string, keyId: string): string {
    return `${prefix}${keyId.toUpperCase().replace(/[-.]/g, '_')}`;
  }

  static fromEnv(env: NodeJS.ProcessEnv, keyIds: readonly string[], prefix = 'SIGNER_KEY_'): EnvKeyProvider {
    const p = new EnvKeyProvider();
    for (const id of keyIds) {
      const name = EnvKeyProvider.envName(prefix, id);
      const v = env[name];
      if (!v) throw new SignerError('key_provider_error', `missing environment variable ${name} for key "${id}"`);
      p.add(id, v);
    }
    return p;
  }
}
