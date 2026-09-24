import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ConcurrencyError, LedgerError, MIGRATIONS, MemoryOrderStore, SqliteOrderStore, type Order, type OrderStore, type PaymentIntent, type Payout, type Refund } from '../src/index.js';

const at = '2026-09-23T12:00:00.000Z';
const order = (id: string, extra: Partial<Order> = {}): Order => ({
  id,
  product: 'scribbit',
  customerRef: 'c1',
  lineItems: [{ sku: 's', description: 'd', quantity: 1, unitSats: 100 }],
  currency: 'sat',
  totalSats: 100,
  status: 'created',
  metadata: { k: 'v' },
  version: 0,
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const payment = (id: string, orderId: string, extra: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id,
  orderId,
  product: 'scribbit',
  method: 'lightning',
  provider: 'btcpay',
  providerRef: `inv-${id}`,
  amountSats: 100,
  amountPaidSats: 0,
  refundedSats: 0,
  status: 'created',
  checkout: { bolt11: 'lnbc1' },
  expiresAt: null,
  paidAt: null,
  providerData: { a: 1 },
  version: 0,
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const refund = (id: string, paymentId: string, orderId: string): Refund => ({ id, paymentId, orderId, amountSats: 10, status: 'pending', reason: 'r', providerRef: null, destination: null, detail: null, version: 0, createdAt: at, updatedAt: at });
const payout = (id: string, paymentId: string, orderId: string, extra: Partial<Payout> = {}): Payout => ({
  id,
  orderId,
  paymentId,
  product: 'scribbit',
  payee: { kind: 'artist', ref: 'artist-1', address: 'bc1qartist' },
  amountSats: 1_000,
  txid: 'f'.repeat(64),
  vout: 1,
  status: 'settled',
  settledAt: at,
  version: 0,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

const adapters: Array<[string, () => OrderStore]> = [
  ['MemoryOrderStore', () => new MemoryOrderStore()],
  ['SqliteOrderStore', () => new SqliteOrderStore(':memory:')],
];

describe.each(adapters)('%s', (_name, make) => {
  it('round-trips orders, payments and refunds with optimistic concurrency', async () => {
    const s = make();
    await s.createOrder(order('o1'));
    expect(await s.getOrder('o1')).toEqual(order('o1'));
    expect(await s.getOrder('nope')).toBeUndefined();
    await expect(s.createOrder(order('o1'))).rejects.toMatchObject({ code: 'duplicate_id' });

    const o = (await s.getOrder('o1'))!;
    const updated = await s.updateOrder({ ...o, status: 'awaiting_payment' });
    expect(updated.version).toBe(1);
    await expect(s.updateOrder({ ...o, status: 'paid' })).rejects.toBeInstanceOf(ConcurrencyError); // stale version
    await expect(s.updateOrder(order('missing'))).rejects.toMatchObject({ code: 'not_found' });

    await s.createPayment(payment('p1', 'o1', { txid: 'a'.repeat(64) }));
    expect(await s.getPayment('p1')).toEqual(payment('p1', 'o1', { txid: 'a'.repeat(64) }));
    await expect(s.createPayment(payment('p2', 'o1', { providerRef: 'inv-p1' }))).rejects.toMatchObject({ code: 'duplicate_provider_ref' });
    expect(await s.findPaymentByProviderRef('btcpay', 'inv-p1')).toMatchObject({ id: 'p1' });
    expect(await s.findPaymentByProviderRef('card', 'inv-p1')).toBeUndefined();
    expect((await s.findPaymentsByTxid('a'.repeat(64))).map((x) => x.id)).toEqual(['p1']);
    expect(await s.findPaymentsByTxid('b'.repeat(64))).toEqual([]);
    const p = (await s.getPayment('p1'))!;
    const p2 = await s.updatePayment({ ...p, status: 'paid', amountPaidSats: 100, paidAt: at, preimage: 'b'.repeat(64) });
    expect(p2).toMatchObject({ version: 1, status: 'paid', preimage: 'b'.repeat(64) });
    await expect(s.updatePayment(p)).rejects.toBeInstanceOf(ConcurrencyError);
    await s.createPayment(payment('p3', 'o1', { status: 'pending', createdAt: '2026-09-23T12:00:01.000Z' }));
    expect((await s.listPaymentsByOrder('o1')).map((x) => x.id)).toEqual(['p1', 'p3']);
    expect((await s.listPaymentsByStatus(['pending', 'created'])).map((x) => x.id)).toEqual(['p3']);
    expect(await s.listPaymentsByStatus([])).toEqual([]);
    expect((await s.listPaymentsByStatus(['paid', 'pending'], 1)).length).toBe(1);

    await s.createRefund(refund('r1', 'p1', 'o1'));
    expect(await s.getRefund('r1')).toEqual(refund('r1', 'p1', 'o1'));
    const r = await s.updateRefund({ ...refund('r1', 'p1', 'o1'), status: 'completed', providerRef: 'pp1', detail: 'done' });
    expect(r).toMatchObject({ status: 'completed', version: 1 });
    expect((await s.getRefund('r1'))!.version).toBe(1);
    // stale refund version → ConcurrencyError (optimistic check, same as orders/payments)
    await expect(s.updateRefund({ ...refund('r1', 'p1', 'o1'), status: 'failed' })).rejects.toBeInstanceOf(ConcurrencyError);
    expect((await s.listRefundsByPayment('p1')).map((x) => x.id)).toEqual(['r1']);
    expect((await s.listRefundsByOrder('o1')).map((x) => x.status)).toEqual(['completed']);
    await expect(s.updateRefund(refund('zz', 'p1', 'o1'))).rejects.toMatchObject({ code: 'not_found' });
    await s.close?.();
  });

  it('records payouts per payee output with optimistic concurrency and payee/product/kind listing', async () => {
    const s = make();
    await s.createOrder(order('o1'));
    await s.createOrder(order('o2', { product: 'degent' }));
    await s.createPayment(payment('p1', 'o1', { method: 'psbt', provider: 'psbt' }));
    await s.createPayment(payment('p2', 'o2', { method: 'psbt', provider: 'psbt', product: 'degent' }));
    await s.createPayout(payout('y1', 'p1', 'o1'));
    expect(await s.getPayout('y1')).toEqual(payout('y1', 'p1', 'o1'));
    expect(await s.getPayout('nope')).toBeUndefined();
    await expect(s.createPayout(payout('y1', 'p1', 'o1'))).rejects.toMatchObject({ code: 'duplicate_id' });
    // the same (payment, txid, vout) is one payout, whatever the id
    await expect(s.createPayout(payout('y1b', 'p1', 'o1'))).rejects.toMatchObject({ code: 'duplicate_payout' });
    await s.createPayout(payout('y2', 'p1', 'o1', { vout: 2, payee: { kind: 'club', ref: 'degent-club', scriptHex: '0014' + '11'.repeat(20) }, createdAt: '2026-09-23T12:00:01.000Z' }));
    await s.createPayout(payout('y3', 'p2', 'o2', { product: 'degent', createdAt: '2026-09-23T12:00:02.000Z' }));
    expect((await s.listPayoutsByOrder('o1')).map((x) => x.id)).toEqual(['y1', 'y2']);
    expect((await s.listPayoutsByPayment('p1')).map((x) => x.id)).toEqual(['y1', 'y2']);
    expect((await s.listPayoutsByPayee('artist-1')).map((x) => x.id)).toEqual(['y1', 'y3']);
    expect((await s.listPayoutsByPayee('artist-1', { product: 'degent' })).map((x) => x.id)).toEqual(['y3']);
    expect((await s.listPayoutsByPayee('artist-1', { kind: 'club' })).map((x) => x.id)).toEqual([]);
    expect((await s.listPayoutsByPayee('degent-club', { kind: 'club' })).map((x) => x.id)).toEqual(['y2']);
    expect((await s.listPayoutsByPayee('artist-1', {}, 1)).map((x) => x.id)).toEqual(['y1']);
    const y = (await s.getPayout('y1'))!;
    const updated = await s.updatePayout({ ...y, status: 'failed', settledAt: null });
    expect(updated).toMatchObject({ status: 'failed', settledAt: null, version: 1 });
    await expect(s.updatePayout(y)).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(s.updatePayout(payout('missing', 'p1', 'o1'))).rejects.toMatchObject({ code: 'not_found' });
    // payees are stored as a JSON blob and come back intact (address or scriptHex)
    expect((await s.getPayout('y2'))!.payee).toEqual({ kind: 'club', ref: 'degent-club', scriptHex: '0014' + '11'.repeat(20) });
    await s.close?.();
  });

  it('idempotency records are unique per scope+key and readable back', async () => {
    const s = make();
    const idem = { scope: 'order:scribbit', key: 'k1', fingerprint: 'fp', resourceType: 'order' as const, resourceId: 'o1' };
    await s.createOrder(order('o1'), idem);
    expect(await s.findIdempotency('order:scribbit', 'k1')).toEqual(idem);
    expect(await s.findIdempotency('order:degent', 'k1')).toBeUndefined();
    await expect(s.createOrder(order('o2'), { ...idem, resourceId: 'o2' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await s.getOrder('o2')).toBeUndefined(); // the whole create rolled back
    await s.createOrder(order('o2'), { ...idem, scope: 'order:degent', resourceId: 'o2' });
    await s.close?.();
  });

  it('webhook deliveries are recorded once; address indexes are monotonic per scope', async () => {
    const s = make();
    expect(await s.recordWebhookDelivery('btcpay', 'd1', at)).toBe(true);
    expect(await s.recordWebhookDelivery('btcpay', 'd1', at)).toBe(false);
    expect(await s.recordWebhookDelivery('card', 'd1', at)).toBe(true);
    expect(await Promise.all([s.allocateAddressIndex('a'), s.allocateAddressIndex('a'), s.allocateAddressIndex('b')])).toEqual([0, 1, 0]);
    expect(await s.allocateAddressIndex('a')).toBe(2);
    await s.close?.();
  });

  it('returns copies, never live references', async () => {
    const s = make();
    const o = order('o1');
    await s.createOrder(o);
    o.metadata.k = 'mutated';
    const read = (await s.getOrder('o1'))!;
    expect(read.metadata.k).toBe('v');
    read.lineItems.push({ sku: 'x', description: 'x', quantity: 1, unitSats: 1 });
    expect((await s.getOrder('o1'))!.lineItems).toHaveLength(1);
    await s.close?.();
  });
});

describe('SqliteOrderStore migrations', () => {
  it('applies every migration once and is re-openable', () => {
    const s = new SqliteOrderStore(':memory:');
    expect(s.appliedMigrations()).toEqual(MIGRATIONS.map((m) => m.id));
    expect(new Set(MIGRATIONS.map((m) => m.id)).size).toBe(MIGRATIONS.length);
  });

  it('enforces CHECK constraints on status, product and method (psbt allowed since 0002)', async () => {
    const s = new SqliteOrderStore(':memory:');
    await expect(s.createOrder(order('o1', { status: 'bogus' as never }))).rejects.toThrow(/CHECK/);
    await expect(s.createOrder(order('o1', { product: 'ebay' as never }))).rejects.toThrow(/CHECK/);
    await expect(s.createPayment(payment('p1', 'o-missing'))).rejects.toThrow(/FOREIGN KEY|constraint/i);
    await expect(s.createOrder(order('o1'))).resolves.toBeUndefined();
    await expect(s.createPayment(payment('p1', 'o1', { method: 'paypal' as never }))).rejects.toThrow(/CHECK/);
    await expect(s.createPayment(payment('p1', 'o1', { method: 'psbt', provider: 'psbt' }))).resolves.toBeUndefined();
    await expect(s.createPayout(payout('y1', 'p1', 'o1', { status: 'lost' as never }))).rejects.toThrow(/CHECK/);
    await expect(s.createPayout(payout('y1', 'p-missing', 'o1'))).rejects.toThrow(/FOREIGN KEY|constraint/i);
    expect(s.appliedMigrations()).toHaveLength(MIGRATIONS.length);
    // foreign keys are back on after migrating
    expect((s as unknown as { db: DatabaseSync }).db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('0002 rebuilds payments in place: a 0001 database with rows migrates and keeps them', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-mig-')), 'ledger.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    raw.exec(MIGRATIONS[0]!.sql);
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(MIGRATIONS[0]!.id, at);
    raw.prepare(`INSERT INTO orders (id, product, customer_ref, total_sats, status, line_items, metadata, created_at, updated_at) VALUES ('o1','scribbit','c1',100,'paid','[]','{}',?,?)`).run(at, at);
    raw.prepare(`INSERT INTO payments (id, order_id, product, method, provider, provider_ref, amount_sats, amount_paid_sats, status, paid_at, txid, created_at, updated_at) VALUES ('p1','o1','scribbit','lightning','btcpay','inv-1',100,100,'paid',?,?,?,?)`).run(at, 'a'.repeat(64), at, at);
    raw.prepare(`INSERT INTO refunds (id, payment_id, order_id, amount_sats, status, reason, created_at, updated_at) VALUES ('r1','p1','o1',10,'pending','r',?,?)`).run(at, at);
    raw.close();

    const s = new SqliteOrderStore(path);
    expect(s.appliedMigrations()).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await s.getPayment('p1')).toMatchObject({ method: 'lightning', status: 'paid', amountPaidSats: 100, txid: 'a'.repeat(64), version: 0 });
    expect(await s.getRefund('r1')).toMatchObject({ status: 'pending', version: 0 });
    // the rebuilt table keeps its uniqueness and indexes and now accepts psbt; the old refund still references it
    await expect(s.createPayment(payment('p2', 'o1', { providerRef: 'inv-1' }))).rejects.toMatchObject({ code: 'duplicate_provider_ref' });
    await s.createPayment(payment('p3', 'o1', { method: 'psbt', provider: 'psbt', providerRef: 'p3' }));
    expect((await s.listPayoutsByOrder('o1')).length).toBe(0);
    await s.createPayout(payout('y1', 'p3', 'o1'));
    expect(await s.updateRefund({ ...(await s.getRefund('r1'))!, status: 'completed' })).toMatchObject({ version: 1 });
    await s.close();
    // re-opening applies nothing new
    const again = new SqliteOrderStore(path);
    expect(again.appliedMigrations()).toEqual(MIGRATIONS.map((m) => m.id));
    expect((await again.getPayout('y1'))!.payee.ref).toBe('artist-1');
    await again.close();
  });

  it('a duplicate id inside a store is an error, not silent', async () => {
    const s = new SqliteOrderStore(':memory:');
    await s.createOrder(order('o1'));
    await expect(s.createOrder(order('o1'))).rejects.toBeInstanceOf(LedgerError);
  });
});
