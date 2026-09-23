import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import type { PaymentIntent, PaymentMethod, Refund } from '../domain/types.js';
import type { OrderStore } from '../store/order-store.js';
import type { CreateIntentInput, Fetch, PaymentProvider, ProviderIntent, ProviderRefundResult, ProviderUpdate } from './provider.js';

// ------------------------------------------------------------------------------------------ address derivation

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';
export type AddressType = 'p2wpkh' | 'p2tr';

const REGTEST: BTC_NETWORK = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
export const networkParams = (n: BitcoinNetwork): BTC_NETWORK => (n === 'mainnet' ? btc.NETWORK : n === 'regtest' ? REGTEST : btc.TEST_NETWORK);

/** SLIP-132 extended-key version bytes we accept. Private versions listed only so they can be refused. */
const XKEY_VERSIONS: Record<string, { public: number; private: number; network: 'mainnet' | 'test'; purpose?: AddressType }> = {
  xpub: { public: 0x0488b21e, private: 0x0488ade4, network: 'mainnet' },
  zpub: { public: 0x04b24746, private: 0x04b2430c, network: 'mainnet', purpose: 'p2wpkh' },
  tpub: { public: 0x043587cf, private: 0x04358394, network: 'test' },
  vpub: { public: 0x045f1cf6, private: 0x045f18bc, network: 'test', purpose: 'p2wpkh' },
  xprv: { public: 0x0488b21e, private: 0x0488ade4, network: 'mainnet' },
  zprv: { public: 0x04b24746, private: 0x04b2430c, network: 'mainnet' },
  tprv: { public: 0x043587cf, private: 0x04358394, network: 'test' },
  vprv: { public: 0x045f1cf6, private: 0x045f18bc, network: 'test' },
};

/**
 * Parse an ACCOUNT-level extended public key (`m/84'/coin'/account'` for BIP84, `m/86'/…` for BIP86).
 * Private keys are refused: the ledger is non-custodial and never holds spending keys.
 */
export function parseAccountXpub(xpub: string, network: BitcoinNetwork): HDKey {
  const prefix = xpub.slice(0, 4);
  const v = XKEY_VERSIONS[prefix];
  if (!v) throw new Error(`unsupported extended key prefix "${prefix}"`);
  if (prefix.endsWith('prv')) throw new Error('extended PRIVATE key refused: the ledger only derives addresses from public keys');
  const wantTest = network !== 'mainnet';
  if ((v.network === 'test') !== wantTest) throw new Error(`${prefix} does not belong to ${network}`);
  const key = HDKey.fromExtendedKey(xpub, { public: v.public, private: v.private });
  if (key.privateKey) throw new Error('extended private key refused');
  if (key.depth !== 3) throw new Error(`expected an account-level key (depth 3), got depth ${key.depth}`);
  return key;
}

/** Address at `<account>/<change>/<index>` for the given script type. */
export function deriveAddress(account: HDKey, addressType: AddressType, network: BitcoinNetwork, index: number, change = 0): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error('index must be a non-hardened child index');
  const child = account.deriveChild(change).deriveChild(index);
  const pub = child.publicKey;
  if (!pub) throw new Error('no public key');
  const net = networkParams(network);
  const addr = addressType === 'p2wpkh' ? btc.p2wpkh(pub, net).address : btc.p2tr(pub.slice(1), undefined, net).address;
  if (!addr) throw new Error('address derivation failed');
  return addr;
}

// ------------------------------------------------------------------------------------------ chain port

/** Esplora-shaped transaction (only the fields the watcher needs). */
export interface ChainTx {
  txid: string;
  vin: Array<{ sequence: number }>;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number };
}

export interface ChainPort {
  tipHeight(): Promise<number>;
  /** Every transaction (mempool + chain) paying or spending `address`. */
  addressTxs(address: string): Promise<ChainTx[]>;
}

/** Esplora / mempool.space-compatible HTTP adapter (`/blocks/tip/height`, `/address/:a/txs`). */
export class EsploraChain implements ChainPort {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: Fetch = (u, i) => fetch(u, i),
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`esplora ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async tipHeight(): Promise<number> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}/blocks/tip/height`);
    if (!res.ok) throw new Error(`esplora tip: HTTP ${res.status}`);
    return Number(await res.text());
  }

  async addressTxs(address: string): Promise<ChainTx[]> {
    return this.get<ChainTx[]>(`/address/${encodeURIComponent(address)}/txs`);
  }
}

// ------------------------------------------------------------------------------------------ payment evaluation

export interface ConfirmationPolicy {
  /** Confirmations before funds count as paid. 0 accepts unconfirmed, RBF-disabled (unreplaceable) transactions. */
  confirmations: number;
  /** Paying up to this much less still counts as paid (dust the customer's wallet may shave off). Default 0. */
  underpaymentToleranceSats?: number;
  /** Paying up to this much more is still "paid", not "overpaid". Default 0. */
  overpaymentToleranceSats?: number;
}

/** BIP125: a transaction is replaceable when any input's sequence is below 0xfffffffe. */
export const isReplaceable = (tx: ChainTx): boolean => tx.vin.some((i) => i.sequence < 0xfffffffe);

export interface OnchainEvaluation extends ProviderUpdate {
  creditedSats: number;
  /** Countable but not yet at the confirmation depth (confirmed shallowly, or unreplaceable in the mempool). */
  awaitingSats: number;
  /** In the mempool and RBF-signalling: ignored until mined. */
  replaceableSats: number;
}

