/**
 * Signing/broadcast shared by the UniSat-API wallets (UniSat, OKX). Both take
 * PSBTs as **hex** with `{ autoFinalized, toSignInputs }`, sign messages with
 * `signMessage(msg, 'bip322-simple' | 'ecdsa')`, and expose a single address
 * that serves as both the ordinals and the payment account.
 */
import { CAPABILITIES } from '../capabilities.js';
import { WalletError } from '../errors.js';
import { assertOwnAddress, guard, quietly, validateInputsToSign, withTaprootOutputKey } from '../internal.js';
import { psbtBase64ToHex, psbtHexToBase64 } from '../psbt.js';
import type { ConnectedWallet, MessageSignatureType, Network, SignPsbtOptions, WalletAccount, WalletId } from '../types.js';

export interface UnisatToSignInput {
  index: number;
  address?: string;
  publicKey?: string;
  sighashTypes?: number[];
  disableTweakSigner?: boolean;
}

export interface UnisatFamilyProvider {
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: UnisatToSignInput[] }): Promise<string>;
  signMessage(message: string, type?: MessageSignatureType): Promise<string>;
  pushTx?(arg: unknown): Promise<string>;
  pushPsbt?(psbtHex: string): Promise<string>;
  disconnect?(): Promise<void>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface UnisatFamilyConfig {
  id: WalletId;
  network: Network;
  account: WalletAccount;
  /** Resolved at call time so a provider swapped by the extension is honoured. */
  provider: () => UnisatFamilyProvider;
  /** UniSat takes `pushTx({ rawtx })`; OKX takes `pushTx(rawtx)`. */
  pushTxArg: (hex: string) => unknown;
  /** Events that mean "the account under us changed". */
  changeEvents: string[];
}

export function unisatFamilyWallet(cfg: UnisatFamilyConfig): ConnectedWallet {
  const { id, network, account } = cfg;
  const ordinals: WalletAccount = { ...account, purpose: 'ordinals' };
  const payment: WalletAccount = { ...account, purpose: 'payment' };
  const owned = [account];

  const wallet: ConnectedWallet = {
    id,
    network,
    ordinals,
    payment,
    capabilities: CAPABILITIES[id],
    ...withTaprootOutputKey(ordinals),

    async signPsbt(psbtBase64: string, opts: SignPsbtOptions) {
      validateInputsToSign(id, opts, owned);
      const psbtHex = psbtBase64ToHex(psbtBase64);
      const broadcast = opts.broadcast === true;
      const finalize = broadcast || opts.finalize === true;
      const toSignInputs: UnisatToSignInput[] = opts.inputsToSign.map((i) => ({
        index: i.index,
        address: i.address,
        ...(i.sighashTypes ? { sighashTypes: [...i.sighashTypes] } : {}),
        ...(i.disableTweak !== undefined ? { disableTweakSigner: i.disableTweak } : {}),
      }));
      const p = cfg.provider();
      const signedHex = await guard(id, () => p.signPsbt(psbtHex, { autoFinalized: finalize, toSignInputs }));
      if (typeof signedHex !== 'string' || !signedHex) {
        throw new WalletError('WALLET_ERROR', `${id} returned no signed PSBT.`, { walletId: id });
      }
      const out = psbtHexToBase64(signedHex);
      if (!broadcast) return { psbtBase64: out };
      if (typeof p.pushPsbt !== 'function') {
        throw new WalletError('UNSUPPORTED_METHOD', `${id} cannot broadcast a PSBT (no pushPsbt).`, { walletId: id });
      }
      const txid = await guard(id, () => p.pushPsbt!(signedHex));
      return { psbtBase64: out, txid };
    },

    async signMessage(message: string, address: string, type: MessageSignatureType = 'bip322-simple') {
      assertOwnAddress(id, address, owned);
      return guard(id, () => cfg.provider().signMessage(message, type));
    },

    async pushTx(rawHex: string) {
      const p = cfg.provider();
      if (typeof p.pushTx !== 'function') {
        throw new WalletError('UNSUPPORTED_METHOD', `${id} cannot broadcast raw transactions.`, { walletId: id });
      }
      return guard(id, () => p.pushTx!(cfg.pushTxArg(rawHex)));
    },

    async disconnect() {
      const p = cfg.provider();
      if (typeof p.disconnect === 'function') await quietly(() => p.disconnect!());
    },

    onAccountsChanged(cb: () => void) {
      const p = cfg.provider();
      if (typeof p.on !== 'function') return () => {};
      const handler = () => cb();
      for (const ev of cfg.changeEvents) p.on(ev, handler);
      return () => {
        if (typeof p.removeListener === 'function') for (const ev of cfg.changeEvents) p.removeListener(ev, handler);
      };
    },
  };
  return wallet;
}
