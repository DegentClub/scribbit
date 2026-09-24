import * as btc from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LedgerError, invalid } from '../domain/errors.js';
import { TXID_CLAIMING_STATUSES, type ExpectedOutput, type Order, type Payee, type PaymentIntent, type PaymentMethod, type PaymentStatus, type Refund } from '../domain/types.js';
import { assertSats } from '../money.js';
import type { OrderStore } from '../store/order-store.js';
import { isReplaceable, networkParams, type BitcoinNetwork, type ChainTx, type ConfirmationPolicy } from './onchain.js';
import type { CreateIntentInput, PaymentProvider, PayoutSettlement, ProviderIntent, ProviderRefundResult, ProviderUpdate } from './provider.js';

// ------------------------------------------------------------------------------------------ expected outputs

/** scriptPubKey (lowercase hex) of an address; throws `invalid_payee_address` (400) for the wrong network. */
export function scriptHexForAddress(address: string, network: BitcoinNetwork): string {
  try {
    return bytesToHex(btc.OutScript.encode(btc.Address(networkParams(network)).decode(address)));
  } catch (e) {
    throw new LedgerError(400, 'invalid_payee_address', `payee address "${address}" is not valid on ${network}: ${(e as Error).message}`);
  }
}

/** The script a payee is matched on: `scriptHex` as given, else the decoded `address`. */
export function payeeScriptHex(payee: Payee, network: BitcoinNetwork): string {
  if (payee.scriptHex) return payee.scriptHex.toLowerCase();
  if (payee.address) return scriptHexForAddress(payee.address, network);
  throw invalid('payee needs address or scriptHex');
}

/**
 * Outputs the paying transaction must carry: the line items that name a payee, summed per payee SCRIPT (two line
 * items paying the same script become one expected output; an address and its own script are the same key).
 * Line items without a payee are not expected outputs. Order: first appearance in `lineItems`.
 */
export function expectedOutputsFor(order: Pick<Order, 'lineItems'>, network: BitcoinNetwork = 'mainnet'): ExpectedOutput[] {
  const byScript = new Map<string, ExpectedOutput>();
  for (const li of order.lineItems) {
    if (!li.payee) continue;
    const scriptHex = payeeScriptHex(li.payee, network);
    const value = assertSats(li.quantity * li.unitSats, 'line item value');
    const cur = byScript.get(scriptHex);
    if (cur) cur.valueSats = assertSats(cur.valueSats + value, 'expected output value');
    else byScript.set(scriptHex, { scriptHex, valueSats: value, ...(li.payee.address ? { address: li.payee.address } : {}), payee: { ...li.payee } });
  }
  return [...byScript.values()];
}

// ------------------------------------------------------------------------------------------ evaluation

/** A transaction as observed on the network (or reported by the product after broadcast). */
export interface ObservedTransaction {
  txid: string;
  /** In vout order; `scriptHex` is the scriptPubKey. */
  outputs: Array<{ scriptHex: string; valueSats: number }>;
  confirmations: number;
  /** BIP125: unconfirmed and replaceable. Ignored until mined. */
  rbfSignalled: boolean;
}

/** Per expected output: what the transaction actually carries for it. */
export interface OutputSettlement {
  payee: Payee;
  scriptHex: string;
  expectedSats: number;
  /** Sum over every output of the transaction with this script. */
  observedSats: number;
  vouts: number[];
  satisfied: boolean;
}

export interface PsbtEvaluation extends ProviderUpdate {
  settlements: OutputSettlement[];
  expectedSats: number;
  observedSats: number;
}

const RANK: Partial<Record<PaymentStatus, number>> = { paid: 4, overpaid: 3, underpaid: 2, pending: 1 };
/** Candidate order for `poll`: a transaction carrying every expected output beats a partial one, then by status. */
const rank = (ev: PsbtEvaluation): number => (ev.settlements.every((s) => s.satisfied) ? 10 : 0) + (RANK[ev.status] ?? 0);

/**
 * Pure policy for one observed transaction against the expected outputs. Scripts are compared, never address
 * strings. Returns undefined when the transaction pays none of the expected scripts (it is not ours).
 *   paid       every expected output present at or above its value (minus `underpaymentToleranceSats`), at depth
 *   overpaid   paid, and the total exceeds the expected total by more than `overpaymentToleranceSats`
 *   underpaid  at depth, some outputs short or missing; `amountPaidSats` is what did arrive
 *   pending    seen but replaceable (RBF, unconfirmed) or not yet at `policy.confirmations`
 * `payouts` lists every satisfied output (payee, amount, txid:vout) so the service can record them once paid.
 */
