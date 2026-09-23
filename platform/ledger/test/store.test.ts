import { describe, expect, it } from 'vitest';
import { ConcurrencyError, LedgerError, MIGRATIONS, MemoryOrderStore, SqliteOrderStore, type Order, type OrderStore, type PaymentIntent, type Refund } from '../src/index.js';

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
const refund = (id: string, paymentId: string, orderId: string): Refund => ({ id, paymentId, orderId, amountSats: 10, status: 'pending', reason: 'r', providerRef: null, destination: null, detail: null, createdAt: at, updatedAt: at });

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
    expect(r.status).toBe('completed');
    expect((await s.listRefundsByPayment('p1')).map((x) => x.id)).toEqual(['r1']);
    expect((await s.listRefundsByOrder('o1')).map((x) => x.status)).toEqual(['completed']);
    await expect(s.updateRefund(refund('zz', 'p1', 'o1'))).rejects.toMatchObject({ code: 'not_found' });
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

  it('enforces CHECK constraints on status and product', async () => {
    const s = new SqliteOrderStore(':memory:');
    await expect(s.createOrder(order('o1', { status: 'bogus' as never }))).rejects.toThrow(/CHECK/);
    await expect(s.createOrder(order('o1', { product: 'ebay' as never }))).rejects.toThrow(/CHECK/);
    await expect(s.createPayment(payment('p1', 'o-missing'))).rejects.toThrow(/FOREIGN KEY|constraint/i);
    await expect(s.createOrder(order('o1'))).resolves.toBeUndefined();
    expect(s.appliedMigrations()).toHaveLength(MIGRATIONS.length);
  });

  it('a duplicate id inside a store is an error, not silent', async () => {
    const s = new SqliteOrderStore(':memory:');
    await s.createOrder(order('o1'));
    await expect(s.createOrder(order('o1'))).rejects.toBeInstanceOf(LedgerError);
  });
});
