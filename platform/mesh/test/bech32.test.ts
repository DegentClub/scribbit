import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { convertBits, decodeBech32, decodeSegwitAddress, encodeBech32, encodeSegwitAddress } from '../src/bech32.ts';

// BIP 350 test vectors.
const VALID: [string, string][] = [
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', '5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['BC1SW50QGDZ25J', '6002751e'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', '5210751e76e8199196d454941c45d1b3a323'],
  ['tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy', '0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
];
const INVALID = [
  'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf', // bech32 instead of bech32m
  'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL', // bech32m for v0
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', // invalid checksum
  'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', // invalid character in checksum
  'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', // invalid witness version
  'bc1pw5dgrnzv', // invalid program length (1 byte)
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', // invalid program length (41 bytes)
  'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', // invalid program length for v0
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', // mixed case
  'bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', // zero padding of more than 4 bits
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', // non-zero padding
  'bc1gmk9yu', // empty data
];
const hrpOf = (addr: string): string => addr.toLowerCase().slice(0, addr.toLowerCase().lastIndexOf('1'));
const scriptPubKey = (version: number, program: Uint8Array): string =>
  Buffer.concat([Buffer.from([version === 0 ? 0 : 0x50 + version, program.length]), Buffer.from(program)]).toString('hex');

describe('segwit addresses (BIP 173 / BIP 350)', () => {
  it('decodes every valid vector to its scriptPubKey', () => {
    for (const [addr, spk] of VALID) {
      const dec = decodeSegwitAddress(hrpOf(addr), addr);
      expect(dec, addr).not.toBeNull();
      expect(scriptPubKey(dec!.version, dec!.program), addr).toBe(spk);
      expect(dec!.encoding).toBe(dec!.version === 0 ? 'bech32' : 'bech32m');
    }
  });
  it('rejects every invalid vector', () => {
    for (const addr of INVALID) {
      const hrp = addr.toLowerCase().startsWith('tb') ? 'tb' : 'bc';
      expect(decodeSegwitAddress(hrp, addr), addr).toBeNull();
    }
  });
  it('rejects the wrong network, junk and over-long input', () => {
    expect(decodeSegwitAddress('tb', VALID[0]![0])).toBeNull();
    expect(decodeSegwitAddress('bc', '')).toBeNull();
    expect(decodeSegwitAddress('bc', '1'.repeat(91))).toBeNull();
    expect(decodeSegwitAddress('bc', 'bc1' + 'éqqq')).toBeNull();
    expect(decodeBech32('a1lqfn3a')).toMatchObject({ hrp: 'a', encoding: 'bech32m', data: [] });
    expect(decodeBech32('A12UEL5L')).toMatchObject({ hrp: 'a', encoding: 'bech32', data: [] });
  });
  it('round-trips random programs for every witness version on both networks', () => {
    for (let i = 0; i < 60; i++) {
      const hrp = i % 2 ? 'bc' : 'tb';
      const version = i % 17;
      const len = version === 0 ? (i % 4 ? 20 : 32) : 2 + (i % 39);
      const program = new Uint8Array(randomBytes(len));
      const addr = encodeSegwitAddress(hrp, version, program);
      const dec = decodeSegwitAddress(hrp, addr)!;
      expect(dec.version).toBe(version);
      expect(Buffer.from(dec.program).equals(program)).toBe(true);
      const chars = addr.split('');
      chars[addr.length - 1] = chars[addr.length - 1] === 'q' ? 'p' : 'q';
      expect(decodeSegwitAddress(hrp, chars.join(''))).toBeNull();
    }
    expect(() => encodeSegwitAddress('bc', 0, new Uint8Array(21))).toThrow();
    expect(() => encodeSegwitAddress('bc', 17, new Uint8Array(20))).toThrow(RangeError);
  });
  it('convertBits regroups 8↔5 and refuses dirty padding', () => {
    expect(convertBits([0xff], 8, 5, true)).toEqual([31, 28]);
    expect(convertBits([31, 28], 5, 8, false)).toEqual([0xff]);
    expect(convertBits([31, 31], 5, 8, false)).toBeNull();
    expect(convertBits([32], 5, 8, false)).toBeNull();
    const encoded = encodeBech32('bc', [0], 'bech32');
    expect(encoded.startsWith('bc1q')).toBe(true);
    expect(decodeBech32(encoded)).toEqual({ hrp: 'bc', data: [0], encoding: 'bech32' });
    expect(decodeBech32(encodeBech32('bc', [0], 'bech32m'))).toMatchObject({ encoding: 'bech32m' });
  });
});
