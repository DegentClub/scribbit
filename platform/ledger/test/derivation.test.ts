import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { describe, expect, it } from 'vitest';
import { deriveAddress, parseAccountXpub } from '../src/index.js';

/** BIP39 seed (the test vectors' mnemonic, empty passphrase). */
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = pbkdf2(sha512, MNEMONIC.normalize('NFKD'), 'mnemonic'.normalize('NFKD'), { c: 2048, dkLen: 64 });
const root = HDKey.fromMasterSeed(seed);

const ZPUB_VERSIONS = { public: 0x04b24746, private: 0x04b2430c };

describe('BIP84 (p2wpkh) test vectors', () => {
  // https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki#test-vectors
  const ACCOUNT_ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  const account = HDKey.fromMasterSeed(seed, ZPUB_VERSIONS).derive("m/84'/0'/0'");

  it('derives the account zpub from the mnemonic seed', () => {
    expect(account.publicExtendedKey).toBe(ACCOUNT_ZPUB);
  });

  it('derives the vectors\' addresses from the account zpub', () => {
    const acct = parseAccountXpub(ACCOUNT_ZPUB, 'mainnet');
    expect(deriveAddress(acct, 'p2wpkh', 'mainnet', 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'); // m/84'/0'/0'/0/0
    expect(deriveAddress(acct, 'p2wpkh', 'mainnet', 1)).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'); // m/84'/0'/0'/0/1
    expect(deriveAddress(acct, 'p2wpkh', 'mainnet', 0, 1)).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'); // m/84'/0'/0'/1/0
  });
});

describe('BIP86 (p2tr) test vectors', () => {
  // https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki#test-vectors
  const ACCOUNT_XPUB = 'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';

  it('derives the account xpub from the mnemonic seed', () => {
    expect(root.derive("m/86'/0'/0'").publicExtendedKey).toBe(ACCOUNT_XPUB);
  });

  it('derives the vectors\' addresses from the account xpub', () => {
    const acct = parseAccountXpub(ACCOUNT_XPUB, 'mainnet');
    expect(deriveAddress(acct, 'p2tr', 'mainnet', 0)).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'); // m/86'/0'/0'/0/0
    expect(deriveAddress(acct, 'p2tr', 'mainnet', 1)).toBe('bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'); // m/86'/0'/0'/0/1
    expect(deriveAddress(acct, 'p2tr', 'mainnet', 0, 1)).toBe('bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7'); // m/86'/0'/0'/1/0
  });
});

describe('library consistency (no published vectors)', () => {
  it('signet/testnet keys (vpub/tpub) produce tb1 addresses and match direct library derivation', () => {
    const acct = root.derive("m/84'/1'/0'");
    const vpub = HDKey.fromExtendedKey(acct.publicExtendedKey, HDKey.fromMasterSeed(seed).versions).publicExtendedKey; // xpub-versioned
    const tpub = HDKey.fromMasterSeed(seed, { public: 0x043587cf, private: 0x04358394 }).derive("m/84'/1'/0'").publicExtendedKey;
    expect(tpub.startsWith('tpub')).toBe(true);
    const parsed = parseAccountXpub(tpub, 'signet');
    for (let i = 0; i < 5; i++) {
      const a = deriveAddress(parsed, 'p2wpkh', 'signet', i);
      expect(a.startsWith('tb1q')).toBe(true);
      expect(deriveAddress(HDKey.fromExtendedKey(tpub, { public: 0x043587cf, private: 0x04358394 }), 'p2wpkh', 'testnet', i)).toBe(a);
    }
    expect(deriveAddress(parsed, 'p2tr', 'signet', 0).startsWith('tb1p')).toBe(true);
    expect(deriveAddress(parsed, 'p2wpkh', 'regtest', 0).startsWith('bcrt1q')).toBe(true);
    expect(vpub.startsWith('xpub')).toBe(true);
  });

  it('addresses are unique across indexes', () => {
    const acct = parseAccountXpub(root.derive("m/84'/0'/0'").publicExtendedKey, 'mainnet');
    const set = new Set(Array.from({ length: 50 }, (_, i) => deriveAddress(acct, 'p2wpkh', 'mainnet', i)));
    expect(set.size).toBe(50);
  });
});

describe('parseAccountXpub guards', () => {
  it('refuses private keys, wrong networks, wrong depth and unknown prefixes', () => {
    const acct = root.derive("m/84'/0'/0'");
    expect(() => parseAccountXpub(acct.privateExtendedKey, 'mainnet')).toThrow(/PRIVATE key refused/);
    expect(() => parseAccountXpub(acct.publicExtendedKey, 'signet')).toThrow(/does not belong to signet/);
    expect(() => parseAccountXpub(root.derive("m/84'/0'").publicExtendedKey, 'mainnet')).toThrow(/depth/);
    expect(() => parseAccountXpub('ypub6Y' + 'x'.repeat(100), 'mainnet')).toThrow(/unsupported/);
    expect(() => deriveAddress(parseAccountXpub(acct.publicExtendedKey, 'mainnet'), 'p2wpkh', 'mainnet', -1)).toThrow(/index/);
    expect(() => deriveAddress(parseAccountXpub(acct.publicExtendedKey, 'mainnet'), 'p2wpkh', 'mainnet', 0x80000000)).toThrow(/index/);
  });
});