export function evaluatePsbt(input: { expected: readonly ExpectedOutput[]; tx: ObservedTransaction; policy: ConfirmationPolicy; now: Date }): PsbtEvaluation | undefined {
  const { tx, policy } = input;
  if (!/^[0-9a-f]{64}$/.test(tx.txid)) throw invalid(`txid must be 64 lowercase hex characters`);
  if (input.expected.length === 0) throw invalid('no expected outputs');
  const underTol = policy.underpaymentToleranceSats ?? 0;
  const overTol = policy.overpaymentToleranceSats ?? 0;
  const settlements: OutputSettlement[] = input.expected.map((e) => {
    const script = e.scriptHex.toLowerCase();
    let observed = 0;
    const vouts: number[] = [];
    tx.outputs.forEach((o, vout) => {
      if (o.scriptHex.toLowerCase() !== script) return;
      observed += assertSats(o.valueSats, `outputs[${vout}].valueSats`);
      vouts.push(vout);
    });
    return { payee: e.payee, scriptHex: script, expectedSats: e.valueSats, observedSats: observed, vouts, satisfied: observed >= e.valueSats - underTol };
  });
  const observedSats = settlements.reduce((s, x) => s + x.observedSats, 0);
  const expectedSats = settlements.reduce((s, x) => s + x.expectedSats, 0);
  if (observedSats === 0) return undefined;
  const base = { settlements, expectedSats, observedSats, txid: tx.txid, providerData: { observedTxid: tx.txid, confirmations: tx.confirmations } };
  if (tx.confirmations <= 0 && tx.rbfSignalled) return { ...base, status: 'pending', amountPaidSats: 0, detail: 'replaceable transaction seen' };
  if (tx.confirmations < policy.confirmations) return { ...base, status: 'pending', amountPaidSats: 0, detail: 'awaiting confirmations' };
  const payouts: PayoutSettlement[] = settlements
    .filter((x) => x.satisfied)
    .map((x) => ({ payee: x.payee, scriptHex: x.scriptHex, amountSats: x.observedSats, txid: tx.txid, vout: x.vouts[0]! }));
  if (settlements.every((x) => x.satisfied)) {
    const status: PaymentStatus = observedSats > expectedSats + overTol ? 'overpaid' : 'paid';
    return { ...base, status, amountPaidSats: observedSats, paidAt: input.now.toISOString(), payouts };
  }
  const short = settlements.filter((x) => !x.satisfied).map((x) => `${x.payee.kind}:${x.payee.ref} ${x.observedSats}/${x.expectedSats}`);
  return { ...base, status: 'underpaid', amountPaidSats: observedSats, payouts, detail: `short outputs: ${short.join(', ')}` };
}

// ------------------------------------------------------------------------------------------ provider

/** What the psbt provider needs from a chain backend to find the settling transaction by itself. */
export interface PsbtChainPort {
  tipHeight(): Promise<number>;
  /** Every transaction (mempool + chain) paying or spending the given scriptPubKey (hex). */
  scriptTxs(scriptHex: string): Promise<ChainTx[]>;
}

export interface PsbtProviderOptions {
  network: BitcoinNetwork;
  policy: ConfirmationPolicy;
  /** Optional: with a chain backend the worker finds the settling transaction; without one the product reports it (`evaluate`). */
  chain?: PsbtChainPort;
  /** Optional (recommended with `chain`): lets `poll` skip transactions that already settle another intent. */
  store?: Pick<OrderStore, 'findPaymentsByTxid'>;
  /** Minutes an intent stays payable when nothing is received. Default 60. */
  expiryMinutes?: number;
}

/** Esplora-shaped transaction → the provider's observed shape (confirmations from the tip, RBF from the inputs). */
export function observedFromChainTx(tx: ChainTx, tipHeight: number): ObservedTransaction {
  const confirmations = tx.status.confirmed && tx.status.block_height !== undefined ? Math.max(0, tipHeight - tx.status.block_height + 1) : 0;
  return {
    txid: tx.txid,
    outputs: tx.vout.map((o) => ({ scriptHex: (o.scriptpubkey ?? '').toLowerCase(), valueSats: o.value })),
    confirmations,
    rbfSignalled: !tx.status.confirmed && isReplaceable(tx),
  };
}

/**
 * "The customer pays by signing a PSBT built by the product." The ledger builds nothing and signs nothing: at
 * intent creation it publishes the outputs the PSBT must carry (`checkout.outputs`, one per payee script), and
 * settles the intent when a transaction carrying every one of them reaches the confirmation policy. Each payee
 * output found is handed to the service as a payout settlement. Refunds are operator payouts (no keys here).
 */
export class PsbtProvider implements PaymentProvider {
  readonly name = 'psbt';
  readonly methods: readonly PaymentMethod[] = ['psbt'];

