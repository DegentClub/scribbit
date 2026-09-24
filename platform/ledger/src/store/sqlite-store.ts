import { DatabaseSync } from 'node:sqlite';
import { ConcurrencyError, LedgerError } from '../domain/errors.js';
import type { Order, PayeeKind, PaymentIntent, PaymentStatus, Payout, Product, Refund } from '../domain/types.js';
import { MIGRATIONS } from './migrations.js';
import type { IdempotencyRecord, OrderStore } from './order-store.js';

type Row = Record<string, unknown>;

/**
 * `node:sqlite` adapter (single writer; WAL mode). Suitable for one service instance; move to Postgres
 * when the ledger is sharded. Same semantics as `MemoryOrderStore`.
 */
export class SqliteOrderStore implements OrderStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  /** Applied migration ids (for health checks / tests). */
  appliedMigrations(): string[] {
    return (this.db.prepare('SELECT id FROM schema_migrations ORDER BY rowid').all() as Row[]).map((r) => r.id as string);
  }

  /**
   * Migrations run with foreign keys OFF (the documented SQLite procedure for rebuilding a table that other
   * tables reference; the pragma is a no-op inside a transaction, so it is toggled around each one) and every
   * migration is followed by `PRAGMA foreign_key_check`, which must be empty before the change is committed.
   */
  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.appliedMigrations());
    const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
    if (pending.length === 0) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (const m of pending) {
        this.db.exec('BEGIN');
        try {
          this.db.exec(m.sql);
          const violations = this.db.prepare('PRAGMA foreign_key_check').all() as Row[];
          if (violations.length > 0) throw new Error(`migration ${m.id} leaves ${violations.length} foreign key violation(s)`);
          this.db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private insertIdem(idem: IdempotencyRecord | undefined, at: string): void {
    if (!idem) return;
    const exists = this.db.prepare('SELECT 1 FROM idempotency_keys WHERE scope = ? AND key = ?').get(idem.scope, idem.key);
    if (exists) throw new LedgerError(409, 'idempotency_conflict', 'idempotency key already used');
    this.db
      .prepare('INSERT INTO idempotency_keys (scope, key, fingerprint, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(idem.scope, idem.key, idem.fingerprint, idem.resourceType, idem.resourceId, at);
  }

  // ------------------------------------------------------------------ orders

  async createOrder(o: Order, idem?: IdempotencyRecord): Promise<void> {
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM orders WHERE id = ?').get(o.id)) throw new LedgerError(409, 'duplicate_id', `order ${o.id} exists`);
      this.insertIdem(idem, o.createdAt);
      this.db
        .prepare(
          `INSERT INTO orders (id, product, customer_ref, currency, total_sats, status, line_items, metadata, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(o.id, o.product, o.customerRef, o.currency, o.totalSats, o.status, JSON.stringify(o.lineItems), JSON.stringify(o.metadata), o.version, o.createdAt, o.updatedAt);
    });
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    return r && rowToOrder(r);
  }

  async updateOrder(o: Order): Promise<Order> {
    return this.tx(() => {
      const res = this.db
        .prepare(`UPDATE orders SET status = ?, total_sats = ?, line_items = ?, metadata = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`)
        .run(o.status, o.totalSats, JSON.stringify(o.lineItems), JSON.stringify(o.metadata), o.version + 1, o.updatedAt, o.id, o.version);
      if (res.changes === 0) {
        if (!this.db.prepare('SELECT 1 FROM orders WHERE id = ?').get(o.id)) throw new LedgerError(404, 'not_found', `order ${o.id} not found`);
        throw new ConcurrencyError('order', o.id);
      }
      return { ...structuredClone(o), version: o.version + 1 };
    });
  }

  // ------------------------------------------------------------------ payments

  async createPayment(p: PaymentIntent, idem?: IdempotencyRecord): Promise<void> {
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM payments WHERE id = ?').get(p.id)) throw new LedgerError(409, 'duplicate_id', `payment ${p.id} exists`);
      if (this.db.prepare('SELECT 1 FROM payments WHERE provider = ? AND provider_ref = ?').get(p.provider, p.providerRef))
        throw new LedgerError(409, 'duplicate_provider_ref', `${p.provider} ref ${p.providerRef} already tracked`);
      this.insertIdem(idem, p.createdAt);
      this.db
        .prepare(
          `INSERT INTO payments (id, order_id, product, method, provider, provider_ref, amount_sats, amount_paid_sats, refunded_sats, status, checkout,
             expires_at, paid_at, txid, preimage, provider_data, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.id, p.orderId, p.product, p.method, p.provider, p.providerRef, p.amountSats, p.amountPaidSats, p.refundedSats, p.status,
          JSON.stringify(p.checkout), p.expiresAt, p.paidAt, p.txid ?? null, p.preimage ?? null, JSON.stringify(p.providerData), p.version, p.createdAt, p.updatedAt,
        );
    });
  }

  async getPayment(id: string): Promise<PaymentIntent | undefined> {
    const r = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Row | undefined;
    return r && rowToPayment(r);
  }

  async updatePayment(p: PaymentIntent): Promise<PaymentIntent> {
    return this.tx(() => {
      const res = this.db
        .prepare(
          `UPDATE payments SET status = ?, amount_paid_sats = ?, refunded_sats = ?, checkout = ?, expires_at = ?, paid_at = ?, txid = ?, preimage = ?,
             provider_data = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .run(
          p.status, p.amountPaidSats, p.refundedSats, JSON.stringify(p.checkout), p.expiresAt, p.paidAt, p.txid ?? null, p.preimage ?? null,
          JSON.stringify(p.providerData), p.version + 1, p.updatedAt, p.id, p.version,
        );
      if (res.changes === 0) {
        if (!this.db.prepare('SELECT 1 FROM payments WHERE id = ?').get(p.id)) throw new LedgerError(404, 'not_found', `payment ${p.id} not found`);
        throw new ConcurrencyError('payment', p.id);
      }
      return { ...structuredClone(p), version: p.version + 1 };
    });
  }

  async listPaymentsByOrder(orderId: string): Promise<PaymentIntent[]> {
    return (this.db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, id').all(orderId) as Row[]).map(rowToPayment);
  }

  async listPaymentsByStatus(statuses: readonly PaymentStatus[], limit = 1000): Promise<PaymentIntent[]> {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM payments WHERE status IN (${marks}) ORDER BY created_at, id LIMIT ?`).all(...statuses, limit) as Row[]).map(rowToPayment);
  }

  async findPaymentByProviderRef(provider: string, providerRef: string): Promise<PaymentIntent | undefined> {
    const r = this.db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_ref = ?').get(provider, providerRef) as Row | undefined;
    return r && rowToPayment(r);
  }

  async findPaymentsByTxid(txid: string): Promise<PaymentIntent[]> {
    return (this.db.prepare('SELECT * FROM payments WHERE txid = ? ORDER BY created_at, id').all(txid) as Row[]).map(rowToPayment);
  }

  // ------------------------------------------------------------------ refunds

  async createRefund(r: Refund, idem?: IdempotencyRecord): Promise<void> {
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM refunds WHERE id = ?').get(r.id)) throw new LedgerError(409, 'duplicate_id', `refund ${r.id} exists`);
      this.insertIdem(idem, r.createdAt);
      this.db
        .prepare(
          `INSERT INTO refunds (id, payment_id, order_id, amount_sats, status, reason, provider_ref, destination, detail, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.id, r.paymentId, r.orderId, r.amountSats, r.status, r.reason, r.providerRef, r.destination, r.detail, r.version, r.createdAt, r.updatedAt);
    });
  }

  async getRefund(id: string): Promise<Refund | undefined> {
    const r = this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(id) as Row | undefined;
    return r && rowToRefund(r);
  }

  async updateRefund(r: Refund): Promise<Refund> {
    return this.tx(() => {
      const res = this.db
        .prepare('UPDATE refunds SET status = ?, provider_ref = ?, destination = ?, detail = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?')
        .run(r.status, r.providerRef, r.destination, r.detail, r.version + 1, r.updatedAt, r.id, r.version);
      if (res.changes === 0) {
        if (!this.db.prepare('SELECT 1 FROM refunds WHERE id = ?').get(r.id)) throw new LedgerError(404, 'not_found', `refund ${r.id} not found`);
        throw new ConcurrencyError('refund', r.id);
      }
      return { ...structuredClone(r), version: r.version + 1 };
    });
  }

  async listRefundsByPayment(paymentId: string): Promise<Refund[]> {
    return (this.db.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at, id').all(paymentId) as Row[]).map(rowToRefund);
  }

  async listRefundsByOrder(orderId: string): Promise<Refund[]> {
    return (this.db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at, id').all(orderId) as Row[]).map(rowToRefund);
  }

  // ------------------------------------------------------------------ payouts

  async createPayout(p: Payout): Promise<void> {
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM payouts WHERE id = ?').get(p.id)) throw new LedgerError(409, 'duplicate_id', `payout ${p.id} exists`);
      if (this.db.prepare('SELECT 1 FROM payouts WHERE payment_id = ? AND txid = ? AND vout = ?').get(p.paymentId, p.txid, p.vout))
        throw new LedgerError(409, 'duplicate_payout', `payout for ${p.txid}:${p.vout} on ${p.paymentId} already recorded`);
      this.db
        .prepare(
          `INSERT INTO payouts (id, order_id, payment_id, product, payee_kind, payee_ref, payee, amount_sats, txid, vout, status, settled_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.id, p.orderId, p.paymentId, p.product, p.payee.kind, p.payee.ref, JSON.stringify(p.payee), p.amountSats, p.txid, p.vout, p.status, p.settledAt, p.version, p.createdAt, p.updatedAt);
    });
  }

  async getPayout(id: string): Promise<Payout | undefined> {
    const r = this.db.prepare('SELECT * FROM payouts WHERE id = ?').get(id) as Row | undefined;
    return r && rowToPayout(r);
  }

  async updatePayout(p: Payout): Promise<Payout> {
    return this.tx(() => {
      const res = this.db
        .prepare('UPDATE payouts SET status = ?, settled_at = ?, txid = ?, vout = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?')
        .run(p.status, p.settledAt, p.txid, p.vout, p.version + 1, p.updatedAt, p.id, p.version);
      if (res.changes === 0) {
        if (!this.db.prepare('SELECT 1 FROM payouts WHERE id = ?').get(p.id)) throw new LedgerError(404, 'not_found', `payout ${p.id} not found`);
        throw new ConcurrencyError('payout', p.id);
      }
      return { ...structuredClone(p), version: p.version + 1 };
    });
  }

  async listPayoutsByOrder(orderId: string): Promise<Payout[]> {
    return (this.db.prepare('SELECT * FROM payouts WHERE order_id = ? ORDER BY created_at, id').all(orderId) as Row[]).map(rowToPayout);
  }

  async listPayoutsByPayment(paymentId: string): Promise<Payout[]> {
    return (this.db.prepare('SELECT * FROM payouts WHERE payment_id = ? ORDER BY created_at, id').all(paymentId) as Row[]).map(rowToPayout);
  }

  async listPayoutsByPayee(ref: string, filter: { product?: Product; kind?: PayeeKind } = {}, limit = 1000): Promise<Payout[]> {
    const where = ['payee_ref = ?'];
    const args: unknown[] = [ref];
    if (filter.product) {
      where.push('product = ?');
      args.push(filter.product);
    }
    if (filter.kind) {
      where.push('payee_kind = ?');
      args.push(filter.kind);
    }
    return (this.db.prepare(`SELECT * FROM payouts WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ?`).all(...(args as never[]), limit) as Row[]).map(rowToPayout);
  }

  // ------------------------------------------------------------------ misc

  async findIdempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?').get(scope, key) as Row | undefined;
    return r && { scope, key, fingerprint: r.fingerprint as string, resourceType: r.resource_type as IdempotencyRecord['resourceType'], resourceId: r.resource_id as string };
  }

  async recordWebhookDelivery(provider: string, deliveryId: string, at: string): Promise<boolean> {
    const res = this.db.prepare('INSERT OR IGNORE INTO webhook_deliveries (provider, delivery_id, received_at) VALUES (?, ?, ?)').run(provider, deliveryId, at);
    return res.changes === 1;
  }

  async allocateAddressIndex(scope: string): Promise<number> {
    return this.tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO address_indexes (scope, next) VALUES (?, 0)').run(scope);
      const r = this.db.prepare('SELECT next FROM address_indexes WHERE scope = ?').get(scope) as Row;
      const n = Number(r.next);
      this.db.prepare('UPDATE address_indexes SET next = ? WHERE scope = ?').run(n + 1, scope);
      return n;
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function rowToOrder(r: Row): Order {
  return {
    id: str(r.id),
    product: r.product as Order['product'],
    customerRef: str(r.customer_ref),
    currency: 'sat',
    totalSats: Number(r.total_sats),
    status: r.status as Order['status'],
    lineItems: JSON.parse(str(r.line_items)),
    metadata: JSON.parse(str(r.metadata)),
    version: Number(r.version),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToPayment(r: Row): PaymentIntent {
  const p: PaymentIntent = {
    id: str(r.id),
    orderId: str(r.order_id),
    product: r.product as PaymentIntent['product'],
    method: r.method as PaymentIntent['method'],
    provider: str(r.provider),
    providerRef: str(r.provider_ref),
    amountSats: Number(r.amount_sats),
    amountPaidSats: Number(r.amount_paid_sats),
    refundedSats: Number(r.refunded_sats),
    status: r.status as PaymentIntent['status'],
    checkout: JSON.parse(str(r.checkout)),
    expiresAt: optStr(r.expires_at),
    paidAt: optStr(r.paid_at),
    providerData: JSON.parse(str(r.provider_data)),
    version: Number(r.version),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
  if (r.txid != null) p.txid = str(r.txid);
  if (r.preimage != null) p.preimage = str(r.preimage);
  return p;
}

function rowToRefund(r: Row): Refund {
  return {
    id: str(r.id),
    paymentId: str(r.payment_id),
    orderId: str(r.order_id),
    amountSats: Number(r.amount_sats),
    status: r.status as Refund['status'],
    reason: str(r.reason),
    providerRef: optStr(r.provider_ref),
    destination: optStr(r.destination),
    detail: optStr(r.detail),
    version: Number(r.version ?? 0),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToPayout(r: Row): Payout {
  return {
    id: str(r.id),
    orderId: str(r.order_id),
    paymentId: str(r.payment_id),
    product: r.product as Payout['product'],
    payee: JSON.parse(str(r.payee)),
    amountSats: Number(r.amount_sats),
    txid: str(r.txid),
    vout: Number(r.vout),
    status: r.status as Payout['status'],
    settledAt: optStr(r.settled_at),
    version: Number(r.version),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}
