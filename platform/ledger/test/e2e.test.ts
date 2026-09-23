import { describe, expect, it } from 'vitest';
import { BtcpayProvider, LedgerWorker, StripeLikeProvider, fixedRate, type Order, type PaymentIntent, type Receipt } from '../src/index.js';
import { expectContract } from './contract.js';
import { FakeBtcpayServer, ORDER_TOTAL, cardWebhook, fakeClock, harness, json, orderBody } from './helpers.js';

describe('e2e: order → lightning invoice → BTCPay webhook → paid → event → receipt', () => {
  it('runs the whole flow over HTTP', async () => {
    const clock = fakeClock();
    const btcpay = new FakeBtcpayServer();
    const provider = new BtcpayProvider({ baseUrl: btcpay.baseUrl, storeId: btcpay.storeId, apiKey: btcpay.apiKey, webhookSecret: btcpay.webhookSecret, fetch: btcpay.fetch });
    const h = harness({ providers: [provider], clock });
    await h.ready;

    // 1. the product creates an order
    const order = (await expectContract(await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, headers: { 'Idempotency-Key': 'checkout-1' }, json: orderBody() }), '/v1/orders', 'post', 201)) as Order;

    // 2. and asks for a Lightning invoice
    const payment = (await expectContract(await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'lightning' } }), '/v1/orders/{id}/payments', 'post', 201)) as PaymentIntent;
    expect(payment).toMatchObject({ provider: 'btcpay', providerRef: 'inv1', status: 'created', amountSats: ORDER_TOTAL });
    expect(payment.checkout).toEqual({ bolt11: 'lnbcinv1fake', checkoutUrl: 'https://btcpay.test/i/inv1' });
    expect(btcpay.invoices.get('inv1')!.amount).toBe('0.00034200');

    // 3. the customer pays; BTCPay first reports a payment, then settles it
    const seen = btcpay.webhook('InvoiceReceivedPayment', 'inv1');
    btcpay.setStatus('inv1', 'Processing');
    expect(await expectContract(await h.req('/v1/webhooks/btcpay', { method: 'POST', headers: seen.headers, body: seen.body }), '/v1/webhooks/btcpay', 'post', 200)).toMatchObject({ received: true, applied: true, duplicate: false });
    expect(((await h.req(`/v1/payments/${payment.id}`, { key: h.keys.scribbit }).then((r) => r.json())) as PaymentIntent).status).toBe('pending');

    btcpay.settle('inv1', { txid: 'e'.repeat(64) });
    const settled = btcpay.webhook('InvoiceSettled', 'inv1');
    // a forged copy is refused before anything is looked at
    const forged = await h.req('/v1/webhooks/btcpay', { method: 'POST', headers: { ...settled.headers, 'BTCPay-Sig': `sha256=${'0'.repeat(64)}` }, body: settled.body });
    expect(forged.status).toBe(401);
    expect((await forged.json()).error.code).toBe('invalid_signature');
    expect(await expectContract(await h.req('/v1/webhooks/btcpay', { method: 'POST', headers: settled.headers, body: settled.body }), '/v1/webhooks/btcpay', 'post', 200)).toMatchObject({ applied: true });
    // BTCPay retries the same delivery: acknowledged, not re-applied
    expect(await expectContract(await h.req('/v1/webhooks/btcpay', { method: 'POST', headers: settled.headers, body: settled.body }), '/v1/webhooks/btcpay', 'post', 200)).toMatchObject({ applied: false, duplicate: true });

    // 4. ledger state
    const paid = (await expectContract(await h.req(`/v1/payments/${payment.id}`, { key: h.keys.scribbit }), '/v1/payments/{id}', 'get', 200)) as PaymentIntent;
    expect(paid).toMatchObject({ status: 'paid', amountPaidSats: ORDER_TOTAL, paidAt: clock.now().toISOString(), txid: 'e'.repeat(64) });
    const paidOrder = (await expectContract(await h.req(`/v1/orders/${order.id}`, { key: h.keys.scribbit }), '/v1/orders/{id}', 'get', 200)) as Order;
    expect(paidOrder.status).toBe('paid');

    // 5. events, in order, with CloudEvents attributes
    expect(h.events.map((e) => e.type)).toEqual([
      'ledger.order.created',
      'ledger.order.awaiting_payment',
      'ledger.payment.created',
      'ledger.payment.pending',
      'ledger.payment.paid',
      'ledger.order.paid',
    ]);
    const paidEvent = h.events.find((e) => e.type === 'ledger.payment.paid')!;
    expect(paidEvent).toMatchObject({ specversion: '1.0', source: 'urn:bsh:ledger', subject: order.id, datacontenttype: 'application/json' });
    expect(paidEvent.dataschema).toMatch(/platform-events\.yaml#\/components\/schemas\/LedgerPaymentStatusChanged$/);
    expect(paidEvent.data).toMatchObject({ paymentId: payment.id, orderId: order.id, product: 'scribbit', method: 'lightning', provider: 'btcpay', status: 'paid', previousStatus: 'pending', amountSats: ORDER_TOTAL, amountPaidSats: ORDER_TOTAL, txid: 'e'.repeat(64) });
    expect(h.events.at(-1)!.data).toMatchObject({ orderId: order.id, status: 'paid', previousStatus: 'awaiting_payment' });

    // 6. receipt
    const receipt = (await expectContract(await h.req(`/v1/orders/${order.id}/receipt`, { key: h.keys.scribbit }), '/v1/orders/{id}/receipt', 'get', 200)) as Receipt;
    expect(receipt.order.status).toBe('paid');
    expect(receipt.payments[0]).toMatchObject({ method: 'lightning', provider: 'btcpay', status: 'paid', amountPaidSats: ORDER_TOTAL, reference: 'inv1', txid: 'e'.repeat(64) });
    expect(receipt.totals).toEqual({ totalSats: ORDER_TOTAL, paidSats: ORDER_TOTAL, refundedSats: 0, dueSats: 0 });
    const text = await (await h.req(`/v1/orders/${order.id}/receipt?format=text`, { key: h.keys.scribbit })).text();
    expect(text).toContain('lightning/btcpay  paid');

    // 7. a refund goes out as a BTCPay pull payment and stays pending until claimed
    const refund = await (await h.req(`/v1/payments/${payment.id}/refund`, { method: 'POST', key: h.keys.scribbit, json: { reason: 'goodwill', amountSats: 1_000 } })).json();
    expect(refund).toMatchObject({ status: 'pending', providerRef: 'pp_inv1', amountSats: 1_000 });
  });

  it('the worker reconciles a settled invoice even when no webhook arrives', async () => {
    const clock = fakeClock();
    const btcpay = new FakeBtcpayServer();
    const provider = new BtcpayProvider({ baseUrl: btcpay.baseUrl, storeId: btcpay.storeId, apiKey: btcpay.apiKey, webhookSecret: btcpay.webhookSecret, fetch: btcpay.fetch });
    const h = harness({ providers: [provider], clock });
    const worker = new LedgerWorker({ service: h.service, store: h.store, providers: [provider], now: clock.now });
    const order = await (await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, json: orderBody() })).json();
    const p = (await (await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'onchain' } })).json()) as PaymentIntent;
    expect(p.checkout.address).toBe('bc1qinv1fake');
    expect(await worker.tick()).toEqual({ polled: 1, applied: 0, errors: 0 });
    btcpay.settle('inv1', { over: true, paidBtc: '0.00040000' });
    expect(await worker.tick()).toMatchObject({ applied: 1 });
    expect((await h.service.getPayment(p.id, { product: null }))).toMatchObject({ status: 'overpaid', amountPaidSats: 40_000 });
    expect((await h.service.getOrder(order.id, { product: null })).status).toBe('paid');
    // an invoice BTCPay expired without payment
    const o2 = await (await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, json: orderBody() })).json();
    const p2 = (await (await h.req(`/v1/orders/${o2.id}/payments`, { method: 'POST', key: h.keys.scribbit, json: { method: 'lightning' } })).json()) as PaymentIntent;
    btcpay.setStatus(p2.providerRef, 'Expired');
    await worker.tick();
    expect((await h.service.getPayment(p2.id, { product: null })).status).toBe('expired');
    expect((await h.service.getOrder(o2.id, { product: null })).status).toBe('awaiting_payment');
  });
});

