/**
 * Persistence for a {@link PendingMint} behind a tiny key/value port, so the
 * same code serves `localStorage`, a Node `Map`, or a server store.
 *
 * Ported from counters.fun `apps/web/src/lib/pending-mint.ts`.
 */

import { type PendingMint } from './plan.js';

/** The subset of the Web Storage API this needs. `localStorage` satisfies it. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PENDING_MINT_KEY = 'scribbit:counters:pending-mint';

export function loadPendingMint(store: KV, key = PENDING_MINT_KEY): PendingMint | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingMint>;
    if (typeof parsed.revealPsbt !== 'string' || typeof parsed.commitTxid !== 'string' || typeof parsed.revealKey !== 'string') return null;
    return parsed as PendingMint;
  } catch {
    return null;
  }
}

export function savePendingMint(store: KV, m: PendingMint, key = PENDING_MINT_KEY): void {
  try {
    store.setItem(key, JSON.stringify(m));
  } catch {
    // Private mode or storage full: the in-memory copy still exists.
  }
}

export function clearPendingMint(store: KV, key = PENDING_MINT_KEY): void {
  try {
    store.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/** A `KV` over a `Map`, for servers and tests. */
export function memoryKV(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
