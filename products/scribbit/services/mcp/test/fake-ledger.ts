/**
 * An in-memory ledger for the order tools' tests. It speaks the ledger's HTTP contract (contracts/openapi/ledger.yaml)
 * over an injected `fetch`, mirrors the psbt provider's rules (every line item needs a payee, expected outputs summed
 * per script, paid / underpaid / pending evaluation, payouts recorded once, one txid settles one intent) and validates
 * EVERY body it returns against the contract with ajv, so the fake cannot drift from the real service either.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { addressToScript, type Network } from '@bsh/inscription';
import type { FetchLike, LedgerLineItem, LedgerOrder, LedgerPayment, LedgerPayout, LedgerReceipt } from '../src/index.js';

const contractPath = fileURLToPath(new URL('../../../../../contracts/openapi/ledger.yaml', import.meta.url));
export const ledgerContract = parse(readFileSync(contractPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(ledgerContract, 'ledger');

export function assertLedgerSchema(name: string, value: unknown): void {
  const v = ajv.getSchema(`ledger#/components/schemas/${name}`);
  if (!v) throw new Error(`no schema ${name} in ledger.yaml`);
  if (!v(value)) throw new Error(`fake ledger: ${name} contract violation: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value, null, 2)}`);
}

export interface FakeRequest {
  method: string;
  path: string;
  auth: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class FakeLedger {
  readonly baseUrl = 'https://ledger.test';
  readonly requests: FakeRequest[] = [];
  readonly orders = new Map<string, LedgerOrder>();
  readonly payments = new Map<string, LedgerPayment>();
  readonly payouts: LedgerPayout[] = [];
  private readonly idem = new Map<string, { fingerprint: string; id: string }>();
  private seq = 0;
  /** Set to make every request fail at the network level (the client reports `ledger_unavailable`). */
  down = false;
  /** Queue an error answer for the next request: `{ status, code, message }`. */
  failNext: { status: number; code: string; message: string } | undefined;
  now = () => new Date('2026-09-24T10:00:00.000Z');
  policy = { confirmations: 1 };

  constructor(
    readonly apiKey = 'bsh_test_ledgerkey',
    readonly network: Network = 'regtest',
    readonly product = 'scribbit',
  ) {}

  readonly fetch: FetchLike = async (url, init = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: u.pathname + u.search, auth: headers.get('authorization'), idempotencyKey: headers.get('idempotency-key'), body });
    if (this.down) throw new TypeError('fetch failed: ECONNREFUSED');
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = undefined;
      return this.error(f.status, f.code, f.message);
    }
    if (headers.get('authorization') !== `Bearer ${this.apiKey}`) return this.error(401, 'invalid_api_key', 'Invalid API key');
    try {
      return this.route(method, u.pathname, u.searchParams, headers, body);
    } catch (e) {
      if (e instanceof FakeLedgerError) return this.error(e.status, e.code, e.message);
      throw e;
    }
  };

  private error(status: number, code: string, message: string): Response {
    const body = { error: { code, message, requestId: `req_${++this.seq}` } };
    assertLedgerSchema('Error', body);
    return json(body, status);
  }

  private route(method: string, path: string, query: URLSearchParams, headers: Headers, body: unknown): Response {
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/v1/orders') return this.createOrder(body, headers.get('idempotency-key'));
    if ((m = /^\/v1\/orders\/([^/]+)$/.exec(path)) && method === 'GET') return this.ok('Order', this.order(m[1]!));
    if ((m = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path))) {
      if (method === 'POST') return this.createPayment(m[1]!, body, headers.get('idempotency-key'));
      const order = this.order(m[1]!);
      const payments = [...this.payments.values()].filter((p) => p.orderId === order.id);
      payments.forEach((p) => assertLedgerSchema('PaymentIntent', p));
      return json({ payments });
    }
    if ((m = /^\/v1\/orders\/([^/]+)\/payouts$/.exec(path)) && method === 'GET') return this.ok('PayoutList', { payouts: this.payouts.filter((p) => p.orderId === this.order(m![1]!).id) });
    if ((m = /^\/v1\/orders\/([^/]+)\/receipt$/.exec(path)) && method === 'GET') {
      const receipt = this.receipt(this.order(m[1]!));
      if (query.get('format') === 'text' || /^text\/plain/.test(headers.get('accept') ?? '')) return new Response(renderText(receipt), { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return this.ok('Receipt', receipt);
    }
    if ((m = /^\/v1\/payments\/([^/]+)$/.exec(path)) && method === 'GET') return this.ok('PaymentIntent', this.payment(m[1]!));
    if ((m = /^\/v1\/payments\/([^/]+)\/observations$/.exec(path)) && method === 'POST') return this.observe(m[1]!, body);
    throw new FakeLedgerError(404, 'not_found', `no route ${method} ${path}`);
  }

  private ok(schema: string, value: unknown): Response {
    assertLedgerSchema(schema, value);
    return json(value);
  }

  private order(id: string): LedgerOrder {
    const o = this.orders.get(id);
    if (!o || o.product !== this.product) throw new FakeLedgerError(404, 'not_found', `order ${id} not found`);
    return o;
  }

  private payment(id: string): LedgerPayment {
    const p = this.payments.get(id);
    if (!p) throw new FakeLedgerError(404, 'not_found', `payment ${id} not found`);
    return p;
  }

  private createOrder(raw: unknown, idem: string | null): Response {
    assertLedgerSchema('CreateOrderRequest', raw);
    const body = raw as { product?: string; customerRef: string; lineItems: LedgerLineItem[]; metadata?: Record<string, string> };
    const product = body.product ?? this.product;
    if (product !== this.product) throw new FakeLedgerError(403, 'product_mismatch', `key belongs to ${this.product}`);
    const fp = JSON.stringify(body);
    if (idem) {
      const hit = this.idem.get(`order:${idem}`);
      if (hit) {
        if (hit.fingerprint !== fp) throw new FakeLedgerError(422, 'idempotency_conflict', 'Idempotency-Key reused with a different request');
        return this.ok('Order', this.orders.get(hit.id));
      }
    }
    for (const li of body.lineItems) {
      if (li.payee?.address) {
        try {
          addressToScript(li.payee.address, this.network);
        } catch (e) {
          throw new FakeLedgerError(400, 'invalid_payee_address', `payee address "${li.payee.address}" is not valid on ${this.network}: ${(e as Error).message}`);
        }
      }
    }
    const at = this.now().toISOString();
    const order: LedgerOrder = {
      id: `ord_${String(++this.seq).padStart(4, '0')}`,
      product: product as LedgerOrder['product'],
      customerRef: body.customerRef,
      lineItems: body.lineItems,
      currency: 'sat',
      totalSats: body.lineItems.reduce((s, li) => s + li.quantity * li.unitSats, 0),
      status: 'created',
      metadata: body.metadata ?? {},
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.orders.set(order.id, order);
    if (idem) this.idem.set(`order:${idem}`, { fingerprint: fp, id: order.id });
    assertLedgerSchema('Order', order);
    return json(order, 201);
  }

  scriptOf(payee: { address?: string; scriptHex?: string }): string {
    if (payee.scriptHex) return payee.scriptHex.toLowerCase();
    return toHex(addressToScript(payee.address!, this.network));
  }

  private createPayment(orderId: string, raw: unknown, idem: string | null): Response {
    assertLedgerSchema('CreatePaymentRequest', raw);
    const order = this.order(orderId);
    const body = raw as { method: string };
    if (body.method !== 'psbt') throw new FakeLedgerError(400, 'method_unavailable', `no provider serves ${body.method}`);
    if (idem) {
      const hit = this.idem.get(`payment:${order.id}:${idem}`);
      if (hit) return this.ok('PaymentIntent', this.payments.get(hit.id));
    }
    if (order.status !== 'created' && order.status !== 'awaiting_payment') throw new FakeLedgerError(409, 'order_not_payable', `order is ${order.status}`);
    const active = [...this.payments.values()].find((p) => p.orderId === order.id && (p.status === 'created' || p.status === 'pending'));
    if (active) throw new FakeLedgerError(409, 'payment_active', `payment ${active.id} is still ${active.status}`);
    const missing = order.lineItems.filter((li) => !li.payee);
    if (missing.length) throw new FakeLedgerError(409, 'payee_required', `psbt payments need a payee on every line item (missing on ${missing.map((l) => l.sku).join(', ')})`);
    const byScript = new Map<string, { scriptHex: string; valueSats: number; address?: string; payee: NonNullable<LedgerLineItem['payee']> }>();
    for (const li of order.lineItems) {
      const scriptHex = this.scriptOf(li.payee!);
      const cur = byScript.get(scriptHex);
      if (cur) cur.valueSats += li.quantity * li.unitSats;
      else byScript.set(scriptHex, { scriptHex, valueSats: li.quantity * li.unitSats, ...(li.payee!.address ? { address: li.payee!.address } : {}), payee: { ...li.payee! } });
    }
    const outputs = [...byScript.values()];
    const at = this.now().toISOString();
    const payment: LedgerPayment = {
      id: `pay_${String(++this.seq).padStart(4, '0')}`,
      orderId: order.id,
      product: order.product,
      method: 'psbt',
      provider: 'psbt',
      providerRef: '',
      amountSats: order.totalSats,
      amountPaidSats: 0,
      refundedSats: 0,
      status: 'created',
      checkout: { outputs },
      expiresAt: new Date(this.now().getTime() + 60 * 60_000).toISOString(),
      paidAt: null,
      providerData: { network: this.network, expectedOutputs: outputs },
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    payment.providerRef = payment.id;
    this.payments.set(payment.id, payment);
    if (idem) this.idem.set(`payment:${order.id}:${idem}`, { fingerprint: '', id: payment.id });
    if (order.status === 'created') order.status = 'awaiting_payment';
    assertLedgerSchema('PaymentIntent', payment);
    return json(payment, 201);
  }

  private observe(paymentId: string, raw: unknown): Response {
    assertLedgerSchema('ObservationRequest', raw);
    const payment = this.payment(paymentId);
    const order = this.order(payment.orderId);
    const tx = raw as { txid: string; outputs: Array<{ scriptHex: string; valueSats: number }>; confirmations?: number; rbfSignalled?: boolean };
    const txid = tx.txid.toLowerCase();
    const confirmations = tx.confirmations ?? 0;
    const expected = payment.checkout.outputs ?? [];
    const settlements = expected.map((e) => {
      let observedSats = 0;
      const vouts: number[] = [];
      tx.outputs.forEach((o, vout) => {
        if (o.scriptHex.toLowerCase() !== e.scriptHex) return;
        observedSats += o.valueSats;
        vouts.push(vout);
      });
      return { payee: { kind: e.payee.kind, ref: e.payee.ref }, scriptHex: e.scriptHex, expectedSats: e.valueSats, observedSats, vouts, satisfied: observedSats >= e.valueSats };
    });
    const observedSats = settlements.reduce((s, x) => s + x.observedSats, 0);
    const result = (applied: boolean, reason?: string) => {
      const body = { payment, order, applied, ...(reason ? { reason } : {}), payouts: this.payouts.filter((p) => p.paymentId === payment.id) };
      assertLedgerSchema('ObservationResult', body);
      return json(body);
    };
    if (observedSats === 0) return result(false, `transaction ${txid} pays none of the expected outputs`);
    const claimed = [...this.payments.values()].find((p) => p.id !== payment.id && p.txid === txid && p.status !== 'created' && p.status !== 'expired' && p.status !== 'failed');
    if (claimed) return result(false, `txid ${txid} already settles ${claimed.id}`);
    if (payment.status === 'paid' || payment.status === 'overpaid' || payment.status === 'refunded') {
      payment.providerData = { ...payment.providerData, observedTxid: txid, confirmations };
      return result(false, 'no change');
    }
    const at = this.now().toISOString();
    payment.providerData = { ...payment.providerData, observedTxid: txid, confirmations, settlements, expectedSats: expected.reduce((s, e) => s + e.valueSats, 0), observedSats };
    payment.txid = txid;
    payment.updatedAt = at;
    payment.version++;
    if ((confirmations <= 0 && tx.rbfSignalled) || confirmations < this.policy.confirmations) {
      payment.status = 'pending';
      return result(true);
    }
    if (settlements.every((s) => s.satisfied)) {
      payment.status = 'paid';
      payment.amountPaidSats = observedSats;
      payment.paidAt = at;
      for (const s of settlements) {
        if (this.payouts.some((p) => p.paymentId === payment.id && p.txid === txid && p.vout === s.vouts[0])) continue;
        const e = expected.find((x) => x.scriptHex === s.scriptHex)!;
        this.payouts.push({ id: `pyo_${String(++this.seq).padStart(4, '0')}`, orderId: order.id, paymentId: payment.id, product: order.product, payee: { ...e.payee }, amountSats: s.observedSats, txid, vout: s.vouts[0]!, status: 'settled', settledAt: at, version: 0, createdAt: at, updatedAt: at });
      }
      order.status = 'paid';
      order.updatedAt = at;
      return result(true);
    }
    payment.status = 'underpaid';
    payment.amountPaidSats = observedSats;
    return result(true);
  }

  private receipt(order: LedgerOrder): LedgerReceipt {
    const payments = [...this.payments.values()].filter((p) => p.orderId === order.id);
    const payouts = this.payouts.filter((p) => p.orderId === order.id);
    const paidSats = payments.reduce((s, p) => s + p.amountPaidSats, 0);
    return {
      receiptId: `rcpt_${order.id.replace(/^ord_/, '')}`,
      issuedAt: this.now().toISOString(),
      order: { id: order.id, product: order.product, customerRef: order.customerRef, status: order.status, currency: 'sat', totalSats: order.totalSats, lineItems: order.lineItems, createdAt: order.createdAt, metadata: order.metadata },
      payments: payments.map((p) => ({ id: p.id, method: p.method, provider: p.provider, status: p.status, amountSats: p.amountSats, amountPaidSats: p.amountPaidSats, refundedSats: p.refundedSats, paidAt: p.paidAt, ...(p.txid ? { txid: p.txid } : {}), reference: p.providerRef })),
      refunds: [],
      payouts: payouts.map((x) => ({ id: x.id, paymentId: x.paymentId, payee: { ...x.payee }, amountSats: x.amountSats, txid: x.txid, vout: x.vout, status: x.status })),
      totals: { totalSats: order.totalSats, paidSats, refundedSats: 0, dueSats: Math.max(0, order.totalSats - paidSats) },
    };
  }
}

class FakeLedgerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function renderText(r: LedgerReceipt): string {
  const lines = [`RECEIPT ${r.receiptId}`, `Order    ${r.order.id}  (${r.order.product})`, `Status   ${r.order.status}`];
  for (const li of r.order.lineItems) lines.push(`${li.quantity} x ${li.description} [${li.sku}] ${li.quantity * li.unitSats} sat`);
  lines.push(`TOTAL ${r.totals.totalSats} sat`);
  if (r.payouts?.length) {
    lines.push('Payouts');
    for (const x of r.payouts) lines.push(`  ${x.id}  ${x.status}  ${x.amountSats} sat  to ${x.payee.kind}:${x.payee.ref}  txid ${x.txid}:${x.vout}`);
  }
  lines.push(`Paid     ${r.totals.paidSats} sat`, `Due      ${r.totals.dueSats} sat`);
  return lines.join('\n');
}
