/**
 * Real WalletService over @bsh/wallet-kit: all seven adapters (UniSat, Xverse, Leather, OKX, Magic Eden,
 * XCP Wallet, Horizon). Capabilities and the taproot output key come from the connected wallet; the list
 * shows the kit's `CAPABILITIES` table before connecting.
 */
import { ADAPTERS, CAPABILITIES, createWalletKit, type ConnectedWallet, type WalletKit } from '@bsh/wallet-kit';
import type { Network } from '@bsh/inscription';
import type { SignPsbtRequest, WalletId, WalletOption, WalletService, WalletSession } from '../types';
import { isUnverified } from '../../lib/walletRouting';

function toSession(w: ConnectedWallet, name: string): WalletSession {
  const session: WalletSession = {
    id: w.id,
    name,
    network: w.network,
    ordinals: { address: w.ordinals.address, publicKey: w.ordinals.publicKey, addressType: w.ordinals.addressType },
    payment: { address: w.payment.address, publicKey: w.payment.publicKey, addressType: w.payment.addressType },
    capabilities: { ...w.capabilities },
    ...(w.taprootOutputKey ? { taprootOutputKey: w.taprootOutputKey } : {}),
    signPsbt: (psbt, req: SignPsbtRequest) =>
      w.signPsbt(psbt, {
        inputsToSign: req.inputsToSign.map((i) => ({ index: i.index, address: i.address, ...(i.disableTweak ? { disableTweak: true } : {}) })),
        ...(req.inscription ? { inscription: req.inscription } : {}),
        ...(req.finalize !== undefined ? { finalize: req.finalize } : {}),
        ...(req.broadcast !== undefined ? { broadcast: req.broadcast } : {}),
      }),
    disconnect: () => w.disconnect(),
  };
  if (w.pushTx) session.pushTx = (h) => w.pushTx!(h);
  return session;
}

export function createRealWallets(): WalletService {
  const kits = new Map<Network, WalletKit>();
  const kitFor = (network: Network) => {
    let k = kits.get(network);
    if (!k) {
      k = createWalletKit({ network });
      kits.set(network, k);
    }
    return k;
  };
  return {
    list(): WalletOption[] {
      return ADAPTERS.map((a) => {
        let installed = false;
        try {
          installed = a.isInstalled();
        } catch {
          installed = false;
        }
        const capabilities = { ...CAPABILITIES[a.id] };
        return { id: a.id as WalletId, name: a.name, installed, installUrl: a.installUrl, capabilities, unverified: isUnverified(a.id, capabilities) };
      });
    },
    async connect(id, network) {
      const adapter = ADAPTERS.find((a) => a.id === id);
      const w = await kitFor(network).connect(id);
      return toSession(w, adapter?.name ?? id);
    },
  };
}
