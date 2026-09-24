/**
 * XCP Wallet — `window.xcpwallet.request({ method, params })` (EIP-1193 style).
 *
 * Ported from counters.fun (`apps/web/src/lib/wallet/sdk/provider.ts` + `adapters/xcp.ts`), which
 * is exercised against the shipped extension. Method names are exactly that SDK's:
 *
 * | | method | params | result |
 * |---|---|---|---|
 * | connect | `xcp_requestAccounts` | — | `{ accounts: string[], proof: BIP-322 proof \| null }` (older builds: `string[]`) |
 * | silent accounts | `xcp_accounts` | — | `string[]` |
 * | addresses + pubkeys | `xcp_getAddresses` | — | `{ active: { address, publicKey, type }, legacy?, segwit? }` |
 * | sign PSBT | `xcp_signPsbt` | `[{ hex, signInputs?, sighashTypes?, inscription? }]` | `{ hex }` (unfinalized) |
 * | sign message | `xcp_signMessage` | `[message]` | `{ signature }` or string (BIP-322) |
 * | broadcast | `xcp_broadcastTransaction` | `[rawHex]` | `{ txid }` |
 * | disconnect | `xcp_disconnect` | — | — |
 *
 * **Inscription context.** The wallet refuses to sign BTC movement it cannot account for. A commit
 * is approved through its inscription gate: `inscription: { revealScript, tapInternalKey }` where
 * `revealScript` is the ord envelope tapleaf whose OP_CHECKSIG key is the SIGNER'S taproot output
 * key (`ConnectedWallet.taprootOutputKey`) and `tapInternalKey` is the BIP-341 NUMS point; the
 * wallet re-derives the commit address and refuses on any mismatch. Pass it via
 * `signPsbt(psbt, { inscription: { envelopeScriptHex, commitAddress } })`. The reveal itself is
 * a script-path spend the wallet signs with the **tweaked** key, SIGHASH_ALL (it rejects
 * `sighashTypes: [0]`, so the PSBT input must declare 0x01, and `sighashTypes` is not sent unless
 * the caller asks for specific types).
 *
 * Signed PSBTs come back unfinalized; `broadcast: true` finalizes locally (btc-signer) and relays
 * through `xcp_broadcastTransaction`. Single active address serves as ordinals and payment account.
 * Mainnet only (the SDK's own address validation accepts mainnet prefixes only).
 */
import { hex } from '@scure/base';
import { TAPROOT_UNSPENDABLE_KEY, Transaction } from '@scure/btc-signer';
import { CAPABILITIES } from '../capabilities.js';
import { UnsupportedMethodError, UserRejectedError, WalletError, WalletNotInstalledError, toWalletError } from '../errors.js';
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
import { psbtBase64ToBytes, psbtBase64ToHex, psbtHexToBase64 } from '../psbt.js';
import type { ConnectedWallet, MessageSignatureType, Network, SignPsbtOptions, WalletAccount, WalletAdapter } from '../types.js';

/** BIP-341 NUMS point, hex: the `tapInternalKey` XCP Wallet's inscription gate requires. */
export const XCP_NUMS_INTERNAL_KEY: string = hex.encode(TAPROOT_UNSPENDABLE_KEY);

const NETWORKS: readonly Network[] = ['mainnet'];

/** EIP-1193 codes the extension uses. */
const USER_REJECTED = 4001;
const UNAUTHORIZED = 4100;

export interface XcpProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface XcpAddress {
  address: string;
  /** Compressed public key, hex. */
  publicKey: string;
  /** `p2tr`, `p2wpkh`, `p2pkh`. */
  type?: string;
}

export interface XcpSignPsbtParams {
  hex: string;
  signInputs?: Record<string, number[]>;
  sighashTypes?: number[];
  inscription?: { revealScript: string; tapInternalKey: string };
}

function provider(): XcpProvider | undefined {
  const p = browserWindow()?.xcpwallet;
  return isObject(p) && typeof p.request === 'function' ? (p as unknown as XcpProvider) : undefined;
}

function current(): XcpProvider {
  const p = provider();
  if (!p) throw new WalletNotInstalledError('xcp');
  return p;
}

function translate(e: unknown): WalletError {
  const code = isObject(e) ? e.code : undefined;
  if (code === USER_REJECTED) return new UserRejectedError('xcp', e);
  if (code === UNAUTHORIZED) return new WalletError('NOT_CONNECTED', 'XCP Wallet is locked or this site is not connected.', { walletId: 'xcp', cause: e });
  return toWalletError(e, 'xcp');
}

async function call<T>(method: string, params?: unknown[]): Promise<T> {
  try {
    return (await current().request(params ? { method, params } : { method })) as T;
  } catch (e) {
    throw translate(e);
  }
}

function accountsOf(result: unknown): string[] {
  const list = Array.isArray(result) ? result : isObject(result) && Array.isArray(result.accounts) ? result.accounts : undefined;
  if (!list) throw new WalletError('WALLET_ERROR', 'XCP Wallet returned an invalid accounts response.', { walletId: 'xcp' });
  return list.filter((a): a is string => typeof a === 'string');
}