  constructor(private readonly opts: PsbtProviderOptions) {
    if (!Number.isInteger(opts.policy.confirmations) || opts.policy.confirmations < 0) throw new Error('policy.confirmations must be >= 0');
  }

  get network(): BitcoinNetwork {
    return this.opts.network;
  }

  expectedOutputs(order: Pick<Order, 'lineItems'>): ExpectedOutput[] {
    return expectedOutputsFor(order, this.opts.network);
  }

  async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
    const missing = input.order.lineItems.filter((li) => !li.payee);
    if (missing.length > 0) throw new LedgerError(409, 'payee_required', `psbt payments need a payee on every line item (missing on ${missing.map((li) => li.sku).join(', ')})`);
    const outputs = this.expectedOutputs(input.order);
    if (outputs.length === 0) throw new LedgerError(409, 'payee_required', 'psbt payments need at least one payee output');
    const expectedSats = outputs.reduce((s, o) => s + o.valueSats, 0);
    if (expectedSats !== input.amountSats) throw new LedgerError(409, 'payee_required', `payee outputs sum to ${expectedSats} sats, the intent is ${input.amountSats}`);
    const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + (this.opts.expiryMinutes ?? 60) * 60_000).toISOString();
    return {
      providerRef: input.intentId,
      checkout: { outputs },
      expiresAt,
      providerData: { network: this.opts.network, expectedOutputs: outputs },
    };
  }

  /** Expected outputs of a stored intent (from `createIntent`), or recomputed from the order when given. */
  expectedOutputsOf(intent: PaymentIntent): ExpectedOutput[] {
    const stored = (intent.providerData.expectedOutputs ?? intent.checkout.outputs) as ExpectedOutput[] | undefined;
    if (!stored || stored.length === 0) throw new LedgerError(409, 'payee_required', `intent ${intent.id} has no expected outputs`);
    return stored;
  }

  /** Evaluate one observed transaction against the intent (products call this after broadcasting the signed PSBT). */
  evaluate(intent: PaymentIntent, tx: ObservedTransaction, now: Date): ProviderUpdate | undefined {
    const ev = evaluatePsbt({ expected: this.expectedOutputsOf(intent), tx, policy: this.opts.policy, now });
    return ev && this.toUpdate(ev);
  }

  private toUpdate(ev: PsbtEvaluation): ProviderUpdate {
    const { settlements, expectedSats, observedSats, ...update } = ev;
    return {
      ...update,
      providerData: { ...update.providerData, expectedSats, observedSats, settlements: settlements.map((s) => ({ ...s, payee: { kind: s.payee.kind, ref: s.payee.ref } })) },
    };
  }

  /** Whether another intent already recorded this txid (it settles that one, not ours). */
  private async claimedElsewhere(txid: string, intentId: string): Promise<boolean> {
    if (!this.opts.store) return false;
    return (await this.opts.store.findPaymentsByTxid(txid)).some((o) => o.id !== intentId && TXID_CLAIMING_STATUSES.has(o.status));
  }

  /**
   * Look the settling transaction up by the first expected script (payee scripts may be shared across orders, so
   * every transaction paying it is a candidate): skip ones claimed by another intent, prefer ones carrying every
   * expected output, then the most settled status.
   */
  async poll(intent: PaymentIntent, now: Date): Promise<ProviderUpdate | undefined> {
    const chain = this.opts.chain;
    if (!chain) return undefined;
    const expected = this.expectedOutputsOf(intent);
    const [txs, tip] = await Promise.all([chain.scriptTxs(expected[0]!.scriptHex), chain.tipHeight()]);
    let best: PsbtEvaluation | undefined;
    for (const tx of txs) {
      if (tx.txid !== intent.txid && (await this.claimedElsewhere(tx.txid, intent.id))) continue;
      const ev = evaluatePsbt({ expected, tx: observedFromChainTx(tx, tip), policy: this.opts.policy, now });
      if (ev && (!best || rank(ev) > rank(best))) best = ev;
    }
    if (best) return this.toUpdate(best);
    if ((intent.status === 'created' || intent.status === 'pending') && intent.expiresAt && now.getTime() >= Date.parse(intent.expiresAt)) return { status: 'expired', detail: 'expired without payment' };
    return undefined;
  }

  async refund(_intent: PaymentIntent, refund: Refund): Promise<ProviderRefundResult> {
    if (!refund.destination) return { status: 'failed', providerRef: null, detail: 'psbt refunds need a destination address' };
    return { status: 'pending', providerRef: null, detail: 'manual payout: the ledger holds no keys (see RUNBOOK)' };
  }
}
