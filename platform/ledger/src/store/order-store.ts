import type { Order, PaymentIntent, PaymentStatus, Refund } from '../domain/types.js';

/**
 * Idempotency record: `(scope, key)` → the resource created the first time. `fingerprint` is a hash of the
 * request; the same key with a different fingerprint is a client bug and is rejected (`idempotency_conflict`).
 */
export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  resourceType: 'order' | 'payment' | 'refund';
  resourceId: string;
}

/**
 * Persistence port. Adapters: `MemoryOrderStore` (tests, dev) and `SqliteOrderStore` (node:sqlite).
 * Writes use optimistic concurrency: `update*` must reject when the stored `version` differs from the
 * entity's version at read time (throw `ConcurrencyError`) and persist `version + 1`.
 */
export interface OrderStore {
  createOrder(order: Order, idem?: IdempotencyRecord): Promise<void>;
  getOrder(id: string): Promise<Order | undefined>;
  updateOrder(order: Order): Promise<Order>;

  createPayment(payment: PaymentIntent, idem?: IdempotencyRecord): Promise<void>;
  getPayment(id: string): Promise<PaymentIntent | undefined>;
  updatePayment(payment: PaymentIntent): Promise<PaymentIntent>;
  listPaymentsByOrder(orderId: string): Promise<PaymentIntent[]>;
  listPaymentsByStatus(statuses: readonly PaymentStatus[], limit?: number): Promise<PaymentIntent[]>;
  findPaymentByProviderRef(provider: string, providerRef: string): Promise<PaymentIntent | undefined>;

  createRefund(refund: Refund, idem?: IdempotencyRecord): Promise<void>;
  getRefund(id: string): Promise<Refund | undefined>;
  updateRefund(refund: Refund): Promise<Refund>;
  listRefundsByPayment(paymentId: string): Promise<Refund[]>;
  listRefundsByOrder(orderId: string): Promise<Refund[]>;

  findIdempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  /** Record a processed webhook delivery. Returns false when it was already recorded (replay). */
  recordWebhookDelivery(provider: string, deliveryId: string, at: string): Promise<boolean>;
  /** Monotonic counter per scope (e.g. one per xpub) for on-chain address derivation. */
  allocateAddressIndex(scope: string): Promise<number>;

  close?(): Promise<void>;
}
