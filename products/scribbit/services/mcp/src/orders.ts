/**
 * Order tools: the MCP server as a ledger client. `create_order` quotes exactly like `quote_inscription`, turns the
 * quote into ledger line items (the commit output plus one line per payee), opens a `psbt` payment intent and hands
 * back the outputs the agent's own wallet must put in the funding transaction. `report_funding` forwards what the
 * agent saw on the network; `get_order` / `get_receipt` read. Nothing here builds, signs, holds or broadcasts
 * anything: the ledger records what the chain shows, and the server never sees a key or a PSBT.
 */
import { createHash } from 'node:crypto';
import { addressToScript, type Network } from '@bsh/inscription';
import { parseNetwork, recipientScriptFor, scriptKind } from './content.js';
import { invalid, ToolError } from './errors.js';
import { LedgerClientError, type LedgerExpectedOutput, type LedgerLineItem, type LedgerOrder, type LedgerPayee, type LedgerPayeeKind, type LedgerPayment, type LedgerPayout, type LedgerReceipt } from './ledger-client.js';
import { PlaneClientError, type PlaneRecord, type PlaneVerdict } from './plane-client.js';
import { quoteInscription, type QuoteResult, type ScribbitMcpPorts } from './tools.js';

export const PAYEE_KINDS: readonly LedgerPayeeKind[] = ['artist', 'club', 'platform', 'other'];
export const MAX_PAYEES = 20;
export const MAX_OBSERVED_OUTPUTS = 1000;
/** How long the quote inside an order is meant to be acted on (informational; stored in the order's metadata). */
export const QUOTE_TTL_MS = 10 * 60_000;
/** Below this many sats a payee share is dust for common wallets (P2PKH threshold; P2TR is 330, P2WPKH 294). */
export const DUST_WARNING_SATS = 546;
export const PRODUCT = 'scribbit';
/** Line item of the commit output: the network cost (reveal fee + postage), paid to the agent's own commit address. */
export const NETWORK_COST_SKU = 'network-cost';
export const COMMIT_PAYEE_REF = 'commit';

const TXID_RE = /^[0-9a-f]{64}$/;
const SCRIPT_HEX_RE = /^([0-9a-f]{2}){1,520}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const requireLedger = (ports: ScribbitMcpPorts) => {
  if (!ports.ledger) throw new ToolError('ledger_unavailable', 'no ledger is configured on this server (MCP_LEDGER_URL); orders are not available, quotes still are');
  return ports.ledger;
};

/** Ledger failures become stable tool errors; the API key never appears in either. */
function ledgerError(e: unknown, what: string): ToolError {
  if (e instanceof LedgerClientError) {
    if (e.status === 0) return new ToolError('ledger_unavailable', `${what}: ${e.message}`);
    if (e.status === 404) return new ToolError('order_not_found', `${what}: ${e.message}`, { code: e.code });
    return new ToolError('ledger_rejected', `${what}: ${e.message}`, { status: e.status, code: e.code, ...(e.requestId ? { requestId: e.requestId } : {}) });
  }
  throw e;
}

const now = (ports: ScribbitMcpPorts) => ports.now?.() ?? new Date();

// ------------------------------------------------------------------------------------------ the authorization plane

/** One payee share an agent's funding transaction pays: what the plane is asked to authorize. */
export interface PayeeSpend {
  kind: string;
  ref: string;
  address: string;
  amountSats: number;
}

export interface PlaneVerdictView {
  payee: { kind: string; ref: string };
  verdict: PlaneVerdict['verdict'];
  decisionId: string;
  impact?: string;
  authorizationId?: string;
  expiresAt?: string;
  replayed?: boolean;
  reasons: string[];
}

/** What the plane said about an order's payee shares (present only when the caller's key is governed by a plane). */
export interface PlaneOutcome {
  org: string;
  agent: string;
  escalated: boolean;
  /** Why a person must decide (ESCALATE verdicts), one line per reason. */
  reasons: string[];
  verdicts: PlaneVerdictView[];
}

/**
 * The plane's Idempotency-Key for one share of one order: create_order and report_funding derive the same key from
 * the same facts, so report_funding re-reads the verdict create_order got (after a person approved it, say) instead
 * of reserving the budget twice.
 */