/**
 * Pure policy: derive the intent status from the address history. Only confirmed or unreplaceable transactions
 * are counted at all; only those at the required depth are credited. Amounts are sums over all outputs to the
 * address, so top-ups (several transactions) are honoured. A replaced (RBF'd) transaction disappears from the
 * history and is naturally forgotten.
 */
export function evaluateOnchain(input: {
  address: string;
  txs: readonly ChainTx[];
  tipHeight: number;
  amountSats: number;
  policy: ConfirmationPolicy;
  expiresAt: string | null;
  now: Date;
}): OnchainEvaluation | undefined {
  const { policy } = input;
  const underTol = policy.underpaymentToleranceSats ?? 0;
  const overTol = policy.overpaymentToleranceSats ?? 0;
  let credited = 0;
  let awaiting = 0;
  let replaceable = 0;
  const creditedTxids: string[] = [];
  for (const tx of input.txs) {
    const value = tx.vout.filter((o) => o.scriptpubkey_address === input.address).reduce((s, o) => s + o.value, 0);
    if (value <= 0) continue;
    const confs = tx.status.confirmed && tx.status.block_height !== undefined ? Math.max(0, input.tipHeight - tx.status.block_height + 1) : 0;
    if (!tx.status.confirmed && isReplaceable(tx)) {
      replaceable += value;
      continue;
    }
    if (confs >= policy.confirmations) {
      credited += value;
      creditedTxids.push(tx.txid);
    } else awaiting += value;
  }
  const seen = credited + awaiting;
  const base = { creditedSats: credited, awaitingSats: awaiting, replaceableSats: replaceable, amountPaidSats: credited };
  const txid = creditedTxids[0];
  if (credited >= input.amountSats - underTol) {
    const status = credited > input.amountSats + overTol ? 'overpaid' : 'paid';
    return { ...base, status, paidAt: input.now.toISOString(), ...(txid ? { txid } : {}) };
  }
  if (seen >= input.amountSats - underTol) return { ...base, status: 'pending', detail: 'awaiting confirmations' };
  if (credited > 0) return { ...base, status: 'underpaid', ...(txid ? { txid } : {}) };
  if (seen > 0 || replaceable > 0) return { ...base, status: 'pending', detail: replaceable > 0 && seen === 0 ? 'replaceable transaction seen' : 'awaiting confirmations' };
  if (input.expiresAt && input.now.getTime() >= Date.parse(input.expiresAt)) return { ...base, status: 'expired' };
  return undefined;
}

// ------------------------------------------------------------------------------------------ provider

export interface OnchainProviderOptions {
  xpub: string;
  network: BitcoinNetwork;
  addressType: AddressType;
  chain: ChainPort;
  store: Pick<OrderStore, 'allocateAddressIndex'>;
  policy: ConfirmationPolicy;
  /** Minutes an intent stays payable when nothing is received. Default 60. */
  expiryMinutes?: number;
}

/**
 * Watch-only on-chain provider: derives a fresh receive address per intent from an account xpub, polls an
 * esplora-compatible backend and applies the confirmation policy. Refunds need an operator payout (RUNBOOK):
 * the ledger holds no keys.
 */
export class OnchainAddressProvider implements PaymentProvider {
  readonly name = 'onchain';
  readonly methods: readonly PaymentMethod[] = ['onchain'];
  private readonly account: HDKey;
  private readonly scope: string;

  constructor(private readonly opts: OnchainProviderOptions) {
    this.account = parseAccountXpub(opts.xpub, opts.network);
    this.scope = `onchain:${opts.network}:${opts.addressType}:${this.account.fingerprint.toString(16)}`;
    if (!Number.isInteger(opts.policy.confirmations) || opts.policy.confirmations < 0) throw new Error('policy.confirmations must be >= 0');
  }

  addressAt(index: number): string {
    return deriveAddress(this.account, this.opts.addressType, this.opts.network, index);
  }

  async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
    const index = await this.opts.store.allocateAddressIndex(this.scope);
    const address = this.addressAt(index);
    const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + (this.opts.expiryMinutes ?? 60) * 60_000).toISOString();
    return { providerRef: address, checkout: { address }, expiresAt, providerData: { addressIndex: index, network: this.opts.network } };
  }

  async poll(intent: PaymentIntent, now: Date): Promise<ProviderUpdate | undefined> {
    const [txs, tip] = await Promise.all([this.opts.chain.addressTxs(intent.providerRef), this.opts.chain.tipHeight()]);
    const ev = evaluateOnchain({ address: intent.providerRef, txs, tipHeight: tip, amountSats: intent.amountSats, policy: this.opts.policy, expiresAt: intent.expiresAt, now });
    if (!ev) return undefined;
    const { creditedSats, awaitingSats, replaceableSats, ...update } = ev;
    return { ...update, providerData: { ...intent.providerData, creditedSats, awaitingSats, replaceableSats } };
  }

  async refund(_intent: PaymentIntent, refund: Refund): Promise<ProviderRefundResult> {
    if (!refund.destination) return { status: 'failed', providerRef: null, detail: 'on-chain refunds need a destination address' };
    return { status: 'pending', providerRef: null, detail: 'manual payout: the ledger holds no keys (see RUNBOOK)' };
  }
}
