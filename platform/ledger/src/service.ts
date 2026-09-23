import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ledgerOrderStatus, ledgerPaymentStatus, sourceFor, type EventBus, type EventEnvelope } from '@bsh/events';
import { ConcurrencyError, LedgerError, invalid, notFound } from './domain/errors.js';
import { assertOrderTransition, assertPaymentTransition, assertRefundTransition, canOrderTransition, canPaymentTransition } from './domain/state.js';
import {
  PAYMENT_METHODS,
  PRODUCTS,
  type LineItem,
  type Order,
  type OrderStatus,
  type PaymentIntent,
  type PaymentMethod,
  type PaymentStatus,
  type Product,
  type Refund,
} from './domain/types.js';
import { assertSats } from './money.js';
import { WebhookError, type PaymentProvider, type ProviderUpdate } from './providers/provider.js';
import type { IdempotencyRecord, OrderStore } from './store/order-store.js';

export interface CreateOrderInput {
  product: Product;
  customerRef: string;
  lineItems: LineItem[];
  metadata?: Record<string, string>;
}

export interface CreatePaymentInput {
  method: PaymentMethod;
  /** Provider adapter name; defaults to the first provider serving the method. */
  provider?: string;
  /** ISO time; provider default when omitted. */
  expiresAt?: string;
}

export interface RefundInput {
  /** Defaults: overpaid → the excess; paid/underpaid → everything credited and not yet refunded. */
  amountSats?: number;
  reason: string;
  /** Required by providers that cannot push funds back on their own (on-chain). */
  destination?: string;
}

/** Who is calling: the product an API key belongs to, or null for internal callers (worker, webhooks). */
export interface CallerContext {
  product: Product | null;
  idempotencyKey?: string;
}

export interface ApplyResult {
  payment: PaymentIntent;
  order: Order;
  /** False when the update was a no-op or an illegal transition that was ignored. */
  applied: boolean;
  reason?: string;
}

export interface WebhookResult {
  received: true;
  duplicate: boolean;
  applied: boolean;
  eventType: string;
  reason?: string;
}

export interface LedgerServiceOptions {
  store: OrderStore;
  providers: readonly PaymentProvider[];
  bus?: EventBus;
  now?: () => Date;
  newId?: () => string;
  /** Provider name per method when several providers serve one method. */
  defaultProvider?: Partial<Record<PaymentMethod, string>>;
  /** CloudEvents source; default `urn:bsh:ledger`. */
  source?: string;
  /** Called when an event cannot be published (state is already persisted). Default: console.error. */
  onPublishError?: (err: unknown, event: EventEnvelope) => void;
  /** Re-fetch provider state after a webhook (trust but verify). Default true. */
  verifyWebhooks?: boolean;
}

const MAX_LINE_ITEMS = 100;
const MAX_METADATA_KEYS = 20;
const MAX_STR = 512;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const fingerprint = (v: unknown): string => bytesToHex(sha256(new TextEncoder().encode(canonical(v))));

/**
 * The ledger's application service. Every state change goes through here: validation, the transition tables,
 * persistence with optimistic concurrency, then events. Providers push in through `applyUpdate` (worker
 * polling) or `handleWebhook`; products call the rest through the API.
 */
export class LedgerService {
  private readonly store: OrderStore;
  private readonly providers: Map<string, PaymentProvider>;
  private readonly bus: EventBus | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly source: string;
  private readonly onPublishError: (err: unknown, event: EventEnvelope) => void;
  private readonly verifyWebhooks: boolean;

  constructor(private readonly opts: LedgerServiceOptions) {
    this.store = opts.store;
    this.providers = new Map(opts.providers.map((p) => [p.name, p]));
    if (this.providers.size !== opts.providers.length) throw new Error('provider names must be unique');
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
    this.source = opts.source ?? sourceFor('ledger');
    this.onPublishError = opts.onPublishError ?? ((err, event) => console.error('ledger: event publish failed', event.type, err));
    this.verifyWebhooks = opts.verifyWebhooks ?? true;
  }

  provider(name: string): PaymentProvider | undefined {
    return this.providers.get(name);
  }

  providerNames(): string[] {
    return [...this.providers.keys()];
  }

  // ------------------------------------------------------------------------------------ orders

