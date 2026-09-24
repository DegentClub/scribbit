/**
 * Pending mints, kept across reloads. A commit on chain whose reveal is not is money parked at an address
 * only the wallet's key can open; everything needed to finish (or rescue) is small, contains no key, and is
 * safe to store. One pending mint per page at a time (v1: batches are sequential).
 */
import type { Network } from '@bsh/inscription';
import type { FairminterParams, MintKind, WalletId } from '../services/types';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const ORDINALS_KEY = 'scribb.it/pending-ordinals/v1';
export const COUNTERS_KEY = 'scribb.it/pending-counters/v1';

export interface PendingOrdinals {
  kind: 'ordinals';
  network: Network;
  walletId: WalletId;
  ordinalsAddress: string;
  contentType: string;
  /** base64 of the exact bytes, so the reveal can be rebuilt byte-for-byte. */
  bodyBase64: string;
  sha256: string;
  parentId?: string;
  metadataBase64?: string;
  leafPubkeyHex: string;
  leafKeyKind: 'output' | 'internal';
  commitAddress: string;
  commitTxid: string;
  commitVout: number;
  commitValue: string;
  postage: string;
  feeRate: number;
  fileName: string;
  savedAt: number;
}

export interface PendingCounters {
  kind: 'counters';
  network: Network;
  walletId: WalletId;
  source: string;
  asset: string;
  mintKind: MintKind;
  preset?: 'xcp69' | 'custom';
  fairminter?: FairminterParams;
  revealPsbtBase64: string;
  commitTxid: string;
  commitValue: number;
  revealWeight: number;
  leafHex: string;
  commitAddress: string;
  route: 'public' | 'slipstream';
  savedAt: number;
}

export function browserStore(): KeyValueStore | null {
  try {
    const s = window.localStorage;
    s.getItem('probe');
    return s;
  } catch {
    return null;
  }
}

function load<T>(store: KeyValueStore | null, key: string): T | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw, (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as T;
  } catch {
    return null;
  }
}

function save(store: KeyValueStore | null, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  } catch {
    // private mode / quota: the in-memory copy still exists
  }
}

export const loadPendingOrdinals = (s: KeyValueStore | null) => load<PendingOrdinals>(s, ORDINALS_KEY);
export const savePendingOrdinals = (s: KeyValueStore | null, p: PendingOrdinals) => save(s, ORDINALS_KEY, p);
export const clearPendingOrdinals = (s: KeyValueStore | null) => s?.removeItem(ORDINALS_KEY);
export const loadPendingCounters = (s: KeyValueStore | null) => load<PendingCounters>(s, COUNTERS_KEY);
export const savePendingCounters = (s: KeyValueStore | null, p: PendingCounters) => save(s, COUNTERS_KEY, p);
export const clearPendingCounters = (s: KeyValueStore | null) => s?.removeItem(COUNTERS_KEY);

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
