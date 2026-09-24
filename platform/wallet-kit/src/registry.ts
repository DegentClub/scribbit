import { horizonAdapter } from './adapters/horizon.js';
import { leatherAdapter } from './adapters/leather.js';
import { magicEdenAdapter } from './adapters/magiceden.js';
import { okxAdapter } from './adapters/okx.js';
import { unisatAdapter } from './adapters/unisat.js';
import { xcpAdapter } from './adapters/xcp.js';
import { xverseAdapter } from './adapters/xverse.js';
import { WalletError } from './errors.js';
import type { WalletAdapter, WalletId } from './types.js';

/** Every built-in adapter, in display order. */
export const ADAPTERS: readonly WalletAdapter[] = Object.freeze([
  unisatAdapter,
  xverseAdapter,
  leatherAdapter,
  okxAdapter,
  magicEdenAdapter,
  xcpAdapter,
  horizonAdapter,
]);

export const WALLET_IDS: readonly WalletId[] = Object.freeze(ADAPTERS.map((a) => a.id));

export function getAdapter(id: WalletId): WalletAdapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new WalletError('UNKNOWN_WALLET', `Unknown wallet id "${String(id)}". Known: ${WALLET_IDS.join(', ')}.`);
  return a;
}

/** Adapters whose extension is injected in this page right now. */
export function detectWallets(adapters: readonly WalletAdapter[] = ADAPTERS): WalletAdapter[] {
  return adapters.filter((a) => {
    try {
      return a.isInstalled();
    } catch {
      return false;
    }
  });
}
