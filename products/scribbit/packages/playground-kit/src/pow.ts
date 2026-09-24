/**
 * The faucet's proof-of-work rule (ADR-0009: proof of work instead of a third-party captcha).
 *
 *   digest   = SHA-256( UTF-8( "scribbit-faucet-pow/v1:" + nonce + ":" + address + ":" + solution ) )
 *   accepted when digest has at least `difficulty` leading zero BITS
 *
 * `nonce` is the server's single-use challenge (hex), `address` binds the work to the address being funded (a
 * solution found for one address is worthless for another), `solution` is a decimal counter string the client
 * searches. Expected work is 2^difficulty hashes; there is no shortcut, so the cost to the client is honest CPU
 * time and the cost to the server is one hash.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const POW_ALGORITHM = 'sha256-leading-zero-bits/v1' as const;
export const POW_PREFIX = 'scribbit-faucet-pow/v1:';
/** Hard bounds the server enforces on its own configuration and the client on what it will try to solve. */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 32;
/** Solutions are decimal counters; anything longer than this cannot be a counter we would search. */
export const MAX_SOLUTION_LENGTH = 20;

const enc = new TextEncoder();

export function powMessage(nonce: string, address: string, solution: string): Uint8Array {
  return enc.encode(`${POW_PREFIX}${nonce}:${address}:${solution}`);
}

export function powDigest(nonce: string, address: string, solution: string): Uint8Array {
  return sha256(powMessage(nonce, address, solution));
}

/** Number of leading zero bits of a byte string (0..8·len). */
export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export function isValidDifficulty(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= MIN_DIFFICULTY && d <= MAX_DIFFICULTY;
}

export function isSolutionShape(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_SOLUTION_LENGTH && /^(0|[1-9]\d*)$/.test(s);
}

/** Does `solution` satisfy the challenge for this address? Pure and constant-cost (one hash). */
export function verifyPow(args: { nonce: string; address: string; solution: string; difficulty: number }): boolean {
  if (!isSolutionShape(args.solution) || !isValidDifficulty(args.difficulty)) return false;
  return leadingZeroBits(powDigest(args.nonce, args.address, args.solution)) >= args.difficulty;
}

/** Expected number of hashes to find a solution (2^difficulty). */
export function expectedHashes(difficulty: number): number {
  return 2 ** difficulty;
}

export interface SolveProgress {
  /** Hashes tried so far. */
  hashes: number;
  /** hashes / expectedHashes(difficulty), capped at 0.99 until solved (the search is memoryless, so this is a guide only). */
  fraction: number;
}

export interface SolveOptions {
  /** First counter value (default 0). */
  start?: number;
  /** Give up after this many hashes (default 2^(difficulty+6): a solution exists with overwhelming probability before). */
  maxHashes?: number;
  /** Called every `progressEvery` hashes (default 4096). */
  onProgress?: (p: SolveProgress) => void;
  progressEvery?: number;
}

export class PowNotFoundError extends Error {
  constructor(readonly hashes: number) {
    super(`no proof-of-work solution found in ${hashes} hashes`);
    this.name = 'PowNotFoundError';
  }
}

/** Synchronous search (use it inside a Web Worker, or in slices via `solvePowSlice`). */
export function solvePow(nonce: string, address: string, difficulty: number, opts: SolveOptions = {}): { solution: string; hashes: number } {
  if (!isValidDifficulty(difficulty)) throw new RangeError(`difficulty must be an integer ${MIN_DIFFICULTY}..${MAX_DIFFICULTY}`);
  const start = opts.start ?? 0;
  const max = opts.maxHashes ?? 2 ** Math.min(difficulty + 6, 52);
  const every = opts.progressEvery ?? 4096;
  const expected = expectedHashes(difficulty);
  for (let i = 0; i < max; i++) {
    const solution = String(start + i);
    if (leadingZeroBits(powDigest(nonce, address, solution)) >= difficulty) return { solution, hashes: i + 1 };
    if (opts.onProgress && (i + 1) % every === 0) opts.onProgress({ hashes: i + 1, fraction: Math.min(0.99, (i + 1) / expected) });
  }
  throw new PowNotFoundError(max);
}

/**
 * Try `count` counters from `from`; returns the solution or null. Lets a caller without workers search in
 * slices between animation frames without blocking the page.
 */
export function solvePowSlice(nonce: string, address: string, difficulty: number, from: number, count: number): string | null {
  for (let i = from; i < from + count; i++) {
    const solution = String(i);
    if (leadingZeroBits(powDigest(nonce, address, solution)) >= difficulty) return solution;
  }
  return null;
}
