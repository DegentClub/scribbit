import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { EnvKeyProvider, FileKeyProvider, InMemoryKeyProvider, SignerError } from '../src/index.js';
import { PRIV_A, PRIV_B, XONLY_A, XONLY_B } from './helpers.js';

const keyFile = (mode: number, body: unknown = { keys: [{ id: 'a', privateKeyHex: hex.encode(PRIV_A) }, { id: 'b', privateKeyHex: hex.encode(PRIV_B) }] }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signer-keys-'));
  const file = path.join(dir, 'keys.json');
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  chmodSync(file, mode);
  return file;
};

describe('FileKeyProvider', () => {
  it('loads keys from a 0600 file', async () => {
    const p = FileKeyProvider.fromFile(keyFile(0o600));
    expect(await p.keyIds()).toEqual(['a', 'b']);
    expect(hex.encode(await p.publicKey('b'))).toBe(hex.encode(XONLY_B));
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o666])('refuses a file with mode %s', (mode) => {
    expect(() => FileKeyProvider.fromFile(keyFile(mode))).toThrow(/must be 0600/);
  });

  it('accepts 0400 and the explicit insecure override', () => {
    expect(FileKeyProvider.fromFile(keyFile(0o400))).toBeInstanceOf(FileKeyProvider);
    expect(FileKeyProvider.fromFile(keyFile(0o644), { allowInsecureMode: true })).toBeInstanceOf(FileKeyProvider);
  });

  it('rejects malformed files without leaking their contents', () => {
    expect(() => FileKeyProvider.fromFile(keyFile(0o600, 'not json'))).toThrow(/not valid JSON/);
    expect(() => FileKeyProvider.fromFile(keyFile(0o600, { nope: [] }))).toThrow(/expected \{ "keys"/);
    expect(() => FileKeyProvider.fromFile(keyFile(0o600, { keys: [{ id: 'a' }] }))).toThrow(/needs id and privateKeyHex/);
    expect(() => FileKeyProvider.fromFile(keyFile(0o600, { keys: [{ id: 'a', privateKeyHex: 'abcd' }] }))).toThrow(/32 bytes/);
    expect(() => FileKeyProvider.fromFile(keyFile(0o600, { keys: [{ id: 'bad id!', privateKeyHex: hex.encode(PRIV_A) }] }))).toThrow(/invalid key id/);
  });
});

describe('EnvKeyProvider', () => {
  it('maps key ids to SIGNER_KEY_* variables', async () => {
    expect(EnvKeyProvider.envName('SIGNER_KEY_', 'blockspace.certify-v1')).toBe('SIGNER_KEY_BLOCKSPACE_CERTIFY_V1');
    const p = EnvKeyProvider.fromEnv({ SIGNER_KEY_A: hex.encode(PRIV_A), SIGNER_KEY_B: hex.encode(PRIV_B), UNRELATED: 'x' }, ['a', 'b']);
    expect(await p.keyIds()).toEqual(['a', 'b']);
    expect(hex.encode(await p.publicKey('a'))).toBe(hex.encode(XONLY_A));
  });

  it('fails loudly on a missing variable', () => {
    expect(() => EnvKeyProvider.fromEnv({}, ['a'])).toThrow(/missing environment variable SIGNER_KEY_A/);
  });
});

describe('InMemoryKeyProvider signing', () => {
  it('signs 32-byte messages with BIP340 and applies the taproot tweak on request', async () => {
    const p = new InMemoryKeyProvider([['a', hex.encode(PRIV_A)]]);
    const msg = new Uint8Array(32).fill(7);
    const plain = await p.sign('a', msg);
    expect(schnorr.verify(plain, msg, XONLY_A)).toBe(true);
    const tweaked = await p.sign('a', msg, { tweak: 'bip341' });
    expect(schnorr.verify(tweaked, msg, XONLY_A)).toBe(false);
    const { p2tr } = await import('@scure/btc-signer');
    expect(schnorr.verify(tweaked, msg, p2tr(XONLY_A).tweakedPubkey)).toBe(true);
  });

  it('rejects unknown keys, bad message sizes and invalid scalars', async () => {
    const p = new InMemoryKeyProvider([['a', PRIV_A]]);
    await expect(p.sign('nope', new Uint8Array(32))).rejects.toMatchObject({ code: 'unknown_key' });
    await expect(p.sign('a', new Uint8Array(31))).rejects.toBeInstanceOf(SignerError);
    expect(() => p.add('zero', new Uint8Array(32))).toThrow();
  });
});
