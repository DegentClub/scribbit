import { describe, expect, it } from 'vitest';
import type { Order, PaymentIntent, Payout, Refund } from '../src/index.js';
import { assertSchema, expectContract, openapi } from './contract.js';
import { ORDER_TOTAL, createOrder, harness, orderBody } from './helpers.js';

describe('contract file', () => {
  it('is OpenAPI 3.1 and declares every route the app serves', () => {
    expect(openapi.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(openapi.paths).sort()).toEqual(
      [
        '/v1/health',
        '/v1/orders',
        '/v1/orders/{id}',
        '/v1/orders/{id}/cancel',
        '/v1/orders/{id}/payments',
        '/v1/orders/{id}/payouts',
        '/v1/orders/{id}/receipt',
        '/v1/payees/{ref}/payouts',
        '/v1/payments/{id}',
        '/v1/payments/{id}/observations',
        '/v1/payments/{id}/refund',
        '/v1/refunds/{id}',
        '/v1/refunds/{id}/settle',
        '/v1/webhooks/btcpay',
        '/v1/webhooks/card',
      ].sort(),
    );
  });
});

describe('GET /v1/health', () => {
  it('needs no key and lists providers', async () => {
    const h = harness();
    const body = (await expectContract(await h.req('/v1/health'), '/v1/health', 'get', 200)) as { providers: string[] };
    expect(body.providers).toEqual(['fake']);
  });
});

describe('authentication and scoping', () => {
  it('rejects missing/invalid keys with the uniform error body', async () => {
    const h = harness();
    const r1 = await h.req('/v1/orders', { method: 'POST', json: orderBody() });
    expect(r1.status).toBe(401);
    assertSchema('Error', await r1.json());
    const r2 = await h.req('/v1/orders', { method: 'POST', key: 'bsh_test_nope', json: orderBody() });
    expect((await r2.json()).error.code).toBe('invalid_api_key');
    const r3 = await h.req('/v1/orders', { method: 'POST', key: h.keys.noProduct, json: orderBody() });
    expect(r3.status).toBe(403);
    expect((await r3.json()).error.code).toBe('no_product');
  });

  it('a key sees only its product; admin sees all; product mismatch is 403', async () => {
    const h = harness();
    const order = await createOrder(h);
    expect((await h.req(`/v1/orders/${order.id}`, { key: h.keys.degent })).status).toBe(404);
    expect((await h.req(`/v1/orders/${order.id}`, { key: h.keys.scribbit })).status).toBe(200);
    expect((await h.req(`/v1/orders/${order.id}`, { key: h.keys.admin })).status).toBe(200);
    const mismatch = await h.req('/v1/orders', { method: 'POST', key: h.keys.degent, json: orderBody({ product: 'scribbit' }) });
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).error.code).toBe('product_mismatch');
    // product may be omitted with a product-bound key
    const omitted = await h.req('/v1/orders', { method: 'POST', key: h.keys.degent, json: orderBody({ product: undefined }) });
    expect(((await expectContract(omitted, '/v1/orders', 'post', 201)) as Order).product).toBe('degent');
  });
});

