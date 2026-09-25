/**
 * Solve the faucet's proof of work without freezing the page: in a Web Worker when the browser has them, else in
 * small slices between timer ticks (jsdom, very old browsers). Same rule either way (@bsh/scribbit-playground-kit).
 */
import { expectedHashes, isValidDifficulty, MAX_DIFFICULTY, solvePowSlice } from '@bsh/scribbit-playground-kit';
import type { PowMessage } from '../workers/pow.worker';

export interface PowProgress {
  hashes: number;
  /** A guide, not a promise: the search is memoryless. */
  fraction: number;
}

export type PowSolver = (args: { nonce: string; address: string; difficulty: number; onProgress?: (p: PowProgress) => void; signal?: AbortSignal }) => Promise<{ solution: string; hashes: number; via: 'worker' | 'main' }>;

/** The client refuses to burn a learner's CPU on an absurd difficulty (a misconfigured or hostile faucet). */
export const CLIENT_MAX_DIFFICULTY = 26;

function checkDifficulty(d: number): void {
  if (!isValidDifficulty(d) || d > Math.min(CLIENT_MAX_DIFFICULTY, MAX_DIFFICULTY)) throw new Error(`The faucet asked for ${d} bits of proof of work; this page stops at ${CLIENT_MAX_DIFFICULTY}.`);
}

export const solveOnMainThread: PowSolver = ({ nonce, address, difficulty, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    try {
      checkDifficulty(difficulty);
    } catch (e) {
      reject(e);
      return;
    }
    const expected = expectedHashes(difficulty);
    const slice = 2048;
    let from = 0;
    const tick = () => {
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const s = solvePowSlice(nonce, address, difficulty, from, slice);
      if (s !== null) return resolve({ solution: s, hashes: Number(s) + 1, via: 'main' });
      from += slice;
      onProgress?.({ hashes: from, fraction: Math.min(0.99, from / expected) });
      setTimeout(tick, 0);
    };
    tick();
  });

export function createWorkerSolver(makeWorker: () => Worker): PowSolver {
  return ({ nonce, address, difficulty, onProgress, signal }) =>
    new Promise((resolve, reject) => {
      try {
        checkDifficulty(difficulty);
      } catch (e) {
        reject(e);
        return;
      }
      const w = makeWorker();
      const stop = () => w.terminate();
      signal?.addEventListener('abort', () => (stop(), reject(new DOMException('aborted', 'AbortError'))), { once: true });
      w.onmessage = (e: MessageEvent<PowMessage>) => {
        const m = e.data;
        if (m.type === 'progress') onProgress?.({ hashes: m.hashes, fraction: m.fraction });
        else if (m.type === 'done') (stop(), resolve({ solution: m.solution, hashes: m.hashes, via: 'worker' }));
        else (stop(), reject(new Error(m.message)));
      };
      w.onerror = (e) => (stop(), reject(new Error(e.message || 'proof-of-work worker failed')));
      w.postMessage({ nonce, address, difficulty });
    });
}

export function defaultSolver(): PowSolver {
  if (typeof Worker === 'undefined') return solveOnMainThread;
  return createWorkerSolver(() => new Worker(new URL('../workers/pow.worker.ts', import.meta.url), { type: 'module' }));
}