  async createOrder(input: CreateOrderInput, ctx: CallerContext): Promise<{ order: Order; created: boolean }> {
    const clean = validateOrderInput(input);
    if (ctx.product && clean.product !== ctx.product) throw new LedgerError(403, 'product_mismatch', `API key belongs to ${ctx.product}, order is for ${clean.product}`);
    const scope = `order:${clean.product}`;
    const fp = fingerprint(clean);
    if (ctx.idempotencyKey) {
      const existing = await this.store.findIdempotency(scope, ctx.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fp) throw new LedgerError(422, 'idempotency_conflict', 'Idempotency-Key reused with a different request');
        const order = await this.store.getOrder(existing.resourceId);
        if (!order) throw notFound('order', existing.resourceId);
        return { order, created: false };
      }
    }
    const at = this.now().toISOString();
    const order: Order = {
      id: `ord_${this.newId()}`,
      product: clean.product,
      customerRef: clean.customerRef,
      lineItems: clean.lineItems,
      currency: 'sat',
      totalSats: clean.lineItems.reduce((s, li) => s + li.quantity * li.unitSats, 0),
      status: 'created',
      metadata: clean.metadata ?? {},
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    assertSats(order.totalSats, 'totalSats');
    const idem = ctx.idempotencyKey ? idemRecord(scope, ctx.idempotencyKey, fp, 'order', order.id) : undefined;
    try {
      await this.store.createOrder(order, idem);
    } catch (e) {
      // Lost a race on the same key: serve the winner.
      if (e instanceof LedgerError && e.code === 'idempotency_conflict' && ctx.idempotencyKey) return this.createOrder(input, ctx);
      throw e;
    }
    await this.emitOrder(order, null);
    return { order, created: true };
  }

  async getOrder(id: string, ctx: CallerContext): Promise<Order> {
    const order = await this.store.getOrder(id);
    if (!order || (ctx.product && order.product !== ctx.product)) throw notFound('order', id);
    return order;
  }

  async cancelOrder(id: string, ctx: CallerContext, detail = 'cancelled by product'): Promise<Order> {
    const order = await this.getOrder(id, ctx);
    if (order.status === 'cancelled') return order;
    assertOrderTransition(order.status, 'cancelled');
    const open = (await this.store.listPaymentsByOrder(order.id)).filter((p) => p.status === 'pending');
    if (open.length > 0) throw new LedgerError(409, 'payment_active', 'a payment is in flight; wait for it to settle or expire');
    return this.transitionOrder(order, 'cancelled', detail);
  }

  // ------------------------------------------------------------------------------------ payments

  async createPayment(orderId: string, input: CreatePaymentInput, ctx: CallerContext): Promise<{ payment: PaymentIntent; created: boolean }> {
    if (!PAYMENT_METHODS.includes(input.method)) throw invalid(`method must be one of ${PAYMENT_METHODS.join(', ')}`);
    if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw invalid('expiresAt must be an ISO date-time');
    const order = await this.getOrder(orderId, ctx);
    const provider = this.pickProvider(input.method, input.provider);
    const scope = `payment:${order.id}`;
    const fp = fingerprint({ method: input.method, provider: provider.name, expiresAt: input.expiresAt ?? null });
    if (ctx.idempotencyKey) {
      // Replays are answered before any state check: the first call may already have settled.
      const existing = await this.store.findIdempotency(scope, ctx.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fp) throw new LedgerError(422, 'idempotency_conflict', 'Idempotency-Key reused with a different request');
        const payment = await this.store.getPayment(existing.resourceId);
        if (!payment) throw notFound('payment', existing.resourceId);
        return { payment, created: false };
      }
    }
    if (order.status !== 'created' && order.status !== 'awaiting_payment') throw new LedgerError(409, 'order_not_payable', `order is ${order.status}`);
    const active = (await this.store.listPaymentsByOrder(order.id)).find((p) => p.status === 'created' || p.status === 'pending');
    if (active) throw new LedgerError(409, 'payment_active', `payment ${active.id} is still ${active.status}`);
    if (order.totalSats === 0) throw new LedgerError(409, 'nothing_to_pay', 'order total is zero');