describe('POST /v1/orders', () => {
  it('creates an order with the summed total and emits ledger.order.created', async () => {
    const h = harness();
    await h.ready;
    const res = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, json: orderBody() });
    const order = (await expectContract(res, '/v1/orders', 'post', 201)) as Order;
    expect(order).toMatchObject({ product: 'scribbit', customerRef: 'user-42', totalSats: ORDER_TOTAL, status: 'created', currency: 'sat', metadata: { batch: 'b-1' }, version: 0 });
    expect(order.id).toMatch(/^ord_/);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(h.events.map((e) => e.type)).toEqual(['ledger.order.created']);
    expect(h.events[0]!.data).toMatchObject({ orderId: order.id, status: 'created', previousStatus: null, totalSats: ORDER_TOTAL });
  });

  it('validates the body', async () => {
    const h = harness();
    const bad = async (json: unknown, code = 'invalid_request') => {
      const r = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      const body = await r.json();
      assertSchema('Error', body);
      expect(body.error.code).toBe(code);
      return body.error.message as string;
    };
    expect(await bad(orderBody({ lineItems: [] }))).toMatch(/lineItems/);
    expect(await bad(orderBody({ lineItems: [{ sku: 'a', description: 'b', quantity: 1.5, unitSats: 1 }] }))).toMatch(/quantity/);
    expect(await bad(orderBody({ lineItems: [{ sku: 'a', description: 'b', quantity: 1, unitSats: -1 }] }))).toMatch(/unitSats/);
    expect(await bad(orderBody({ lineItems: [{ sku: 'a', description: 'b', quantity: 1, unitSats: 1e16 }] }))).toMatch(/unitSats/);
    expect(await bad(orderBody({ customerRef: '' }))).toMatch(/customerRef/);
    const li = (payee: unknown) => [{ sku: 'a', description: 'b', quantity: 1, unitSats: 1, payee }];
    expect(await bad(orderBody({ lineItems: li({ kind: 'sponsor', ref: 'x', address: 'bc1q' }) }))).toMatch(/payee\.kind/);
    expect(await bad(orderBody({ lineItems: li({ kind: 'artist', ref: '', address: 'bc1q' }) }))).toMatch(/payee\.ref/);
    expect(await bad(orderBody({ lineItems: li({ kind: 'artist', ref: 'x'.repeat(129), address: 'bc1q' }) }))).toMatch(/payee\.ref/);
    expect(await bad(orderBody({ lineItems: li({ kind: 'artist', ref: 'a' }) }))).toMatch(/exactly one of address \/ scriptHex/);
    expect(await bad(orderBody({ lineItems: li({ kind: 'artist', ref: 'a', address: 'bc1q', scriptHex: '0014' }) }))).toMatch(/exactly one of/);
    expect(await bad(orderBody({ lineItems: li({ kind: 'artist', ref: 'a', scriptHex: '001' }) }))).toMatch(/scriptHex/);
    expect(await bad(orderBody({ lineItems: li({ kind: 'artist', ref: 'a', scriptHex: 'zz' }) }))).toMatch(/scriptHex/);
    expect(await bad(orderBody({ lineItems: li('artist') }))).toMatch(/payee must be an object/);
    expect(await bad(orderBody({ metadata: { k: 1 as never } }))).toMatch(/metadata/);
    expect(await bad([])).toMatch(/object/);
    const notJson = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect((await notJson.json()).error.code).toBe('invalid_json');
    const wrongType = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(wrongType.status).toBe(415);
  });

  it('accepts payees on line items (address or scriptHex; hex is normalised to lowercase)', async () => {
    const h = harness();
    const lineItems = [
      { sku: 'art', description: 'Artist share', quantity: 1, unitSats: 1_000, payee: { kind: 'artist', ref: 'artist-7', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' } },
      { sku: 'club', description: 'Club fee', quantity: 2, unitSats: 250, payee: { kind: 'club', ref: 'degent-club', scriptHex: '0014' + 'AB'.repeat(20) } },
      { sku: 'mint', description: 'Mint', quantity: 1, unitSats: 8_000 },
    ];
    const order = (await expectContract(await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, json: orderBody({ lineItems }) }), '/v1/orders', 'post', 201)) as Order;
    expect(order.lineItems[0]!.payee).toEqual({ kind: 'artist', ref: 'artist-7', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    expect(order.lineItems[1]!.payee).toEqual({ kind: 'club', ref: 'degent-club', scriptHex: '0014' + 'ab'.repeat(20) });
    expect(order.lineItems[2]!.payee).toBeUndefined();
    expect(order.totalSats).toBe(9_500);
    // the same payees come back from the store and the receipt
    expect(((await expectContract(await h.req(`/v1/orders/${order.id}`, { key: h.keys.scribbit }), '/v1/orders/{id}', 'get', 200)) as Order).lineItems[1]!.payee!.ref).toBe('degent-club');
    await expectContract(await h.req(`/v1/orders/${order.id}/receipt`, { key: h.keys.scribbit }), '/v1/orders/{id}/receipt', 'get', 200);
    // psbt needs a payee on every line
    const noPsbt = await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'psbt' } });
    expect((await noPsbt.json()).error.code).toBe('method_unavailable'); // the fake provider does not serve psbt
  });

  it('is idempotent under Idempotency-Key, per product', async () => {
    const h = harness();
    const headers = { 'Idempotency-Key': 'order-abc' };
    const first = (await expectContract(await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers, json: orderBody() }), '/v1/orders', 'post', 201)) as Order;
    const replay = (await expectContract(await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers, json: orderBody() }), '/v1/orders', 'post', 200)) as Order;
    expect(replay).toEqual(first);
    const conflict = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers, json: orderBody({ customerRef: 'someone-else' }) });
    expect(conflict.status).toBe(422);
    expect((await conflict.json()).error.code).toBe('idempotency_conflict');
    // another product's key with the same Idempotency-Key is a different scope
    const other = await h.req('/v1/orders', { method: 'POST', key: h.keys.degent, headers, json: orderBody({ product: 'degent' }) });
    expect(other.status).toBe(201);
    const badKey = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers: { 'Idempotency-Key': 'has space' }, json: orderBody() });
    expect((await badKey.json()).error.code).toBe('invalid_idempotency_key');
  });
});