export function planeIdempotencyKey(network: string, context: { contentSha256?: string | undefined; commitAddress?: string | undefined }, s: PayeeSpend): string {
  const facts = [network, context.contentSha256 ?? '', context.commitAddress ?? '', s.kind, s.ref, s.address.toLowerCase(), String(s.amountSats)].join('\n');
  return `scribbit-mcp:${createHash('sha256').update(facts).digest('hex')}`;
}

/**
 * Asks the plane to authorize every payee share, in order. DENY (or a plane that cannot answer: fail closed) is a
 * `plane_denied` error and nothing reaches the ledger; ESCALATE is reported, not refused. Undefined when no plane is
 * configured or the caller's key is not mapped to a plane agent.
 */
export async function planeCheck(ports: ScribbitMcpPorts, network: Network, spends: readonly PayeeSpend[], context: { contentSha256?: string | undefined; commitAddress?: string | undefined }, tool: string): Promise<PlaneOutcome | undefined> {
  const plane = ports.plane;
  if (!plane || spends.length === 0) return undefined;
  const agent = plane.agentFor(ports.ownerId);
  if (!agent) return undefined;
  const raw: Record<string, unknown> = { source: 'scribbit-mcp' };
  if (context.contentSha256) raw.contentSha256 = context.contentSha256;
  if (context.commitAddress) raw.commitAddress = context.commitAddress;
  const verdicts: PlaneVerdictView[] = [];
  const reasons: string[] = [];
  for (const s of spends) {
    const payee = { kind: s.kind, ref: s.ref };
    const record: PlaneRecord = { kind: 'transfer', chain: `btc:${network}`, asset: 'native', amount: String(s.amountSats), destination: s.address.toLowerCase(), payee, raw };
    let v: PlaneVerdict;
    try {
      v = await plane.propose(agent, record, planeIdempotencyKey(network, context, s));
    } catch (e) {
      if (e instanceof PlaneClientError)
        throw new ToolError('plane_denied', `${tool}: the authorization plane did not authorize paying ${s.amountSats} sats to ${s.kind}:${s.ref} (${e.code}: ${e.message}); nothing was sent to the ledger`, { code: e.code, status: e.status, payee, agent: agent.agent });
      throw e;
    }
    if (v.verdict === 'DENY')
      throw new ToolError('plane_denied', `${tool}: the authorization plane denied paying ${s.amountSats} sats to ${s.kind}:${s.ref}: ${v.reason ?? v.code ?? 'denied'}; nothing was sent to the ledger`, { code: v.code, reasons: v.reasons, decisionId: v.decisionId, payee, agent: agent.agent });
    verdicts.push({
      payee,
      verdict: v.verdict,
      decisionId: v.decisionId,
      reasons: v.reasons,
      ...(v.impact !== undefined ? { impact: v.impact } : {}),
      ...(v.authorization ? { authorizationId: v.authorization.id, expiresAt: v.authorization.expiresAt } : {}),
      ...(v.replayed ? { replayed: true } : {}),
    });
    if (v.verdict === 'ESCALATE') for (const r of v.reasons) reasons.push(`${s.kind}:${s.ref} (${v.decisionId}): ${r}`);
  }
  return { org: plane.org, agent: agent.agent, escalated: verdicts.some((v) => v.verdict === 'ESCALATE'), reasons, verdicts };
}

const escalatedNext = (o: PlaneOutcome): string =>
  `ESCALATED: a person must approve decision(s) ${o.verdicts.filter((v) => v.verdict === 'ESCALATE').map((v) => v.decisionId).join(', ')} on the authorization plane (${o.org}) before these payee shares may be paid. `;

// ------------------------------------------------------------------------------------------ create_order

export interface PayeeInput {
  kind: string;
  ref: string;
  address: string;
  /** Basis points of `mintPriceSats` this payee receives (1..10000; all payees together at most 10000). */
  bps: number;
}

export interface CreateOrderInput {
  network?: string | undefined;
  contentType: string;
  contentSha256: string;
  contentLength: number;
  parentId?: string | undefined;
  recipientAddress: string;
  /** From `commit_address`: the funding transaction must carry this output with the quoted commit value. */
  commitAddress: string;
  feeRate?: number | undefined;
  tier?: string | undefined;
  postage?: number | undefined;
  /** The price the payees' basis points apply to. Required when `payees` is non-empty. */
  mintPriceSats?: number | undefined;
  payees?: PayeeInput[] | undefined;
  /** Forwarded to the ledger so a retried call returns the same order and payment instead of creating new ones. */
  idempotencyKey?: string | undefined;
}