/** Find the public key behind `address` from `xcp_getAddresses` (best effort; older builds lack the method). */
async function resolveAccount(address: string): Promise<WalletAccount> {
  let addrs: unknown;
  try {
    addrs = await current().request({ method: 'xcp_getAddresses' });
  } catch {
    addrs = undefined;
  }
  const candidates = isObject(addrs)
    ? [addrs.active, addrs.segwit, addrs.legacy].filter(
        (a): a is XcpAddress => isObject(a) && typeof a.address === 'string' && typeof a.publicKey === 'string',
      )
    : [];
  const match = candidates.find((a) => a.address === address);
  // Connected, but the wallet would not say which key backs the address: carry an honest empty
  // publicKey rather than invent one (taprootOutputKey still comes from the address itself).
  return account(address, match?.publicKey ?? '', 'payment');
}

function xcpWallet(network: Network, acct: WalletAccount): ConnectedWallet {
  const ordinals: WalletAccount = { ...acct, purpose: 'ordinals' };
  const payment: WalletAccount = { ...acct, purpose: 'payment' };
  const owned = [acct];

  return {
    id: 'xcp',
    network,
    ordinals,
    payment,
    capabilities: CAPABILITIES.xcp,
    ...withTaprootOutputKey(ordinals),

    async signPsbt(psbtBase64: string, opts: SignPsbtOptions) {
      validateInputsToSign('xcp', opts, owned);
      const params: XcpSignPsbtParams = { hex: psbtBase64ToHex(psbtBase64), signInputs: signInputsMap(opts) };
      // Sent only when asked for: the wallet rejects `[0]` outright and otherwise honours the
      // PSBT's own per-input sighashType (SIGHASH_ALL for everything in this kit's flows).
      const types = [...new Set(opts.inputsToSign.flatMap((i) => i.sighashTypes ?? []))];
      if (types.length) params.sighashTypes = types;
      if (opts.inscription) {
        params.inscription = { revealScript: opts.inscription.envelopeScriptHex, tapInternalKey: XCP_NUMS_INTERNAL_KEY };
      }
      const res = await call<{ hex?: string }>('xcp_signPsbt', [params]);
      if (!isObject(res) || typeof res.hex !== 'string' || !res.hex) {
        throw new WalletError('WALLET_ERROR', 'XCP Wallet returned no signed PSBT.', { walletId: 'xcp' });
      }
      const signed = psbtHexToBase64(res.hex);
      if (!opts.broadcast) return { psbtBase64: signed };
      // The wallet leaves the PSBT unfinalized; finalize here and relay through the wallet.
      let raw: string;
      try {
        const tx = Transaction.fromPSBT(psbtBase64ToBytes(signed), { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
        tx.finalize();
        raw = hex.encode(tx.extract());
      } catch (e) {
        throw new WalletError('INVALID_PSBT', `XCP Wallet's signed PSBT could not be finalized: ${(e as Error).message}`, { walletId: 'xcp', cause: e });
      }
      const txid = await pushTx(raw);
      return { psbtBase64: signed, txid };
    },

    async signMessage(message: string, address: string, type: MessageSignatureType = 'bip322-simple') {
      assertOwnAddress('xcp', address, owned);
      if (type !== 'bip322-simple') throw new UnsupportedMethodError('xcp', 'XCP Wallet only signs BIP-322 messages.');
      const res = await call<unknown>('xcp_signMessage', [message]);
      const sig = typeof res === 'string' ? res : isObject(res) && typeof res.signature === 'string' ? res.signature : undefined;
      if (!sig) throw new WalletError('WALLET_ERROR', 'XCP Wallet returned no signature.', { walletId: 'xcp' });
      return sig;
    },

    pushTx,

    async disconnect() {
      await quietly(() => current().request({ method: 'xcp_disconnect' }));
    },

    onAccountsChanged(cb: () => void) {
      const p = provider();
      if (!p || typeof p.on !== 'function') return () => {};
      const handler = () => cb();
      for (const ev of ['accountsChanged', 'disconnect']) p.on(ev, handler);
      return () => {
        if (typeof p.removeListener === 'function') for (const ev of ['accountsChanged', 'disconnect']) p.removeListener(ev, handler);
      };
    },
  };

  async function pushTx(rawHex: string): Promise<string> {
    const res = await call<{ txid?: string }>('xcp_broadcastTransaction', [rawHex]);
    const txid = isObject(res) && typeof res.txid === 'string' ? res.txid : typeof res === 'string' ? res : undefined;
    if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) throw new WalletError('WALLET_ERROR', 'XCP Wallet returned no txid.', { walletId: 'xcp' });
    return txid;
  }
}

export const xcpAdapter: WalletAdapter = {
  id: 'xcp',
  name: 'XCP Wallet',
  installUrl: 'https://chromewebstore.google.com/detail/xcp-wallet/nicpjdbehgcjbjfjkobcidnfmfpijohg',
  networks: NETWORKS,
  isInstalled: () => provider() !== undefined,

  async connect({ network }) {
    assertNetworkSupported('xcp', network, NETWORKS);
    if (!provider()) throw new WalletNotInstalledError('xcp');
    const accounts = accountsOf(await call<unknown>('xcp_requestAccounts'));
    const address = accounts[0];
    if (!address) throw new WalletError('NOT_CONNECTED', 'XCP Wallet returned no accounts.', { walletId: 'xcp' });
    const acct = await resolveAccount(address);
    assertAccountsOnNetwork('xcp', network, [acct]);
    return xcpWallet(network, acct);
  },
};