    const now = this.now();
    const at = now.toISOString();
    const intentId = `pay_${this.newId()}`;
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt && Date.parse(expiresAt) <= now.getTime()) throw invalid('expiresAt is in the past');
    const created = await provider.createIntent({ intentId, order, method: input.method, amountSats: order.totalSats, expiresAt, now });
    const payment: PaymentIntent = {
      id: intentId,
      orderId: order.id,
      product: order.product,
      method: input.method,
      provider: provider.name,
      providerRef: created.providerRef,
      amountSats: order.totalSats,
      amountPaidSats: 0,
      refundedSats: 0,
      status: 'created',
      checkout: created.checkout,
      expiresAt: created.expiresAt,
      paidAt: null,
      providerData: created.providerData ?? {},
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    const idem = ctx.idempotencyKey ? idemRecord(scope, ctx.idempotencyKey, fp, 'payment', payment.id) : undefined;
    await this.store.createPayment(payment, idem);
    if (order.status === 'created') await this.transitionOrder(order, 'awaiting_payment');
    await this.emitPayment(payment, null);
    return { payment, created: true };
  }

  async getPayment(id: string, ctx: CallerContext): Promise<PaymentIntent> {
    const p = await this.store.getPayment(id);
    if (!p || (ctx.product && p.product !== ctx.product)) throw notFound('payment', id);
    return p;
  }

  async listPayments(orderId: string, ctx: CallerContext): Promise<PaymentIntent[]> {
    await this.getOrder(orderId, ctx);
    return this.store.listPaymentsByOrder(orderId);
  }

  /**
   * Apply a provider's view of an intent. Same status → amounts/detail are merged silently (no event).
   * Illegal transitions (e.g. a late webhook for a refunded intent) are ignored, not thrown: providers
   * are not clients we can correct, and refusing would only trigger redeliveries.
   */
  async applyUpdate(paymentId: string, update: ProviderUpdate, detail?: string): Promise<ApplyResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.applyOnce(paymentId, update, detail);
      } catch (e) {
        if (e instanceof ConcurrencyError && attempt < 3) continue;
        throw e;
      }
    }
  }

  private async applyOnce(paymentId: string, update: ProviderUpdate, detail?: string): Promise<ApplyResult> {
    let payment = await this.store.getPayment(paymentId);
    if (!payment) throw notFound('payment', paymentId);
    let order = await this.store.getOrder(payment.orderId);
    if (!order) throw notFound('order', payment.orderId);
    const previous = payment.status;
    const next = update.status;
    const changesStatus = next !== previous;
    if (changesStatus && !canPaymentTransition(previous, next)) return { payment, order, applied: false, reason: `illegal transition ${previous} -> ${next}` };

    const at = this.now().toISOString();
    const merged: PaymentIntent = { ...payment, status: next, updatedAt: at };
    if (update.amountPaidSats !== undefined) merged.amountPaidSats = assertSats(update.amountPaidSats, 'amountPaidSats');
    if (update.txid !== undefined) merged.txid = update.txid;
    if (update.preimage !== undefined) merged.preimage = update.preimage;
    if (update.providerData) merged.providerData = { ...payment.providerData, ...update.providerData };
    if ((next === 'paid' || next === 'overpaid') && !merged.paidAt) merged.paidAt = update.paidAt ?? at;
    if (next === 'paid' && update.amountPaidSats === undefined && merged.amountPaidSats === 0) merged.amountPaidSats = merged.amountSats;
    const amountsChanged = merged.amountPaidSats !== payment.amountPaidSats || merged.txid !== payment.txid || merged.preimage !== payment.preimage;
    if (!changesStatus && !amountsChanged && !update.providerData) return { payment, order, applied: false, reason: 'no change' };

    payment = await this.store.updatePayment(merged);
    if (changesStatus) {
      await this.emitPayment(payment, previous, update.detail ?? detail);
      order = await this.deriveOrderStatus(order, payment, update.detail ?? detail);
    }
    return { payment, order, applied: changesStatus || amountsChanged };
  }

  /** Order status follows its payments: paid/overpaid settle it; a fully refunded payment refunds it. */
  private async deriveOrderStatus(order: Order, payment: PaymentIntent, detail?: string): Promise<Order> {
    let target: OrderStatus | undefined;
    if ((payment.status === 'paid' || payment.status === 'overpaid') && order.status === 'awaiting_payment') target = 'paid';
    else if (payment.status === 'refunded' && order.status === 'paid') target = 'refunded';
    // expired/failed intents leave the order awaiting_payment: the product may open a new intent or cancel.
    if (!target || !canOrderTransition(order.status, target)) return order;
    return this.transitionOrder(order, target, detail);
  }

  private async transitionOrder(order: Order, to: OrderStatus, detail?: string): Promise<Order> {
    assertOrderTransition(order.status, to);
    const previous = order.status;
    const next = await this.store.updateOrder({ ...order, status: to, updatedAt: this.now().toISOString() });
    await this.emitOrder(next, previous, detail);
    return next;
  }

  async expireOrder(id: string, detail = 'no payment received'): Promise<Order> {
    const order = await this.store.getOrder(id);
    if (!order) throw notFound('order', id);
    if (order.status === 'expired') return order;
    return this.transitionOrder(order, 'expired', detail);
  }

  private pickProvider(method: PaymentMethod, name?: string): PaymentProvider {
    if (name) {
      const p = this.providers.get(name);
      if (!p || !p.methods.includes(method)) throw new LedgerError(400, 'method_unavailable', `provider ${name} does not serve ${method}`);
      return p;
    }
    const preferred = this.opts.defaultProvider?.[method];
    const p = (preferred && this.providers.get(preferred)) ?? [...this.providers.values()].find((x) => x.methods.includes(method));
    if (!p || !p.methods.includes(method)) throw new LedgerError(400, 'method_unavailable', `no provider serves ${method}`);
    return p;
  }

  // ------------------------------------------------------------------------------------ refunds

  async refund(paymentId: string, input: RefundInput, ctx: CallerContext): Promise<{ refund: Refund; created: boolean }> {
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > MAX_STR) throw invalid('reason is required');
    if (input.destination !== undefined && (typeof input.destination !== 'string' || input.destination.length === 0 || input.destination.length > MAX_STR)) throw invalid('destination must be a non-empty string');
    const payment = await this.getPayment(paymentId, ctx);
    const scope = `refund:${payment.id}`;
    if (ctx.idempotencyKey) {
      // The fingerprint covers the caller's request as sent (not the computed amount) so a replay after the
      // refund settled still matches.
      const fp = fingerprint({ amountSats: input.amountSats ?? null, reason: input.reason, destination: input.destination ?? null });
      const existing = await this.store.findIdempotency(scope, ctx.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fp) throw new LedgerError(422, 'idempotency_conflict', 'Idempotency-Key reused with a different request');
        const refund = await this.store.getRefund(existing.resourceId);
        if (!refund) throw notFound('refund', existing.resourceId);
        return { refund, created: false };
      }
    }
    if (!['paid', 'overpaid', 'underpaid'].includes(payment.status)) throw new LedgerError(409, 'not_refundable', `payment is ${payment.status}`);
    const available = payment.amountPaidSats - payment.refundedSats;
    const defaultAmount = payment.status === 'overpaid' ? Math.min(available, payment.amountPaidSats - payment.amountSats) : available;
    const amountSats = input.amountSats === undefined ? defaultAmount : assertSats(input.amountSats, 'amountSats');
    if (amountSats <= 0) throw new LedgerError(409, 'nothing_to_refund', 'nothing left to refund');
    if (amountSats > available) throw new LedgerError(409, 'refund_exceeds_paid', `at most ${available} sats can be refunded`);
    const fp = fingerprint({ amountSats: input.amountSats ?? null, reason: input.reason, destination: input.destination ?? null });
    const provider = this.providers.get(payment.provider);
    if (!provider) throw new LedgerError(503, 'provider_unavailable', `provider ${payment.provider} is not configured`);
    const at = this.now().toISOString();
    let refund: Refund = {
      id: `ref_${this.newId()}`,
      paymentId: payment.id,
      orderId: payment.orderId,
      amountSats,
      status: 'pending',
      reason: input.reason,
      providerRef: null,
      destination: input.destination ?? null,
      detail: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.createRefund(refund, ctx.idempotencyKey ? idemRecord(scope, ctx.idempotencyKey, fp, 'refund', refund.id) : undefined);
    const result = await provider.refund(payment, refund);
    refund = { ...refund, providerRef: result.providerRef, detail: result.detail ?? null };
    if (result.status === 'pending') {
      refund = await this.store.updateRefund(refund);
      return { refund, created: true };
    }
    refund = await this.settleRefund(refund, result.status, result.detail);
    return { refund, created: true };
  }

  async getRefund(id: string, ctx: CallerContext): Promise<Refund> {
    const r = await this.store.getRefund(id);
    if (!r) throw notFound('refund', id);
    await this.getPayment(r.paymentId, ctx); // scope check
    return r;
  }

  /** Finish a pending refund (provider webhook, or an operator after a manual payout). */
  async settleRefund(refundOrId: Refund | string, status: 'completed' | 'failed', detail?: string): Promise<Refund> {
    const refund = typeof refundOrId === 'string' ? await this.store.getRefund(refundOrId) : refundOrId;
    if (!refund) throw notFound('refund', String(refundOrId));
    if (refund.status === status) return refund;
    assertRefundTransition(refund.status, status);
    const at = this.now().toISOString();
    const next = await this.store.updateRefund({ ...refund, status, detail: detail ?? refund.detail, updatedAt: at });
    if (status !== 'completed') return next;
    // credit the refund against the payment; when everything credited went back, the intent is refunded
    for (let attempt = 0; ; attempt++) {
      const payment = await this.store.getPayment(refund.paymentId);
      if (!payment) throw notFound('payment', refund.paymentId);
      const refundedSats = payment.refundedSats + refund.amountSats;
      const full = refundedSats >= payment.amountPaidSats && canPaymentTransition(payment.status, 'refunded');
      try {
        const updated = await this.store.updatePayment({ ...payment, refundedSats, status: full ? 'refunded' : payment.status, updatedAt: at });
        if (full) {
          await this.emitPayment(updated, payment.status, detail ?? 'refunded');
          const order = await this.store.getOrder(payment.orderId);
          if (order) await this.deriveOrderStatus(order, updated, detail ?? 'refunded');
        }
        return next;
      } catch (e) {
        if (e instanceof ConcurrencyError && attempt < 3) continue;
        throw e;
      }
    }
  }

  async listRefunds(orderId: string, ctx: CallerContext): Promise<Refund[]> {
    await this.getOrder(orderId, ctx);
    return this.store.listRefundsByOrder(orderId);
  }

  // ------------------------------------------------------------------------------------ webhooks

  /**
   * Verify, de-duplicate and apply a provider webhook. Unknown references and illegal transitions are
   * acknowledged (`applied: false`) so the provider stops retrying; signature failures throw `WebhookError`.
   */
  async handleWebhook(providerName: string, rawBody: string, headers: Headers): Promise<WebhookResult> {
    const provider = this.providers.get(providerName);
    if (!provider?.parseWebhook) throw new LedgerError(404, 'not_found', `no webhook receiver for ${providerName}`);
    const now = this.now();
    const hook = await provider.parseWebhook(rawBody, headers, now);
    const fresh = await this.store.recordWebhookDelivery(provider.name, hook.deliveryId, now.toISOString());
    if (!fresh) return { received: true, duplicate: true, applied: false, eventType: hook.eventType, reason: 'replay' };
    const payment = await this.store.findPaymentByProviderRef(provider.name, hook.providerRef);
    if (!payment) return { received: true, duplicate: false, applied: false, eventType: hook.eventType, reason: 'unknown_reference' };

    if (hook.refund) {
      const refund = (await this.store.listRefundsByPayment(payment.id)).find((r) => r.providerRef === hook.refund!.providerRef);
      if (!refund) return { received: true, duplicate: false, applied: false, eventType: hook.eventType, reason: 'unknown_refund' };
      if (refund.status !== 'pending') return { received: true, duplicate: false, applied: false, eventType: hook.eventType, reason: 'refund_settled' };
      await this.settleRefund(refund, hook.refund.status, hook.refund.detail);
      return { received: true, duplicate: false, applied: true, eventType: hook.eventType };
    }

    let update = hook.update;
    if (this.verifyWebhooks) {
      // Trust but verify: the provider's API is authoritative over what the webhook claims.
      try {
        const polled = await provider.poll(payment, now);
        if (polled) update = polled;
      } catch {
        /* provider unreachable: fall back to the (authenticated) webhook body */
      }
    }
    if (!update) return { received: true, duplicate: false, applied: false, eventType: hook.eventType, reason: 'informational' };
    const res = await this.applyUpdate(payment.id, update, `webhook ${hook.eventType}`);
    const out: WebhookResult = { received: true, duplicate: false, applied: res.applied, eventType: hook.eventType };
    if (res.reason) out.reason = res.reason;
    return out;
  }

  // ------------------------------------------------------------------------------------ events

  private async publish(event: EventEnvelope): Promise<void> {
    if (!this.bus) return;
    try {
      await this.bus.publish(event);
    } catch (e) {
      this.onPublishError(e, event);
    }
  }

  private emitOrder(order: Order, previous: OrderStatus | null, detail?: string): Promise<void> {
    const data: Parameters<typeof ledgerOrderStatus.create>[0]['data'] = {
      orderId: order.id,
      product: order.product,
      customerRef: order.customerRef,
      status: order.status,
      previousStatus: previous,
      currency: 'sat',
      totalSats: order.totalSats,
      at: order.updatedAt,
    };
    if (detail) data.detail = detail;
    return this.publish(ledgerOrderStatus.create({ source: this.source, params: { status: order.status }, subject: order.id, data }, { now: this.now }));
  }

  private emitPayment(p: PaymentIntent, previous: PaymentStatus | null, detail?: string): Promise<void> {
    const data: Parameters<typeof ledgerPaymentStatus.create>[0]['data'] = {
      paymentId: p.id,
      orderId: p.orderId,
      product: p.product,
      method: p.method,
      provider: p.provider,
      status: p.status,
      previousStatus: previous,
      amountSats: p.amountSats,
      amountPaidSats: p.amountPaidSats,
      at: p.updatedAt,
    };
    if (p.paidAt) data.paidAt = p.paidAt;
    if (p.txid && /^[0-9a-f]{64}$/.test(p.txid)) data.txid = p.txid;
    if (detail) data.detail = detail;
    return this.publish(ledgerPaymentStatus.create({ source: this.source, params: { status: p.status }, subject: p.orderId, data }, { now: this.now }));
  }
}

