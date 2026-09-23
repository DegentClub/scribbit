import { ConcurrencyError, LedgerError } from '../domain/errors.js';
import type { Order, PaymentIntent, PaymentStatus, Refund } from '../domain/types.js';
import type { IdempotencyRecord, OrderStore } from './order-store.js';

const clone = <T>(v: T): T => structuredClone(v);

/** Process-local store for tests and single-process dev. Same semantics as the SQLite adapter. */
export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly payments = new Map<string, PaymentIntent>();
  private readonly refunds = new Map<string, Refund>();
  private readonly idem = new Map<string, IdempotencyRecord>();
  private readonly deliveries = new Set<string>();
  private readonly indexes = new Map<string, number>();

  private putIdem(idem: IdempotencyRecord | undefined): void {
    if (!idem) return;
    const k = `${idem.scope}\u0000${idem.key}`;
    if (this.idem.has(k)) throw new LedgerError(409, 'idempotency_conflict', 'idempotency key already used');
    this.idem.set(k, { ...idem });
  }

  async createOrder(order: Order, idem?: IdempotencyRecord): Promise<void> {
    if (this.orders.has(order.id)) throw new LedgerError(409, 'duplicate_id', `order ${order.id} exists`);
    this.putIdem(idem);
    this.orders.set(order.id, clone(order));
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const o = this.orders.get(id);
    return o && clone(o);
  }

  async updateOrder(order: Order): Promise<Order> {
    const cur = this.orders.get(order.id);
    if (!cur) throw new LedgerError(404, 'not_found', `order ${order.id} not found`);
    if (cur.version !== order.version) throw new ConcurrencyError('order', order.id);
    const next = clone({ ...order, version: order.version + 1 });
    this.orders.set(order.id, next);
    return clone(next);
  }

  async createPayment(payment: PaymentIntent, idem?: IdempotencyRecord): Promise<void> {
    if (this.payments.has(payment.id)) throw new LedgerError(409, 'duplicate_id', `payment ${payment.id} exists`);
    for (const p of this.payments.values())
      if (p.provider === payment.provider && p.providerRef === payment.providerRef)
        throw new LedgerError(409, 'duplicate_provider_ref', `${payment.provider} ref ${payment.providerRef} already tracked`);
    this.putIdem(idem);
    this.payments.set(payment.id, clone(payment));
  }

  async getPayment(id: string): Promise<PaymentIntent | undefined> {
    const p = this.payments.get(id);
    return p && clone(p);
  }

  async updatePayment(payment: PaymentIntent): Promise<PaymentIntent> {
    const cur = this.payments.get(payment.id);
    if (!cur) throw new LedgerError(404, 'not_found', `payment ${payment.id} not found`);
    if (cur.version !== payment.version) throw new ConcurrencyError('payment', payment.id);
    const next = clone({ ...payment, version: payment.version + 1 });
    this.payments.set(payment.id, next);
    return clone(next);
  }

  async listPaymentsByOrder(orderId: string): Promise<PaymentIntent[]> {
    return [...this.payments.values()].filter((p) => p.orderId === orderId).sort(byCreated).map(clone);
  }

  async listPaymentsByStatus(statuses: readonly PaymentStatus[], limit = 1000): Promise<PaymentIntent[]> {
    return [...this.payments.values()].filter((p) => statuses.includes(p.status)).sort(byCreated).slice(0, limit).map(clone);
  }

  async findPaymentByProviderRef(provider: string, providerRef: string): Promise<PaymentIntent | undefined> {
    const p = [...this.payments.values()].find((x) => x.provider === provider && x.providerRef === providerRef);
    return p && clone(p);
  }

  async createRefund(refund: Refund, idem?: IdempotencyRecord): Promise<void> {
    if (this.refunds.has(refund.id)) throw new LedgerError(409, 'duplicate_id', `refund ${refund.id} exists`);
    this.putIdem(idem);
    this.refunds.set(refund.id, clone(refund));
  }

  async getRefund(id: string): Promise<Refund | undefined> {
    const r = this.refunds.get(id);
    return r && clone(r);
  }

  async updateRefund(refund: Refund): Promise<Refund> {
    if (!this.refunds.has(refund.id)) throw new LedgerError(404, 'not_found', `refund ${refund.id} not found`);
    this.refunds.set(refund.id, clone(refund));
    return clone(refund);
  }

  async listRefundsByPayment(paymentId: string): Promise<Refund[]> {
    return [...this.refunds.values()].filter((r) => r.paymentId === paymentId).sort(byCreated).map(clone);
  }

  async listRefundsByOrder(orderId: string): Promise<Refund[]> {
    return [...this.refunds.values()].filter((r) => r.orderId === orderId).sort(byCreated).map(clone);
  }

  async findIdempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const r = this.idem.get(`${scope}\u0000${key}`);
    return r && { ...r };
  }

  async recordWebhookDelivery(provider: string, deliveryId: string): Promise<boolean> {
    const k = `${provider}\u0000${deliveryId}`;
    if (this.deliveries.has(k)) return false;
    this.deliveries.add(k);
    return true;
  }

  async allocateAddressIndex(scope: string): Promise<number> {
    const n = this.indexes.get(scope) ?? 0;
    this.indexes.set(scope, n + 1);
    return n;
  }
}

const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
