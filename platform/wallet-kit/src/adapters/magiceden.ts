/**
 * Magic Eden Wallet — `window.magicEden.bitcoin`.
 *
 * Current builds expose the sats-connect `request(method, params)` API and are
 * handled exactly like Xverse. Older builds only expose the sats-connect **v1**
 * surface: `connect(token)`, `signTransaction(token)`, `signMessage(token)`
 * where `token` is an unsecured JWT (`alg: none`) carrying the payload. When
 * `request` is missing, this adapter falls back to that surface.
 *
 * Networks: Magic Eden's Bitcoin wallet is treated as **mainnet only**
 * (ASSUMED; see README).
 */
import { base64urlnopad, utf8 } from '@scure/base';
import { CAPABILITIES } from '../capabilities.js';
import { WalletError, WalletNotInstalledError } from '../errors.js';
import {
  account,
  assertAccountsOnNetwork,
  assertNetworkSupported,
  assertOwnAddress,
  browserWindow,
  guard,
  isObject,
  validateInputsToSign,
  withTaprootOutputKey,
} from '../internal.js';
import { normalizePsbtBase64 } from '../psbt.js';
import type { ConnectedWallet, MessageSignatureType, Network, SignPsbtOptions, WalletAdapter } from '../types.js';
import { SATS_CONNECT_NETWORK, type SatsConnectProvider, satsConnectAdapter } from './sats-connect.js';

const NETWORKS: readonly Network[] = ['mainnet'];
const INSTALL_URL = 'https://wallet.magiceden.io/';

interface MagicEdenLegacyProvider {
  connect(token: string): Promise<unknown>;
  signTransaction(token: string): Promise<unknown>;
  signMessage(token: string): Promise<unknown>;
}

function raw(): Record<string, unknown> | undefined {
  const me = browserWindow()?.magicEden;
  const btc = isObject(me) ? me.bitcoin : undefined;
  return isObject(btc) ? btc : undefined;
}

function requestProvider(): SatsConnectProvider | undefined {
  const p = raw();
  return p && typeof p.request === 'function' ? (p as unknown as SatsConnectProvider) : undefined;
}

function legacyProvider(): MagicEdenLegacyProvider | undefined {
  const p = raw();
  return p && typeof p.connect === 'function' && typeof p.signTransaction === 'function'
    ? (p as unknown as MagicEdenLegacyProvider)
    : undefined;
}

/** sats-connect v1 wire format: unsecured JWT, `header.payload.` with an empty signature. */
export function unsecuredToken(payload: unknown): string {
  const enc = (v: unknown) => base64urlnopad.encode(utf8.decode(JSON.stringify(v)));
  return `${enc({ typ: 'JWT', alg: 'none' })}.${enc(payload)}.`;
}

const modern = satsConnectAdapter({
  id: 'magiceden',
  name: 'Magic Eden',
  installUrl: INSTALL_URL,
  networks: NETWORKS,
  provider: requestProvider,
});

async function connectLegacy(p: MagicEdenLegacyProvider, network: Network): Promise<ConnectedWallet> {
  const netParam = { type: SATS_CONNECT_NETWORK[network] };
  const res = await guard('magiceden', () =>
    p.connect(unsecuredToken({ purposes: ['ordinals', 'payment'], message: 'Connect your wallet', network: netParam })),
  );
  const list = isObject(res) && Array.isArray(res.addresses) ? res.addresses : [];
  const find = (purpose: string) =>
    list.find((a): a is { address: string; publicKey: string } => isObject(a) && a.purpose === purpose && typeof a.address === 'string');
  const o = find('ordinals');
  const pay = find('payment');
  if (!o || !pay) {
    throw new WalletError('NOT_CONNECTED', 'Magic Eden did not return both an ordinals and a payment address.', {
      walletId: 'magiceden',
    });
  }
  const ordinals = account(o.address, o.publicKey, 'ordinals');
  const payment = account(pay.address, pay.publicKey, 'payment');
  assertAccountsOnNetwork('magiceden', network, [ordinals, payment]);
  const owned = [ordinals, payment];
  const current = () => {
    const cur = legacyProvider();
    if (!cur) throw new WalletNotInstalledError('magiceden');
    return cur;
  };

  return {
    id: 'magiceden',
    network,
    ordinals,
    payment,
    capabilities: CAPABILITIES.magiceden,
    ...withTaprootOutputKey(ordinals),
    async signPsbt(psbtBase64: string, opts: SignPsbtOptions) {
      validateInputsToSign('magiceden', opts, owned);
      const byAddress = new Map<string, { address: string; signingIndexes: number[]; sigHash?: number }>();
      for (const i of opts.inputsToSign) {
        const entry = byAddress.get(i.address) ?? { address: i.address, signingIndexes: [] };
        entry.signingIndexes.push(i.index);
        // v1 takes one sighash per address group; forwarded only when a single type is requested.
        if (i.sighashTypes?.length === 1) entry.sigHash = i.sighashTypes[0]!;
        byAddress.set(i.address, entry);
      }
      const res = await guard('magiceden', () =>
        current().signTransaction(
          unsecuredToken({
            network: netParam,
            message: 'Sign transaction',
            psbtBase64: normalizePsbtBase64(psbtBase64),
            broadcast: opts.broadcast === true,
            inputsToSign: [...byAddress.values()],
          }),
        ),
      );
      if (!isObject(res) || typeof res.psbtBase64 !== 'string') {
        throw new WalletError('WALLET_ERROR', 'Magic Eden returned no signed PSBT.', { walletId: 'magiceden' });
      }
      const txid = typeof res.txId === 'string' ? res.txId : typeof res.txid === 'string' ? res.txid : undefined;
      return { psbtBase64: normalizePsbtBase64(res.psbtBase64), ...(txid ? { txid } : {}) };
    },
    async signMessage(message: string, address: string, type: MessageSignatureType = 'bip322-simple') {
      assertOwnAddress('magiceden', address, owned);
      const res = await guard('magiceden', () =>
        current().signMessage(
          unsecuredToken({ network: netParam, address, message, protocol: type === 'ecdsa' ? 'ECDSA' : 'BIP322' }),
        ),
      );
      const sig = typeof res === 'string' ? res : isObject(res) && typeof res.signature === 'string' ? res.signature : undefined;
      if (!sig) throw new WalletError('WALLET_ERROR', 'Magic Eden returned no signature.', { walletId: 'magiceden' });
      return sig;
    },
    async disconnect() {
      /* the v1 surface has no disconnect */
    },
  };
}

export const magicEdenAdapter: WalletAdapter = {
  id: 'magiceden',
  name: 'Magic Eden',
  installUrl: INSTALL_URL,
  networks: NETWORKS,
  isInstalled: () => requestProvider() !== undefined || legacyProvider() !== undefined,

  async connect({ network }) {
    assertNetworkSupported('magiceden', network, NETWORKS);
    if (requestProvider()) return modern.connect({ network });
    const legacy = legacyProvider();
    if (legacy) return connectLegacy(legacy, network);
    if (raw()) {
      throw new WalletError('UNSUPPORTED_METHOD', 'This Magic Eden build exposes no usable Bitcoin API.', { walletId: 'magiceden' });
    }
    throw new WalletNotInstalledError('magiceden');
  },
};
