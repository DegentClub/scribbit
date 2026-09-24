/**
 * Wallets that speak the sats-connect JSON-RPC dialect through an injected
 * `request(method, params)` provider: Xverse and Magic Eden.
 *
 * - PSBTs are **base64** in and out.
 * - `signInputs` maps address → input indexes.
 * - Accounts come back with a `purpose` of `ordinals` or `payment`.
 * - Providers *resolve* errors as `{ error: { code, message } }`; user
 *   rejection is `-32000` (RpcErrorCode.USER_REJECTION).
 *
 * Connect tries `wallet_connect` (sats-connect v2+), then `getAccounts`, then
 * `getAddresses` (the method the legacy Skrybit adapters used), moving on only
 * when a method is reported as not found.
 */
import { CAPABILITIES } from '../capabilities.js';
import { UnsupportedNetworkError, WalletError, WalletNotInstalledError } from '../errors.js';
import {
  type RpcProvider,
  account,
  assertAccountsOnNetwork,
  assertNetworkSupported,
  assertOwnAddress,
  guard,
  isMethodNotFound,
  isObject,
  quietly,
  rpcRequest,
  signInputsMap,
  validateInputsToSign,
  withTaprootOutputKey,
} from '../internal.js';
import { normalizePsbtBase64 } from '../psbt.js';
import type {
  ConnectedWallet,
  MessageSignatureType,
  Network,
  SignPsbtOptions,
  WalletAccount,
  WalletAdapter,
  WalletId,
} from '../types.js';

/** sats-connect BitcoinNetworkType. `testnet` is Testnet4 (the fleet's testnet). */
export const SATS_CONNECT_NETWORK: Record<Network, string> = {
  mainnet: 'Mainnet',
  testnet: 'Testnet4',
  signet: 'Signet',
  regtest: 'Regtest',
};

export interface SatsConnectAddress {
  address: string;
  publicKey: string;
  purpose: string;
  addressType?: string;
}

export interface SatsConnectProvider extends RpcProvider {
  addListener?(event: string, cb: (...args: unknown[]) => void): (() => void) | void;
}

export interface SatsConnectAdapterConfig {
  id: WalletId;
  name: string;
  installUrl: string;
  networks: readonly Network[];
  /** The injected provider, or undefined when not installed. */
  provider(): SatsConnectProvider | undefined;
  /** Message shown in the wallet's connect prompt. */
  connectMessage?: string;
}

function addressesFrom(result: unknown): SatsConnectAddress[] {
  const list = Array.isArray(result) ? result : isObject(result) && Array.isArray(result.addresses) ? result.addresses : [];
  return list.filter(
    (a): a is SatsConnectAddress => isObject(a) && typeof a.address === 'string' && typeof a.purpose === 'string',
  );
}

function reportedNetwork(result: unknown): string | undefined {
  // wallet_connect: { network: { bitcoin: { name: 'Mainnet' } } }
  if (!isObject(result) || !isObject(result.network)) return undefined;
  const btc = result.network.bitcoin;
  return isObject(btc) && typeof btc.name === 'string' ? btc.name : undefined;
}

async function requestAccounts(id: WalletId, p: SatsConnectProvider, network: Network, message: string) {
  const want = SATS_CONNECT_NETWORK[network];
  const purposes = ['ordinals', 'payment'];
  const attempts: Array<[string, unknown]> = [
    ['wallet_connect', { addresses: purposes, message, network: want }],
    ['getAccounts', { purposes, message }],
    ['getAddresses', { purposes, message, network: { type: want } }],
  ];
  let last: unknown;
  for (const [method, params] of attempts) {
    try {
      const result = await rpcRequest<unknown>(p, method, params);
      return { result, method };
    } catch (e) {
      if (!isMethodNotFound(e)) throw e;
      last = e;
    }
  }
  throw new WalletError('UNSUPPORTED_METHOD', `${id} supports none of wallet_connect / getAccounts / getAddresses.`, {
    walletId: id,
    cause: last,
  });
}

