/**
 * Leather — `window.LeatherProvider.request(method, params)` (Leather RPC).
 *
 * - `getAddresses` returns every account address (BTC p2wpkh + p2tr, plus STX);
 *   p2tr is the ordinals account, p2wpkh the payment account.
 * - `signPsbt` takes **hex** plus `signAtIndex` (indexes only; Leather resolves
 *   the key itself), `network`, `broadcast`, and optionally `allowedSighash`.
 *   It returns `{ hex, txid? }`.
 * - `signMessage` is BIP-322 only; the signing account is chosen with
 *   `paymentType: 'p2tr' | 'p2wpkh'`.
 * - Leather has no network switch in its RPC; the network is whatever the user
 *   selected, so it is validated from the returned addresses.
 */
import { CAPABILITIES } from '../capabilities.js';
import { UnsupportedNetworkError, WalletError, WalletNotInstalledError } from '../errors.js';
import {
  type RpcProvider,
  account,
  assertAccountsOnNetwork,
  assertNetworkSupported,
  assertOwnAddress,
  browserWindow,
  guard,
  isObject,
  rpcRequest,
  validateInputsToSign,
  withTaprootOutputKey,
} from '../internal.js';
import { detectAddressType } from '../address.js';
import { psbtBase64ToHex, psbtHexToBase64 } from '../psbt.js';
import type { ConnectedWallet, MessageSignatureType, Network, SignPsbtOptions, WalletAdapter } from '../types.js';

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export interface LeatherAddress {
  symbol?: string;
  type?: string;
  address: string;
  publicKey?: string;
  tweakedPublicKey?: string;
}

function provider(): RpcProvider | undefined {
  const p = browserWindow()?.LeatherProvider;
  return isObject(p) && typeof p.request === 'function' ? (p as unknown as RpcProvider) : undefined;
}

function current(): RpcProvider {
  const p = provider();
  if (!p) throw new WalletNotInstalledError('leather');
  return p;
}

function btcAddresses(result: unknown): LeatherAddress[] {
  const list = isObject(result) && Array.isArray(result.addresses) ? result.addresses : [];
  return list.filter(
    (a): a is LeatherAddress =>
      isObject(a) && typeof a.address === 'string' && (a.symbol === undefined || a.symbol === 'BTC'),
  );
}

function typeOf(a: LeatherAddress): string {
  return a.type ?? detectAddressType(a.address);
}

function leatherWallet(network: Network, ordinals: ReturnType<typeof account>, payment: ReturnType<typeof account>): ConnectedWallet {
  const owned = [ordinals, payment];
  return {
    id: 'leather',
    network,
    ordinals,
    payment,
    capabilities: CAPABILITIES.leather,
    ...withTaprootOutputKey(ordinals),

    async signPsbt(psbtBase64: string, opts: SignPsbtOptions) {
      validateInputsToSign('leather', opts, owned);
      const allowed = [...new Set(opts.inputsToSign.flatMap((i) => i.sighashTypes ?? []))];
      const params = {
        hex: psbtBase64ToHex(psbtBase64),
        signAtIndex: opts.inputsToSign.map((i) => i.index),
        network,
        broadcast: opts.broadcast === true,
        ...(allowed.length ? { allowedSighash: allowed } : {}),
      };
      const res = await guard('leather', () => rpcRequest<{ hex?: string; txid?: string }>(current(), 'signPsbt', params));
      if (!isObject(res) || typeof res.hex !== 'string' || !res.hex) {
        throw new WalletError('WALLET_ERROR', 'Leather returned no signed PSBT.', { walletId: 'leather' });
      }
      return {
        psbtBase64: psbtHexToBase64(res.hex),
        ...(typeof res.txid === 'string' && res.txid ? { txid: res.txid } : {}),
      };
    },

    async signMessage(message: string, address: string, type: MessageSignatureType = 'bip322-simple') {
      const acct = assertOwnAddress('leather', address, owned);
      if (type !== 'bip322-simple') {
        throw new WalletError('UNSUPPORTED_METHOD', 'Leather only signs BIP-322 messages.', { walletId: 'leather' });
      }
      const res = await guard('leather', () =>
        rpcRequest<unknown>(current(), 'signMessage', {
          message,
          paymentType: acct.addressType === 'p2tr' ? 'p2tr' : 'p2wpkh',
          network,
        }),
      );
      const sig = isObject(res) && typeof res.signature === 'string' ? res.signature : typeof res === 'string' ? res : undefined;
      if (!sig) throw new WalletError('WALLET_ERROR', 'Leather returned no signature.', { walletId: 'leather' });
      if (isObject(res) && typeof res.address === 'string' && res.address !== address) {
        throw new WalletError('WALLET_ERROR', `Leather signed with ${res.address}, not ${address}.`, { walletId: 'leather' });
      }
      return sig;
    },

    async disconnect() {
      /* Leather's RPC has no disconnect; forgetting the session is enough. */
    },
  };
}

export const leatherAdapter: WalletAdapter = {
  id: 'leather',
  name: 'Leather',
  installUrl: 'https://leather.io/install-extension',
  networks: NETWORKS,
  isInstalled: () => provider() !== undefined,

  async connect({ network }) {
    assertNetworkSupported('leather', network, NETWORKS);
    const p = provider();
    if (!p) throw new WalletNotInstalledError('leather');
    const result = await guard('leather', () => rpcRequest<unknown>(p, 'getAddresses'));
    const addrs = btcAddresses(result);
    const o = addrs.find((a) => typeOf(a) === 'p2tr');
    const pay = addrs.find((a) => typeOf(a) === 'p2wpkh');
    if (!o || !pay) {
      throw new WalletError('NOT_CONNECTED', 'Leather did not return both a taproot and a native segwit address.', {
        walletId: 'leather',
      });
    }
    const ordinals = account(o.address, o.publicKey ?? '', 'ordinals');
    const payment = account(pay.address, pay.publicKey ?? '', 'payment');
    try {
      assertAccountsOnNetwork('leather', network, [ordinals, payment]);
    } catch {
      throw new UnsupportedNetworkError(
        'leather',
        network,
        `Leather is set to a different network (got ${ordinals.address}). Change the network in Leather to ${network} and connect again.`,
      );
    }
    return leatherWallet(network, ordinals, payment);
  },
};