export interface ExpectedOutputView {
  scriptHex: string;
  address?: string;
  valueSats: number;
  payee: { kind: LedgerPayeeKind; ref: string };
}

export interface CreateOrderResult extends Record<string, unknown> {
  orderId: string;
  paymentId: string;
  status: { order: LedgerOrder['status']; payment: LedgerPayment['status'] };
  network: Network;
  contentType: string;
  contentSha256: string;
  contentLength: number;
  parentId: string | null;
  recipientAddress: string;
  commitAddress: string;
  commitValueSats: number;
  mintPriceSats: number;
  payeeSats: number;
  totalSats: number;
  expectedOutputs: ExpectedOutputView[];
  lineItems: LedgerLineItem[];
  quote: QuoteResult;
  quoteExpiresAt: string;
  expiresAt: string | null;
  warnings: string[];
  next: string;
  /** Present when the caller's key is governed by the authorization plane. */
  escalated?: boolean;
  plane?: PlaneOutcome;
}

const outputView = (o: LedgerExpectedOutput): ExpectedOutputView => ({
  scriptHex: o.scriptHex,
  ...(o.address !== undefined ? { address: o.address } : {}),
  valueSats: o.valueSats,
  payee: { kind: o.payee.kind, ref: o.payee.ref },
});

export function validatePayees(raw: PayeeInput[] | undefined, network: Network, mintPriceSats: number | undefined): { payees: Array<PayeeInput & { kind: LedgerPayeeKind; shareSats: number }>; warnings: string[] } {
  const list = raw ?? [];
  if (list.length > MAX_PAYEES) throw invalid(`at most ${MAX_PAYEES} payees`, { field: 'payees' });
  if (list.length > 0 && mintPriceSats === undefined) throw invalid('mintPriceSats is required when payees are given (their bps apply to it)', { field: 'mintPriceSats' });
  const warnings: string[] = [];
  let totalBps = 0;
  const payees = list.map((p, i) => {
    const at = `payees[${i}]`;
    if (!(PAYEE_KINDS as readonly string[]).includes(p.kind)) throw invalid(`${at}.kind must be one of ${PAYEE_KINDS.join(', ')}`, { field: at });
    if (typeof p.ref !== 'string' || p.ref.length < 1 || p.ref.length > 128) throw invalid(`${at}.ref must be 1..128 characters`, { field: at });
    if (p.ref === COMMIT_PAYEE_REF && p.kind === 'platform') throw invalid(`${at}: platform/${COMMIT_PAYEE_REF} is reserved for the commit output`, { field: at });
    if (!Number.isInteger(p.bps) || p.bps < 1 || p.bps > 10_000) throw invalid(`${at}.bps must be an integer in 1..10000`, { field: at });
    totalBps += p.bps;
    if (totalBps > 10_000) throw invalid('payees.bps add up to more than 10000 (100 %)', { field: 'payees' });
    try {
      addressToScript(p.address.trim(), network);
    } catch (e) {
      throw invalid(`${at}.address is not valid on ${network}: ${(e as Error).message}`, { field: at });
    }
    const shareSats = Math.floor(((mintPriceSats ?? 0) * p.bps) / 10_000);
    if (shareSats < 1) throw invalid(`${at}: ${p.bps} bps of ${mintPriceSats} sats rounds to 0 sats; raise mintPriceSats or bps, or drop the payee`, { field: at });
    if (shareSats < DUST_WARNING_SATS) warnings.push(`payee ${p.kind}:${p.ref} receives ${shareSats} sats, below ${DUST_WARNING_SATS}; some wallets refuse outputs that small`);
    return { ...p, kind: p.kind as LedgerPayeeKind, address: p.address.trim(), shareSats };
  });
  return { payees, warnings };
}