export function satsConnectWallet(
  cfg: SatsConnectAdapterConfig,
  network: Network,
  ordinals: WalletAccount,
  payment: WalletAccount,
): ConnectedWallet {
  const { id } = cfg;
  const owned = [ordinals, payment];
  const current = (): SatsConnectProvider => {
    const p = cfg.provider();
    if (!p) throw new WalletNotInstalledError(id);
    return p;
  };

  return {
    id,
    network,
    ordinals,
    payment,
    capabilities: CAPABILITIES[id],
    ...withTaprootOutputKey(ordinals),

    async signPsbt(psbtBase64: string, opts: SignPsbtOptions) {
      validateInputsToSign(id, opts, owned);
      const psbt = normalizePsbtBase64(psbtBase64);
      const res = await guard(id, () =>
        rpcRequest<{ psbt?: string; txid?: string }>(current(), 'signPsbt', {
          psbt,
          signInputs: signInputsMap(opts),
          broadcast: opts.broadcast === true,
        }),
      );
      if (!isObject(res) || typeof res.psbt !== 'string' || !res.psbt) {
        throw new WalletError('WALLET_ERROR', `${id} returned no signed PSBT.`, { walletId: id });
      }
      return {
        psbtBase64: normalizePsbtBase64(res.psbt),
        ...(typeof res.txid === 'string' && res.txid ? { txid: res.txid } : {}),
      };
    },

    async signMessage(message: string, address: string, type: MessageSignatureType = 'bip322-simple') {
      assertOwnAddress(id, address, owned);
      const res = await guard(id, () =>
        rpcRequest<unknown>(current(), 'signMessage', {
          address,
          message,
          protocol: type === 'ecdsa' ? 'ECDSA' : 'BIP322',
        }),
      );
      const sig = typeof res === 'string' ? res : isObject(res) && typeof res.signature === 'string' ? res.signature : undefined;
      if (!sig) throw new WalletError('WALLET_ERROR', `${id} returned no signature.`, { walletId: id });
      return sig;
    },

    async disconnect() {
      const p = cfg.provider();
      if (p) await quietly(() => rpcRequest(p, 'wallet_disconnect', null));
    },

    onAccountsChanged(cb: () => void) {
      const p = cfg.provider();
      if (!p || typeof p.addListener !== 'function') return () => {};
      const offs: Array<() => void> = [];
      for (const ev of ['accountChange', 'networkChange']) {
        const off = p.addListener(ev, () => cb());
        if (typeof off === 'function') offs.push(off);
      }
      return () => offs.forEach((f) => f());
    },
  };
}

export function satsConnectAdapter(cfg: SatsConnectAdapterConfig): WalletAdapter {
  const { id } = cfg;
  return {
    id,
    name: cfg.name,
    installUrl: cfg.installUrl,
    networks: cfg.networks,
    isInstalled: () => cfg.provider() !== undefined,

    async connect({ network }) {
      assertNetworkSupported(id, network, cfg.networks);
      const p = cfg.provider();
      if (!p) throw new WalletNotInstalledError(id);

      const { result } = await guard(id, () => requestAccounts(id, p, network, cfg.connectMessage ?? 'Connect your wallet'));
      const reported = reportedNetwork(result);
      if (reported && reported !== SATS_CONNECT_NETWORK[network]) {
        throw new UnsupportedNetworkError(id, network, `${cfg.name} is on ${reported}; switch it to ${network} and connect again.`);
      }
      const addrs = addressesFrom(result);
      const o = addrs.find((a) => a.purpose === 'ordinals');
      const pay = addrs.find((a) => a.purpose === 'payment');
      if (!o || !pay) {
        throw new WalletError('NOT_CONNECTED', `${cfg.name} did not return both an ordinals and a payment address.`, {
          walletId: id,
        });
      }
      const ordinals = account(o.address, o.publicKey, 'ordinals');
      const payment = account(pay.address, pay.publicKey, 'payment');
      assertAccountsOnNetwork(id, network, [ordinals, payment]);
      return satsConnectWallet(cfg, network, ordinals, payment);
    },
  };
}
