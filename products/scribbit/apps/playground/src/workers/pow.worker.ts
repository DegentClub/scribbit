/// <reference lib="webworker" />
/** Proof-of-work search off the main thread: the page stays responsive while the CPU works. */
import { PowNotFoundError, solvePow } from '@bsh/scribbit-playground-kit';

export interface PowRequest {
  nonce: string;
  address: string;
  difficulty: number;
}

export type PowMessage = { type: 'progress'; hashes: number; fraction: number } | { type: 'done'; solution: string; hashes: number } | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<PowRequest>) => {
  const { nonce, address, difficulty } = e.data;
  try {
    const r = solvePow(nonce, address, difficulty, { progressEvery: 8192, onProgress: (p) => ctx.postMessage({ type: 'progress', ...p } satisfies PowMessage) });
    ctx.postMessage({ type: 'done', ...r } satisfies PowMessage);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof PowNotFoundError ? err.message : String((err as Error)?.message ?? err) } satisfies PowMessage);
  }
};
