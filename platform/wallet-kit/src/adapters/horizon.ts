/**
 * Horizon Wallet (Unspendable Labs) — `window.HorizonWalletProvider.request(method, params)`,
 * also announced through WBIP-004 discovery (`window.btc_providers[{ id: 'HorizonWalletProvider' }]`).
 *
 * Ported from counters.fun `apps/web/src/lib/wallet/adapters/horizon.ts`, verified there against
 * extension v2.3.1. The provider speaks two dialects and picks by the *shape of the params*:
 * `getAddresses` without `purposes` and `signPsbt` with `hex` hit the **house API**, which
 * resolves `{ result }` and rejects on failure; the sats-connect dialect (base64 `psbt`,
 * `purposes`) resolves error envelopes instead. This adapter uses the house API throughout.
 *
 * | | method | params | result |
 * |---|---|---|---|
 * | connect | `getAddresses` | — | `{ addresses: [{ address, publicKey, type }], network }` |
 * | sign PSBT | `signPsbt` | `{ hex, signInputs: { [address]: index[] }, sighashTypes: [0x00, 0x01] }` | `{ hex }` (unfinalized) |
 * | sign message | `signMessage` | `{ message, address }` (ASSUMED) | `{ signature }` — ECDSA / BIP-137 only |
 * | disconnect | `wallet_disconnect` | `{}` | — |
 *
 * What it does not have: **no broadcast** (`sendTransfer` pays an address; there is no raw relay,
 * so `broadcast: true` throws `UNSUPPORTED_METHOD` and the caller relays through its own node),
 * **no raw-transaction signing** (PSBT only), **no BIP-322** (`signMessage(…, 'bip322-simple')`
 * throws `UnsupportedMethodError`). It does handle `tapLeafScript` / `tapInternalKey`, so it
 * signs an inscription reveal's script path; counters.fun feeds it the same leaf as XCP Wallet
 * (re-keyed to the tweaked output key) and needs no inscription context.
 *
 * Rejections: a user cancellation arrives as a rejected `{ error: <string> }`; a validation
 * failure as `{ error: { code, message } }` (`-32000` rejection, `-32002` not connected).
 */
import { CAPABILITIES } from '../capabilities.js';
import { UnsupportedMethodError, UserRejectedError, WalletError, WalletNotInstalledError, errorMessage, toWalletError } from '../errors.js';
import {
  account,
  assertAccountsOnNetwork,
  assertNetworkSupported,
  assertOwnAddress,
  browserWindow,
  isObject,
  quietly,
  signInputsMap,
  validateInputsToSign,
  withTaprootOutputKey,
} from '../internal.js';
import { detectAddressType } from '../address.js';
import { psbtBase64ToHex, psbtHexToBase64 } from '../psbt.js';
import type { ConnectedWallet, MessageSignatureType, Network, SignPsbtOptions, WalletAccount, WalletAdapter } from '../types.js';

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];
const PROVIDER_ID = 'HorizonWalletProvider';

export interface HorizonProvider {
  request(method: string, params?: unknown): Promise<{ result: unknown } | unknown>;
}

export interface HorizonAddress {
  address: string;
  /** Compressed public key, hex. */
  publicKey: string;
  /** `p2tr`, `p2wpkh`, `p2pkh`. */
  type?: string;
}

/** Sighash whitelist for the house `signPsbt`: taproot (DEFAULT) and segwit-v0 (ALL) inputs both sign. */
export const HORIZON_SIGHASH_TYPES: readonly number[] = Object.freeze([0x00, 0x01]);

function announced(): boolean {
  const list = browserWindow()?.btc_providers;
  return Array.isArray(list) && list.some((p) => isObject(p) && p.id === PROVIDER_ID);
}

function provider(): HorizonProvider | undefined {
  const w = browserWindow();
  const p = w?.[PROVIDER_ID];
  if (isObject(p) && typeof p.request === 'function') return p as unknown as HorizonProvider;
  return undefined;
}

function current(): HorizonProvider {
  const p = provider();
  if (!p) throw new WalletNotInstalledError('horizon');
  return p;
}

function translate(e: unknown): WalletError {
  if (isObject(e) && e.error != null) {
    if (typeof e.error === 'string') return new UserRejectedError('horizon', e, e.error);
    const err = e.error as { code?: unknown; message?: unknown };
    if (err.code === -32000) return new UserRejectedError('horizon', e);
    if (err.code === -32002) return new WalletError('NOT_CONNECTED', errorMessage(err), { walletId: 'horizon', cause: e });
    return new WalletError('WALLET_ERROR', `horizon: ${errorMessage(err)}`, { walletId: 'horizon', cause: e });
  }
  return toWalletError(e, 'horizon');
}