export async function createOrder(input: CreateOrderInput, ports: ScribbitMcpPorts): Promise<CreateOrderResult> {
  const ledger = requireLedger(ports);
  const network = parseNetwork(input.network);
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_RE.test(input.idempotencyKey)) throw invalid('idempotencyKey must match [A-Za-z0-9._:-]{1,128}', { field: 'idempotencyKey' });
  if (input.mintPriceSats !== undefined && (!Number.isSafeInteger(input.mintPriceSats) || input.mintPriceSats < 0)) throw invalid('mintPriceSats must be a whole number of sats', { field: 'mintPriceSats' });
  recipientScriptFor(input.recipientAddress, network); // throws invalid_input with the field
  let commitScript: Uint8Array;
  try {
    commitScript = addressToScript(input.commitAddress.trim(), network);
  } catch (e) {
    throw invalid(`invalid commitAddress for ${network}: ${(e as Error).message}`, { field: 'commitAddress' });
  }
  if (scriptKind(commitScript) !== 'p2tr') throw invalid('commitAddress must be a P2TR address (from commit_address: the reveal is a taproot script-path spend)', { field: 'commitAddress' });
  const { payees, warnings: payeeWarnings } = validatePayees(input.payees, network, input.mintPriceSats);

  const quote = await quoteInscription(
    {
      network,
      contentType: input.contentType,
      contentLength: input.contentLength,
      contentSha256: input.contentSha256,
      parentId: input.parentId,
      feeRate: input.feeRate,
      tier: input.tier,
      recipientAddress: input.recipientAddress,
      postage: input.postage,
    },
    ports,
  );
  const commitValueSats = quote.fees.commitValue;
  const commitAddress = input.commitAddress.trim();
  const contentSha256 = quote.contentSha256 ?? input.contentSha256.trim().toLowerCase();
  // Before anything reaches the ledger: a governed agent's payee shares go through the plane's five checks.
  const plane = await planeCheck(ports, network, payees.map((p) => ({ kind: p.kind, ref: p.ref, address: p.address, amountSats: p.shareSats })), { contentSha256, commitAddress }, 'create_order');
  const lineItems: LedgerLineItem[] = [
    {
      sku: NETWORK_COST_SKU,
      description: `Network cost: reveal fee ${quote.fees.revealFee} + postage ${quote.fees.postage} sats (${quote.reveal.lane} lane, ${quote.feeRate} sat/vB), funded at the commit address`,
      quantity: 1,
      unitSats: commitValueSats,
      payee: { kind: 'platform', ref: COMMIT_PAYEE_REF, address: commitAddress },
    },
    ...payees.map((p) => ({
      sku: `share:${p.kind}:${p.ref}`.slice(0, 128),
      description: `${p.kind} ${p.ref}: ${p.bps} bps of ${input.mintPriceSats} sats`.slice(0, 512),
      quantity: 1,
      unitSats: p.shareSats,
      payee: { kind: p.kind, ref: p.ref, address: p.address } as LedgerPayee,
    })),
  ];
  const t = now(ports);
  const quoteExpiresAt = new Date(t.getTime() + QUOTE_TTL_MS).toISOString();
  const metadata: Record<string, string> = {
    contentSha256,
    contentType: quote.contentType,
    contentLength: String(input.contentLength),
    network,
    quoteExpiresAt,
    feeRate: String(quote.feeRate),
    lane: String(quote.reveal.lane),
    commitAddress,
    recipientAddress: input.recipientAddress.trim(),
    ...(quote.parentId ? { parentId: quote.parentId } : {}),
  };

  let order: LedgerOrder;
  try {
    order = await ledger.createOrder({ product: PRODUCT, customerRef: input.recipientAddress.trim(), lineItems, metadata }, input.idempotencyKey);
  } catch (e) {
    throw ledgerError(e, 'creating the order');
  }
  let payment: LedgerPayment;
  try {
    payment = await ledger.createPayment(order.id, { method: 'psbt' }, input.idempotencyKey);
  } catch (e) {
    throw ledgerError(e, `opening the psbt payment for order ${order.id}`);
  }
  const expected = (payment.checkout.outputs ?? []).map(outputView);
  const payeeSats = payees.reduce((s, p) => s + p.shareSats, 0);
  return {
    orderId: order.id,
    paymentId: payment.id,
    // Opening the intent moves a `created` order to `awaiting_payment` (the ledger does this on POST /payments).
    status: { order: order.status === 'created' ? 'awaiting_payment' : order.status, payment: payment.status },
    network,
    contentType: quote.contentType,
    contentSha256: metadata.contentSha256!,
    contentLength: input.contentLength,
    parentId: quote.parentId,
    recipientAddress: input.recipientAddress.trim(),
    commitAddress,
    commitValueSats,
    mintPriceSats: input.mintPriceSats ?? 0,
    payeeSats,
    totalSats: order.totalSats,
    expectedOutputs: expected,
    lineItems: order.lineItems,
    quote,
    quoteExpiresAt,
    expiresAt: payment.expiresAt,
    // The order is size-only by design (the bytes were committed by commit_address); that quote warning does not apply.
    warnings: [...quote.warnings.filter((w) => !w.startsWith('size-only quote')), ...payeeWarnings],
    ...(plane ? { escalated: plane.escalated, plane } : {}),
    next: `${plane?.escalated ? escalatedNext(plane) : ''}Build a funding PSBT in your own wallet that pays every expectedOutput exactly (scriptHex and valueSats; ${commitValueSats} sats to the commit address ${commitAddress}), sign and broadcast it yourself, then call report_funding with the txid and every output. Then build the half-signed reveal with @bsh/inscription and hand it to the scribb.it mint service. Nothing here has moved funds.`,
  };
}