// ------------------------------------------------------------------------------------ validation

function idemRecord(scope: string, key: string, fp: string, resourceType: IdempotencyRecord['resourceType'], resourceId: string): IdempotencyRecord {
  return { scope, key, fingerprint: fp, resourceType, resourceId };
}

const isStr = (v: unknown, max = MAX_STR): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function validateOrderInput(input: unknown): CreateOrderInput {
  if (!input || typeof input !== 'object') throw invalid('body must be an object');
  const o = input as Record<string, unknown>;
  if (!PRODUCTS.includes(o.product as Product)) throw invalid(`product must be one of ${PRODUCTS.join(', ')}`);
  if (!isStr(o.customerRef, 256)) throw invalid('customerRef must be a string of 1..256 characters');
  if (!Array.isArray(o.lineItems) || o.lineItems.length === 0 || o.lineItems.length > MAX_LINE_ITEMS) throw invalid(`lineItems must hold 1..${MAX_LINE_ITEMS} items`);
  const lineItems: LineItem[] = o.lineItems.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw invalid(`lineItems[${i}] must be an object`);
    const li = raw as Record<string, unknown>;
    if (!isStr(li.sku, 128)) throw invalid(`lineItems[${i}].sku must be a string of 1..128 characters`);
    if (!isStr(li.description)) throw invalid(`lineItems[${i}].description must be a string of 1..${MAX_STR} characters`);
    if (typeof li.quantity !== 'number' || !Number.isInteger(li.quantity) || li.quantity < 1 || li.quantity > 1_000_000) throw invalid(`lineItems[${i}].quantity must be an integer in 1..1000000`);
    try {
      assertSats(li.unitSats, `lineItems[${i}].unitSats`);
    } catch (e) {
      throw invalid((e as Error).message);
    }
    return { sku: li.sku, description: li.description, quantity: li.quantity, unitSats: li.unitSats as number };
  });
  let metadata: Record<string, string> | undefined;
  if (o.metadata !== undefined) {
    if (!o.metadata || typeof o.metadata !== 'object' || Array.isArray(o.metadata)) throw invalid('metadata must be an object of strings');
    const entries = Object.entries(o.metadata as Record<string, unknown>);
    if (entries.length > MAX_METADATA_KEYS) throw invalid(`metadata may hold at most ${MAX_METADATA_KEYS} keys`);
    metadata = {};
    for (const [k, v] of entries) {
      if (!isStr(k, 64) || typeof v !== 'string' || v.length > MAX_STR) throw invalid('metadata keys (1..64) and values (0..512) must be strings');
      metadata[k] = v;
    }
  }
  const out: CreateOrderInput = { product: o.product as Product, customerRef: o.customerRef, lineItems };
  if (metadata) out.metadata = metadata;
  return out;
}

export { WebhookError };