async function house<T>(method: string, params?: unknown): Promise<T> {
  let res: unknown;
  try {
    res = await current().request(method, params);
  } catch (e) {
    throw translate(e);
  }
  if (isObject(res) && 'error' in res && res.error != null) throw translate(res);
  return (isObject(res) && 'result' in res ? res.result : res) as T;
}

function addressesOf(result: unknown): HorizonAddress[] {
  const list = isObject(result) && Array.isArray(result.addresses) ? result.addresses : [];
  return list.filter((a): a is HorizonAddress => isObject(a) && typeof a.address === 'string');
}

const typeOf = (a: HorizonAddress) => a.type ?? detectAddressType(a.address);

function horizonWallet(network: Network, ordinals: WalletAccount, payment: WalletAccount): ConnectedWallet {
  const owned = ordinals.address === payment.address ? [ordinals] : [ordinals, payment];
  return {
    id: 'horizon',
    network,
    ordinals,
    payment,
    capabilities: CAPABILITIES.horizon,
    ...withTaprootOutputKey(ordinals),

    async signPsbt(psbtBase64: string, opts: SignPsbtOptions) {
      validateInputsToSign('horizon', opts, owned);
      if (opts.broadcast) {
        throw new UnsupportedMethodError('horizon', 'Horizon Wallet cannot broadcast; sign, finalize and relay through your own node.');
      }
      // `inscription` is accepted so callers do not branch, and deliberately not forwarded: an
      // unrecognised field on the house call would go straight through to the signer.
      const sighashTypes = [...new Set([...HORIZON_SIGHASH_TYPES, ...opts.inputsToSign.flatMap((i) => i.sighashTypes ?? [])])];
      const res = await house<{ hex?: string }>('signPsbt', {
        hex: psbtBase64ToHex(psbtBase64),
        signInputs: signInputsMap(opts),
        sighashTypes,
      });
      if (!isObject(res) || typeof res.hex !== 'string' || !res.hex) {
        throw new WalletError('WALLET_ERROR', 'Horizon Wallet returned no signed PSBT.', { walletId: 'horizon' });
      }
      return { psbtBase64: psbtHexToBase64(res.hex) };
    },

    async signMessage(message: string, address: string, type: MessageSignatureType = 'ecdsa') {
      assertOwnAddress('horizon', address, owned);
      if (type !== 'ecdsa') {
        throw new UnsupportedMethodError('horizon', 'Horizon Wallet signs ECDSA / BIP-137 messages only, not BIP-322.');
      }
      const res = await house<unknown>('signMessage', { message, address });
      const sig = typeof res === 'string' ? res : isObject(res) && typeof res.signature === 'string' ? res.signature : undefined;
      if (!sig) throw new WalletError('WALLET_ERROR', 'Horizon Wallet returned no signature.', { walletId: 'horizon' });
      return sig;
    },

    async disconnect() {
      await quietly(() => current().request('wallet_disconnect', {}));
    },
  };
}

export const horizonAdapter: WalletAdapter = {
  id: 'horizon',
  name: 'Horizon Wallet',
  installUrl: 'https://chromewebstore.google.com/detail/horizon-wallet/bnmgkjlaommgappfckljlelgahnbngme',
  networks: NETWORKS,
  /** The named getter, or the WBIP-004 announcement (a page that loaded before injection may only see the array). */
  isInstalled: () => provider() !== undefined || announced(),

  async connect({ network }) {
    assertNetworkSupported('horizon', network, NETWORKS);
    if (!provider()) throw new WalletNotInstalledError('horizon');
    const result = await house<unknown>('getAddresses');
    const addrs = addressesOf(result);
    const taproot = addrs.find((a) => typeOf(a) === 'p2tr');
    const segwit = addrs.find((a) => typeOf(a) === 'p2wpkh');
    const o = taproot ?? addrs[0];
    if (!o) throw new WalletError('NOT_CONNECTED', 'Horizon Wallet returned no addresses.', { walletId: 'horizon' });
    const pay = segwit ?? o;
    const ordinals = account(o.address, o.publicKey ?? '', 'ordinals');
    const payment = account(pay.address, pay.publicKey ?? '', 'payment');
    assertAccountsOnNetwork('horizon', network, [ordinals, payment]);
    return horizonWallet(network, ordinals, payment);
  },
};
