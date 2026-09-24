import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { expectedHashes, isSolutionShape, leadingZeroBits, POW_PREFIX, powDigest, PowNotFoundError, solvePow, solvePowSlice, verifyPow } from '../src/index.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ADDR = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';

describe('leadingZeroBits', () => {
  it.each([
    [[0xff], 0],
    [[0x80], 0],
    [[0x7f], 1],
    [[0x01], 7],
    [[0x00, 0x80], 8],
    [[0x00, 0x00, 0x0f], 20],
    [[0x00, 0x00], 16],
    [[], 0],
  ])('%j → %i', (bytes, n) => expect(leadingZeroBits(Uint8Array.from(bytes))).toBe(n));

  it('agrees with a bit-string reference on random digests (property)', () => {
    for (let i = 0; i < 500; i++) {
      const d = sha256(new TextEncoder().encode(`p${i}`));
      const bits = Array.from(d, (b) => b.toString(2).padStart(8, '0')).join('');
      expect(leadingZeroBits(d)).toBe(bits.length - bits.replace(/^0+/, '').length);
    }
  });
});

describe('the digest', () => {
  it('is SHA-256 of the documented message (vector)', () => {
    const msg = `${POW_PREFIX}00ff:${ADDR}:42`;
    expect(hex(powDigest('00ff', ADDR, '42'))).toBe(hex(sha256(new TextEncoder().encode(msg))));
  });
});

describe('solve + verify', () => {
  it('finds a solution that verifies, for several difficulties (property)', () => {
    for (const difficulty of [1, 4, 8, 12]) {
      const nonce = `n${difficulty}`;
      const { solution, hashes } = solvePow(nonce, ADDR, difficulty);
      expect(hashes).toBeGreaterThan(0);
      expect(verifyPow({ nonce, address: ADDR, solution, difficulty })).toBe(true);
      expect(leadingZeroBits(powDigest(nonce, ADDR, solution))).toBeGreaterThanOrEqual(difficulty);
    }
  });

  it('a solution is bound to its address and its nonce', () => {
    const { solution } = solvePow('abc', ADDR, 12);
    expect(verifyPow({ nonce: 'abc', address: ADDR, solution, difficulty: 12 })).toBe(true);
    const other = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    // Not impossible by chance (2^-12), so assert on the digest instead of the boolean for the other address.
    expect(hex(powDigest('abc', other, solution))).not.toBe(hex(powDigest('abc', ADDR, solution)));
    expect(hex(powDigest('abd', ADDR, solution))).not.toBe(hex(powDigest('abc', ADDR, solution)));
  });

  it('rejects malformed solutions and difficulties without hashing', () => {
    for (const s of ['', '01', '-1', '1.5', 'abc', '9'.repeat(21), ' 1']) expect(isSolutionShape(s)).toBe(false);
    expect(verifyPow({ nonce: 'x', address: ADDR, solution: '01', difficulty: 1 })).toBe(false);
    expect(verifyPow({ nonce: 'x', address: ADDR, solution: '1', difficulty: 0 })).toBe(false);
    expect(verifyPow({ nonce: 'x', address: ADDR, solution: '1', difficulty: 33 })).toBe(false);
  });

  it('reports progress and gives up with PowNotFoundError', () => {
    const seen: number[] = [];
    expect(() => solvePow('x', ADDR, 30, { maxHashes: 300, progressEvery: 100, onProgress: (p) => seen.push(p.hashes) })).toThrow(PowNotFoundError);
    expect(seen).toEqual([100, 200, 300]);
    expect(() => solvePow('x', ADDR, 0)).toThrow(RangeError);
  });

  it('solvePowSlice finds the same first solution as solvePow', () => {
    const { solution } = solvePow('slice', ADDR, 10);
    let found: string | null = null;
    for (let from = 0; found === null; from += 97) found = solvePowSlice('slice', ADDR, 10, from, 97);
    expect(found).toBe(solution);
    expect(expectedHashes(20)).toBe(1_048_576);
  });
});