describe('payments', () => {
  it('opens one intent per order, exposes checkout, blocks a second active intent', async () => {
    const h = harness();
    await h.ready;
    const order = await createOrder(h);
    const res = await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, headers: { 'Idempotency-Key': 'p1' }, json: { method: 'lightning' } });
    const p = (await expectContract(res, '/v1/orders/{id}/payments', 'post', 201)) as PaymentIntent;
    expect(p).toMatchObject({ orderId: order.id, method: 'lightning', provider: 'fake', amountSats: ORDER_TOTAL, status: 'created', amountPaidSats: 0 });
    expect(p.checkout.bolt11).toMatch(/^lnbcrt/);
    expect(p.id).toMatch(/^pay_/);
    expect(((await expectContract(await h.req(`/v1/orders/${order.id}`, { key: h.keys.scribbit }), '/v1/orders/{id}', 'get', 200)) as Order).status).toBe('awaiting_payment');
    expect(h.events.map((e) => e.type)).toEqual(['ledger.order.created', 'ledger.order.awaiting_payment', 'ledger.payment.created']);

    const replay = (await expectContract(await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, headers: { 'Idempotency-Key': 'p1' }, json: { method: 'lightning' } }), '/v1/orders/{id}/payments', 'post', 200)) as PaymentIntent;
    expect(replay.id).toBe(p.id);
    const second = await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'onchain' } });
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('payment_active');
    const badMethod = await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'paypal' } });
    expect(badMethod.status).toBe(400);
    const badProvider = await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'card', provider: 'nope' } });
    expect((await badProvider.json()).error.code).toBe('method_unavailable');
    expect((await h.req(`/v1/payments/${p.id}`, { key: h.keys.degent })).status).toBe(404);
    await expectContract(await h.req(`/v1/payments/${p.id}`, { key: h.keys.scribbit }), '/v1/payments/{id}', 'get', 200);
    const list = (await expectContract(await h.req(`/v1/orders/${order.id}/payments`, { key: h.keys.scribbit }), '/v1/orders/{id}/payments', 'get', 200)) as { payments: PaymentIntent[] };
    expect(list.payments.map((x) => x.id)).toEqual([p.id]);
  });

  it('an expired/failed intent frees the order for another attempt; a paid order takes no more', async () => {
    const h = harness();
    const order = await createOrder(h);
    const p1 = (await (await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'card' } })).json()) as PaymentIntent;
    h.fake.fail(p1.providerRef);
    await h.service.applyUpdate(p1.id, (await h.fake.poll(p1))!);
    expect((await h.service.getOrder(order.id, { product: null })).status).toBe('awaiting_payment');
    const p2 = (await expectContract(await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'lightning' } }), '/v1/orders/{id}/payments', 'post', 201)) as PaymentIntent;
    h.fake.settle(p2.providerRef);
    await h.service.applyUpdate(p2.id, (await h.fake.poll(p2))!);
    const paidOrder = (await expectContract(await h.req(`/v1/orders/${order.id}`, { key: h.keys.scribbit }), '/v1/orders/{id}', 'get', 200)) as Order;
    expect(paidOrder.status).toBe('paid');
    const third = await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'card' } });
    expect((await third.json()).error.code).toBe('order_not_payable');
    const cancel = await h.req(`/v1/orders/${order.id}/cancel`, { method: 'POST', key: h.keys.scribbit });
    expect((await cancel.json()).error.code).toBe('illegal_transition');
  });

  it('cancel works before payment and is refused while a payment is pending', async () => {
    const h = harness();
    const order = await createOrder(h);
    const p = (await (await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'onchain' } })).json()) as PaymentIntent;
    h.fake.pending(p.providerRef, 100);
    await h.service.applyUpdate(p.id, (await h.fake.poll(p))!);
    expect((await (await h.req(`/v1/orders/${order.id}/cancel`, { method: 'POST', key: h.keys.scribbit })).json()).error.code).toBe('payment_active');
    const o2 = await createOrder(h);
    const cancelled = (await expectContract(await h.req(`/v1/orders/${o2.id}/cancel`, { method: 'POST', key: h.keys.scribbit }), '/v1/orders/{id}/cancel', 'post', 200)) as Order;
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('refunds', () => {
  async function paidOrder(h: ReturnType<typeof harness>, amount?: number) {
    const order = await createOrder(h);
    const p = (await (await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'card' } })).json()) as PaymentIntent;
    h.fake.settle(p.providerRef, amount);
    await h.service.applyUpdate(p.id, (await h.fake.poll(p))!);
    return { order, p };
  }

  it('full refund flips the intent and the order to refunded and emits events', async () => {
    const h = harness();
    await h.ready;
    const { order, p } = await paidOrder(h);
    const notYet = await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: {} });
    expect(notYet.status).toBe(400);
    const res = await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, headers: { 'Idempotency-Key': 'r1' }, json: { reason: 'customer request' } });
    const refund = (await expectContract(res, '/v1/payments/{id}/refund', 'post', 201)) as Refund;
    expect(refund).toMatchObject({ paymentId: p.id, orderId: order.id, amountSats: ORDER_TOTAL, status: 'completed', providerRef: 'fake-refund' });
    expect(refund.id).toMatch(/^ref_/);
    const replay = (await expectContract(await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, headers: { 'Idempotency-Key': 'r1' }, json: { reason: 'customer request' } }), '/v1/payments/{id}/refund', 'post', 200)) as Refund;
    expect(replay.id).toBe(refund.id);
    expect(((await expectContract(await h.req(`/v1/payments/${p.id}`, { key: h.keys.scribbit }), '/v1/payments/{id}', 'get', 200)) as PaymentIntent)).toMatchObject({ status: 'refunded', refundedSats: ORDER_TOTAL });
    expect(((await h.req(`/v1/orders/${order.id}`, { key: h.keys.scribbit }).then((r) => r.json())) as Order).status).toBe('refunded');
    await expectContract(await h.req(`/v1/refunds/${refund.id}`, { key: h.keys.scribbit }), '/v1/refunds/{id}', 'get', 200);
    expect((await h.req(`/v1/refunds/${refund.id}`, { key: h.keys.degent })).status).toBe(404);
    expect(h.events.map((e) => e.type).slice(-4)).toEqual(['ledger.payment.paid', 'ledger.order.paid', 'ledger.payment.refunded', 'ledger.order.refunded']);
    const again = await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'twice' } });
    expect((await again.json()).error.code).toBe('not_refundable');
  });

  it('partial refunds accumulate; over-refund is refused; overpaid defaults to the excess', async () => {
    const h = harness();
    const { p } = await paidOrder(h);
    const a = (await (await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'partial', amountSats: 1_000 } })).json()) as Refund;
    expect(a.status).toBe('completed');
    const tooMuch = await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'x', amountSats: ORDER_TOTAL } });
    expect((await tooMuch.json()).error.code).toBe('refund_exceeds_paid');
    const rest = (await (await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'rest' } })).json()) as Refund;
    expect(rest.amountSats).toBe(ORDER_TOTAL - 1_000);
    expect((await h.service.getPayment(p.id, { product: null })).status).toBe('refunded');

    const { p: over } = await paidOrder(h, ORDER_TOTAL + 777);
    expect((await h.service.getPayment(over.id, { product: null })).status).toBe('overpaid');
    const excess = (await (await h.req(`/v1/payments/${over.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'excess' } })).json()) as Refund;
    expect(excess.amountSats).toBe(777);
    expect((await h.service.getPayment(over.id, { product: null })).status).toBe('overpaid'); // still settled
  });

  it('pending refunds are settled by an admin; product keys may not', async () => {
    const h = harness();
    const { p } = await paidOrder(h);
    h.fake.refundResult = { status: 'pending', providerRef: 'manual' };
    const r = (await (await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'manual', destination: 'bc1qx' } })).json()) as Refund;
    expect(r.status).toBe('pending');
    const forbidden = await h.req(`/v1/refunds/${r.id}/settle`, { method: 'POST', key: h.keys.scribbit, json: { status: 'completed' } });
    expect(forbidden.status).toBe(403);
    const bad = await h.req(`/v1/refunds/${r.id}/settle`, { method: 'POST', key: h.keys.admin, json: { status: 'maybe' } });
    expect(bad.status).toBe(400);
    const settled = (await expectContract(await h.req(`/v1/refunds/${r.id}/settle`, { method: 'POST', key: h.keys.admin, json: { status: 'completed', detail: 'txid abc' } }), '/v1/refunds/{id}/settle', 'post', 200)) as Refund;
    expect(settled).toMatchObject({ status: 'completed', detail: 'txid abc' });
    expect((await h.service.getPayment(p.id, { product: null })).status).toBe('refunded');
    const twice = await h.req(`/v1/refunds/${r.id}/settle`, { method: 'POST', key: h.keys.admin, json: { status: 'failed' } });
    expect((await twice.json()).error.code).toBe('illegal_transition');
  });

  it('pending refunds reserve their amount: two concurrent on-chain refunds cannot exceed amountPaid', async () => {
    const h = harness();
    const { p } = await paidOrder(h); // amountPaidSats = ORDER_TOTAL = 34_200
    h.fake.refundResult = { status: 'pending', providerRef: null, detail: 'manual payout' }; // on-chain style: stays pending
    const ctx = { product: 'scribbit' as const };
    const results = await Promise.allSettled([
      h.service.refund(p.id, { reason: 'a', amountSats: 20_000, destination: 'bc1qa' }, ctx),
      h.service.refund(p.id, { reason: 'b', amountSats: 20_000, destination: 'bc1qb' }, ctx),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'refund_exceeds_paid' });
    const pending = (await h.service.listRefunds(p.orderId, ctx)).filter((r) => r.status === 'pending');
    expect(pending.reduce((s, r) => s + r.amountSats, 0)).toBeLessThanOrEqual(ORDER_TOTAL);
    expect(pending).toHaveLength(1);
    // sequentially: the pending 20_000 is reserved, so only 14_200 is left
    await expect(h.service.refund(p.id, { reason: 'c', amountSats: 14_201, destination: 'bc1qc' }, ctx)).rejects.toMatchObject({ code: 'refund_exceeds_paid' });
    const rest = await h.service.refund(p.id, { reason: 'c', destination: 'bc1qc' }, ctx); // default = what is left
    expect(rest.refund.amountSats).toBe(14_200);
    await expect(h.service.refund(p.id, { reason: 'd', destination: 'bc1qd' }, ctx)).rejects.toMatchObject({ code: 'nothing_to_refund' });
    await expect(h.service.refund(p.id, { reason: 'd', amountSats: 1, destination: 'bc1qd' }, ctx)).rejects.toMatchObject({ code: 'refund_exceeds_paid', message: expect.stringMatching(/34200 reserved/) });
    // a failed payout releases its reservation; a completed one moves it to refundedSats
    await h.service.settleRefund(rest.refund.id, 'failed', 'address bounced');
    await h.service.settleRefund(pending[0]!.id, 'completed', 'txid …');
    expect(await h.service.getPayment(p.id, ctx)).toMatchObject({ refundedSats: 20_000, status: 'paid' });
    const again = await h.service.refund(p.id, { reason: 'e', destination: 'bc1qe' }, ctx);
    expect(again.refund.amountSats).toBe(14_200);
    // the version bump used as the reservation lock is visible on the payment
    expect((await h.service.getPayment(p.id, ctx)).version).toBeGreaterThanOrEqual(4);
  });
});

describe('payouts (API surface without a psbt provider)', () => {
  it('lists nothing for an order without payouts; payee listing is scoped and validates kind', async () => {
    const h = harness();
    const order = await createOrder(h);
    const list = (await expectContract(await h.req(`/v1/orders/${order.id}/payouts`, { key: h.keys.scribbit }), '/v1/orders/{id}/payouts', 'get', 200)) as { payouts: Payout[] };
    expect(list.payouts).toEqual([]);
    expect((await h.req(`/v1/orders/${order.id}/payouts`, { key: h.keys.degent })).status).toBe(404);
    expect((await h.req('/v1/payees/artist-1/payouts')).status).toBe(401);
    const empty = (await expectContract(await h.req('/v1/payees/artist-1/payouts', { key: h.keys.scribbit }), '/v1/payees/{ref}/payouts', 'get', 200)) as { payouts: Payout[] };
    expect(empty.payouts).toEqual([]);
    const badKind = await h.req('/v1/payees/artist-1/payouts?kind=sponsor', { key: h.keys.scribbit });
    expect(badKind.status).toBe(400);
    assertSchema('Error', await badKind.json());
    expect((await h.req(`/v1/payees/${'x'.repeat(129)}/payouts`, { key: h.keys.scribbit })).status).toBe(400);
  });
});

describe('receipts', () => {
  it('render as JSON (contract) and plain text', async () => {
    const h = harness();
    const order = await createOrder(h);
    const p = (await (await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'lightning' } })).json()) as PaymentIntent;
    h.fake.settle(p.providerRef, undefined, { txid: 'c'.repeat(64) });
    await h.service.applyUpdate(p.id, (await h.fake.poll(p))!);
    const receipt = (await expectContract(await h.req(`/v1/orders/${order.id}/receipt`, { key: h.keys.scribbit }), '/v1/orders/{id}/receipt', 'get', 200)) as { receiptId: string; totals: unknown; payments: unknown[] };
    expect(receipt.receiptId).toBe(`rcpt_${order.id.slice(4)}`);
    expect(receipt.totals).toEqual({ totalSats: ORDER_TOTAL, paidSats: ORDER_TOTAL, refundedSats: 0, dueSats: 0 });
    expect(receipt.payments).toHaveLength(1);
    const text = await h.req(`/v1/orders/${order.id}/receipt`, { key: h.keys.scribbit, headers: { accept: 'text/plain' } });
    expect(text.headers.get('content-type')).toMatch(/^text\/plain/);
    const t = await text.text();
    expect(t).toContain(`RECEIPT rcpt_${order.id.slice(4)}`);
    expect(t).toContain('2 x Standard inscription [inscribe-std]');
    expect(t).toContain(`TOTAL${' '.repeat(43)} ${String(ORDER_TOTAL).padStart(20)} sat`);
    expect(t).toContain('txid ' + 'c'.repeat(64));
    expect(t).toContain('Due      0 sat (0.00000000 BTC)');
    expect(t.split('\n').every((l) => l.length <= 100 && /^[\x20-\x7e]*$/.test(l))).toBe(true);
    const viaQuery = await h.req(`/v1/orders/${order.id}/receipt?format=text`, { key: h.keys.scribbit });
    expect(await viaQuery.text()).toBe(t);
    expect((await h.req(`/v1/orders/${order.id}/receipt`, { key: h.keys.degent })).status).toBe(404);
  });
});

describe('edge behaviour', () => {
  it('unknown routes and webhook signature failures use the uniform body; security headers are set', async () => {
    const h = harness();
    const nf = await h.req('/v1/nothing', { key: h.keys.scribbit });
    expect(nf.status).toBe(404);
    assertSchema('Error', await nf.json());
    const wh = await h.req('/v1/webhooks/btcpay', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(wh.status).toBe(404); // fake provider has no webhook receiver → route not wired for it
    expect(wh.headers.get('x-content-type-options')).toBe('nosniff');
    expect(wh.headers.get('cache-control')).toBe('no-store');
    const big = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) }, body: '{}' });
    expect(big.status).toBe(413);
  });
});