// ------------------------------------------------------------------------------------------ get_order

export interface GetOrderInput {
  orderId: string;
}

export interface PaymentView {
  id: string;
  method: string;
  status: LedgerPayment['status'];
  amountSats: number;
  amountPaidSats: number;
  refundedSats: number;
  expiresAt: string | null;
  paidAt: string | null;
  txid: string | null;
  expectedOutputs: ExpectedOutputView[];
  createdAt: string;
}

export interface PayoutView {
  id: string;
  paymentId: string;
  payee: { kind: LedgerPayeeKind; ref: string; address?: string; scriptHex?: string };
  amountSats: number;
  txid: string;
  vout: number;
  status: LedgerPayout['status'];
  settledAt: string | null;
}

export interface GetOrderResult extends Record<string, unknown> {
  orderId: string;
  status: { order: LedgerOrder['status']; payment: LedgerPayment['status'] | null };
  order: Pick<LedgerOrder, 'id' | 'product' | 'customerRef' | 'status' | 'totalSats' | 'lineItems' | 'metadata' | 'createdAt' | 'updatedAt'>;
  payment: PaymentView | null;
  payments: PaymentView[];
  payouts: PayoutView[];
}

const paymentView = (p: LedgerPayment): PaymentView => ({
  id: p.id,
  method: p.method,
  status: p.status,
  amountSats: p.amountSats,
  amountPaidSats: p.amountPaidSats,
  refundedSats: p.refundedSats,
  expiresAt: p.expiresAt,
  paidAt: p.paidAt,
  txid: p.txid ?? null,
  expectedOutputs: (p.checkout.outputs ?? []).map(outputView),
  createdAt: p.createdAt,
});

const payoutView = (x: LedgerPayout): PayoutView => ({ id: x.id, paymentId: x.paymentId, payee: { ...x.payee }, amountSats: x.amountSats, txid: x.txid, vout: x.vout, status: x.status, settledAt: x.settledAt });

const validateOrderId = (id: string): string => {
  const v = id.trim();
  if (!/^ord_[A-Za-z0-9-]+$/.test(v)) throw invalid('orderId must look like ord_…', { field: 'orderId' });
  return v;
};

/** The intent that matters now: an open one (created / pending / underpaid), else the most recent. */
export function currentPayment(payments: readonly LedgerPayment[]): LedgerPayment | undefined {
  const open = payments.filter((p) => p.status === 'created' || p.status === 'pending' || p.status === 'underpaid');
  return open.at(-1) ?? payments.at(-1);
}

export async function getOrder(input: GetOrderInput, ports: ScribbitMcpPorts): Promise<GetOrderResult> {
  const ledger = requireLedger(ports);
  const orderId = validateOrderId(input.orderId);
  let order: LedgerOrder;
  let payments: LedgerPayment[];
  let payouts: LedgerPayout[];
  try {
    order = await ledger.getOrder(orderId);
    [payments, payouts] = await Promise.all([ledger.listPayments(orderId), ledger.listPayouts(orderId)]);
  } catch (e) {
    throw ledgerError(e, `reading order ${orderId}`);
  }
  const current = currentPayment(payments);
  return {
    orderId,
    status: { order: order.status, payment: current?.status ?? null },
    order: { id: order.id, product: order.product, customerRef: order.customerRef, status: order.status, totalSats: order.totalSats, lineItems: order.lineItems, metadata: order.metadata, createdAt: order.createdAt, updatedAt: order.updatedAt },
    payment: current ? paymentView(current) : null,
    payments: payments.map(paymentView),
    payouts: payouts.map(payoutView),
  };
}