describe('e2e: card checkout with a Stripe-shaped processor', () => {
  it('order → card intent (client secret) → signed webhook → paid → refund webhook', async () => {
    const clock = fakeClock();
    const status = new Map<string, string>();
    const card = new StripeLikeProvider({
      baseUrl: 'https://cards.test',
      secretKey: 'sk',
      webhookSecret: 'whsec',
      rates: fixedRate(6_500_000),
      fiatCurrency: 'usd',
      fetch: async (url, init) => {
        if (url.endsWith('/v1/payment_intents')) {
          status.set('pi_1', 'requires_payment_method');
          return json({ id: 'pi_1', client_secret: 'pi_1_secret_x', status: 'requires_payment_method' });
        }
        if (url.endsWith('/v1/payment_intents/pi_1')) return json({ id: 'pi_1', status: status.get('pi_1') });
        if (url.endsWith('/v1/refunds')) return json({ id: 're_1', status: 'pending' });
        throw new Error(`unexpected ${init?.method} ${url}`);
      },
    });
    const h = harness({ providers: [card], clock });
    await h.ready;
    const order = await (await h.req('/v1/orders', { method: 'POST', key: h.keys.degent, json: orderBody({ product: 'degent' }) })).json();
    const p = (await expectContract(await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.degent, json: { method: 'card' } }), '/v1/orders/{id}/payments', 'post', 201)) as PaymentIntent;
    expect(p.checkout).toEqual({ clientSecret: 'pi_1_secret_x' });
    expect(p.providerData).toMatchObject({ fiatCurrency: 'usd', fiatMinor: 2223 });
    expect(JSON.stringify(p)).not.toMatch(/4242|card_number|cvc/);

    // the browser completed 3DS with the processor; the processor tells us
    status.set('pi_1', 'succeeded');
    const hook = cardWebhook('whsec', { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', status: 'succeeded' } } });
    expect(await expectContract(await h.req('/v1/webhooks/card', { method: 'POST', headers: hook.headers, body: hook.body }), '/v1/webhooks/card', 'post', 200)).toMatchObject({ applied: true });
    expect((await h.service.getPayment(p.id, { product: null }))).toMatchObject({ status: 'paid', amountPaidSats: ORDER_TOTAL });
    expect((await h.service.getOrder(order.id, { product: null })).status).toBe('paid');
    // replayed event id → duplicate; stale timestamp → 401
    expect(await (await h.req('/v1/webhooks/card', { method: 'POST', headers: hook.headers, body: hook.body })).json()).toMatchObject({ duplicate: true });
    const stale = cardWebhook('whsec', { id: 'evt_9', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } }, Math.floor(clock.now().getTime() / 1000) - 3600);
    expect((await h.req('/v1/webhooks/card', { method: 'POST', headers: stale.headers, body: stale.body })).status).toBe(401);

    // refund: pending at the processor, completed by its webhook
    const refund = await (await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.degent, json: { reason: 'returned' } })).json();
    expect(refund).toMatchObject({ status: 'pending', providerRef: 're_1' });
    const rHook = cardWebhook('whsec', { id: 'evt_2', type: 'refund.updated', data: { object: { id: 're_1', status: 'succeeded', payment_intent: 'pi_1' } } });
    expect(await (await h.req('/v1/webhooks/card', { method: 'POST', headers: rHook.headers, body: rHook.body })).json()).toMatchObject({ applied: true });
    expect((await h.service.getRefund(refund.id, { product: null })).status).toBe('completed');
    expect((await h.service.getPayment(p.id, { product: null })).status).toBe('refunded');
    expect((await h.service.getOrder(order.id, { product: null })).status).toBe('refunded');
    expect(h.events.map((e) => e.type).slice(-2)).toEqual(['ledger.payment.refunded', 'ledger.order.refunded']);
  });
});