// ------------------------------------------------------------------------------------------ report_funding

export interface ReportFundingInput {
  orderId: string;
  /** Defaults to the order's open intent. */
  paymentId?: string | undefined;
  txid: string;
  outputs: Array<{ scriptHex: string; valueSats: number }>;
  confirmations?: number | undefined;
  rbfSignalled?: boolean | undefined;
}

export interface ReportFundingResult extends Record<string, unknown> {
  orderId: string;
  paymentId: string;
  txid: string;
  applied: boolean;
  reason: string | null;
  status: { order: LedgerOrder['status']; payment: LedgerPayment['status'] };
  amountSats: number;
  amountPaidSats: number;
  confirmations: number;
  expectedOutputs: ExpectedOutputView[];
  settlements: unknown[] | null;
  payouts: PayoutView[];
  next: string;
  /** Present when the caller's key is governed by the authorization plane. */
  escalated?: boolean;
  plane?: PlaneOutcome;
}

export function validateObservation(input: Pick<ReportFundingInput, 'txid' | 'outputs' | 'confirmations' | 'rbfSignalled'>): { txid: string; outputs: Array<{ scriptHex: string; valueSats: number }>; confirmations: number; rbfSignalled: boolean } {
  const txid = input.txid.trim().toLowerCase();
  if (!TXID_RE.test(txid)) throw invalid('txid must be 64 hex characters', { field: 'txid' });
  if (!Array.isArray(input.outputs) || input.outputs.length === 0 || input.outputs.length > MAX_OBSERVED_OUTPUTS) throw invalid(`outputs must hold 1..${MAX_OBSERVED_OUTPUTS} entries (every output of the transaction, in vout order)`, { field: 'outputs' });
  const outputs = input.outputs.map((o, i) => {
    const scriptHex = String(o.scriptHex ?? '').trim().toLowerCase();
    if (!SCRIPT_HEX_RE.test(scriptHex)) throw invalid(`outputs[${i}].scriptHex must be a scriptPubKey in hex (1..520 bytes)`, { field: `outputs[${i}]` });
    if (!Number.isSafeInteger(o.valueSats) || o.valueSats < 0) throw invalid(`outputs[${i}].valueSats must be a whole number of sats`, { field: `outputs[${i}]` });
    return { scriptHex, valueSats: o.valueSats };
  });
  const confirmations = input.confirmations ?? 0;
  if (!Number.isInteger(confirmations) || confirmations < 0) throw invalid('confirmations must be a non-negative integer', { field: 'confirmations' });
  const rbfSignalled = input.rbfSignalled ?? false;
  if (typeof rbfSignalled !== 'boolean') throw invalid('rbfSignalled must be a boolean', { field: 'rbfSignalled' });
  return { txid, outputs, confirmations, rbfSignalled };
}

function nextAfterFunding(status: LedgerPayment['status'], reason: string | undefined, detail: unknown): string {
  if (reason) return `Nothing changed: ${reason}. Check that you reported the transaction that pays this order's expectedOutputs (compare scriptHex, not addresses).`;
  switch (status) {
    case 'pending':
      return 'Seen but not yet credited (unconfirmed, replaceable, or below the confirmation policy). Report again once it has confirmations >= the policy; then hand the half-signed reveal to the scribb.it mint service.';
    case 'paid':
    case 'overpaid':
      return 'Funding is credited and payouts are recorded. Build the half-signed reveal with @bsh/inscription (buildHalfSignedReveal, commit outpoint = this txid : the commit output index) and hand it to the scribb.it mint service; call get_receipt for the receipt.';
    case 'underpaid':
      return `The transaction is short${typeof detail === 'string' ? `: ${detail}` : ''}. Send a second transaction carrying every missing output at its full value and report it; the order settles once a single transaction carries all of them.`;
    default:
      return `Payment is ${status}. Call get_order for the current state.`;
  }
}

export async function reportFunding(input: ReportFundingInput, ports: ScribbitMcpPorts): Promise<ReportFundingResult> {
  const ledger = requireLedger(ports);
  const orderId = validateOrderId(input.orderId);
  const obs = validateObservation(input);
  let payment: LedgerPayment | undefined;
  try {
    if (input.paymentId !== undefined) {
      const pid = input.paymentId.trim();
      if (!/^pay_[A-Za-z0-9-]+$/.test(pid)) throw invalid('paymentId must look like pay_…', { field: 'paymentId' });
      payment = await ledger.getPayment(pid);
      if (payment.orderId !== orderId) throw invalid(`payment ${pid} belongs to order ${payment.orderId}, not ${orderId}`, { field: 'paymentId' });
    } else {
      payment = currentPayment(await ledger.listPayments(orderId));
      if (!payment) {
        await ledger.getOrder(orderId); // 404 → order_not_found; otherwise the order simply has no intent
        throw new ToolError('ledger_rejected', `order ${orderId} has no payment intent to fund`, { code: 'no_payment' });
      }
    }
  } catch (e) {
    throw ledgerError(e, `finding the payment of order ${orderId}`);
  }
  if (payment.method !== 'psbt') throw new ToolError('ledger_rejected', `payment ${payment.id} is a ${payment.method} payment; only psbt payments are settled by reporting a transaction`, { code: 'not_observable' });
  // A governed agent reporting that it funded an order: the plane re-reads (same Idempotency-Key) or decides the
  // payee shares; a DENY stops the report before it reaches the ledger.
  let plane: PlaneOutcome | undefined;
  if (ports.plane?.agentFor(ports.ownerId)) {
    let order: LedgerOrder;
    try {
      order = await ledger.getOrder(orderId);
    } catch (e) {
      throw ledgerError(e, `reading order ${orderId}`);
    }
    const spends = order.lineItems
      .filter((li) => li.sku.startsWith('share:') && li.payee?.address)
      .map((li) => ({ kind: li.payee!.kind, ref: li.payee!.ref, address: li.payee!.address!, amountSats: li.unitSats * li.quantity }));
    plane = await planeCheck(ports, parseNetwork(order.metadata.network), spends, { contentSha256: order.metadata.contentSha256, commitAddress: order.metadata.commitAddress }, 'report_funding');
  }
  let res: Awaited<ReturnType<typeof ledger.observe>>;
  try {
    res = await ledger.observe(payment.id, obs);
  } catch (e) {
    throw ledgerError(e, `reporting ${obs.txid} for payment ${payment.id}`);
  }
  const detail = (res.payment.providerData as { settlements?: unknown[] } | undefined)?.settlements;
  const shortDetail = res.payment.status === 'underpaid' && Array.isArray(detail) ? detail.filter((s) => s && typeof s === 'object' && (s as { satisfied?: boolean }).satisfied === false).map((s) => { const x = s as { payee?: { kind?: string; ref?: string }; observedSats?: number; expectedSats?: number }; return `${x.payee?.kind}:${x.payee?.ref} ${x.observedSats}/${x.expectedSats}`; }).join(', ') : undefined;
  return {
    orderId,
    paymentId: res.payment.id,
    txid: obs.txid,
    applied: res.applied,
    reason: res.reason ?? null,
    status: { order: res.order.status, payment: res.payment.status },
    amountSats: res.payment.amountSats,
    amountPaidSats: res.payment.amountPaidSats,
    confirmations: obs.confirmations,
    expectedOutputs: (res.payment.checkout.outputs ?? []).map(outputView),
    settlements: Array.isArray(detail) ? detail : null,
    payouts: res.payouts.map(payoutView),
    ...(plane ? { escalated: plane.escalated, plane } : {}),
    next: `${plane?.escalated ? escalatedNext(plane) : ''}${nextAfterFunding(res.payment.status, res.reason, shortDetail)}`,
  };
}

// ------------------------------------------------------------------------------------------ get_receipt

export interface GetReceiptInput {
  orderId: string;
}

export interface GetReceiptResult extends Record<string, unknown> {
  orderId: string;
  receipt: LedgerReceipt;
  text: string;
}

export async function getReceipt(input: GetReceiptInput, ports: ScribbitMcpPorts): Promise<GetReceiptResult> {
  const ledger = requireLedger(ports);
  const orderId = validateOrderId(input.orderId);
  try {
    const [receipt, text] = await Promise.all([ledger.getReceipt(orderId), ledger.getReceiptText(orderId)]);
    return { orderId, receipt, text };
  } catch (e) {
    throw ledgerError(e, `reading the receipt of order ${orderId}`);
  }
}
