import { describe, expect, it } from 'vitest';
import { BtcpayProvider, LedgerService, MemoryOrderStore, WebhookError, mapBtcpayInvoice, mapBtcpayWebhookType, verifyBtcpaySignature, type BtcpayInvoice } from '../src/index.js';
import { FakeBtcpayServer, T0, fakeClock, hmacHex, seqIds } from './helpers.js';

const now = new Date(T0);

describe('verifyBtcpaySignature', () => {
  const body = '{"invoiceId":"inv1","type":"InvoiceSettled"}';
  const sig = `sha256=${hmacHex('s3cret', body)}`;

  it('accepts a correct signature (any hex case) and rotation secrets', () => {
    expect(verifyBtcpaySignature(body, sig, 's3cret')).toBe(true);
    expect(verifyBtcpaySignature(body, sig.toUpperCase().replace('SHA256', 'sha256'), 's3cret')).toBe(true);
    expect(verifyBtcpaySignature(body, sig, ['old', 's3cret'])).toBe(true);
  });

  it('rejects missing, malformed, wrong-secret and tampered-body signatures', () => {
    expect(verifyBtcpaySignature(body, null, 's3cret')).toBe(false);
    expect(verifyBtcpaySignature(body, '', 's3cret')).toBe(false);
    expect(verifyBtcpaySignature(body, sig.slice(7), 's3cret')).toBe(false); // no scheme prefix
    expect(verifyBtcpaySignature(body, 'sha256=abc', 's3cret')).toBe(false);
    expect(verifyBtcpaySignature(body, sig, 'other')).toBe(false);
    expect(verifyBtcpaySignature(body + ' ', sig, 's3cret')).toBe(false);
  });
});

describe('BTCPay state mapping', () => {
  const inv = (status: BtcpayInvoice['status'], additionalStatus?: BtcpayInvoice['additionalStatus']): BtcpayInvoice => ({ id: 'i', status, amount: '0.0001', currency: 'BTC', ...(additionalStatus ? { additionalStatus } : {}) });
  const paidMethods = [{ paymentMethodId: 'BTC-LN', totalPaid: '0.0001', payments: [{ id: 'f'.repeat(64), value: '0.0001', status: 'Settled' as const }] }];

  it.each([
    ['New', undefined, undefined],
    ['Processing', undefined, 'pending'],
    ['Settled', undefined, 'paid'],
    ['Settled', 'PaidOver', 'overpaid'],
    ['Expired', undefined, 'expired'],
    ['Expired', 'PaidPartial', 'underpaid'],
    ['Expired', 'PaidLate', 'pending'],
    ['Invalid', undefined, 'failed'],
    ['Invalid', 'Marked', 'failed'],
  ] as const)('invoice %s/%s -> %s', (status, add, expected) => {
    const u = mapBtcpayInvoice(inv(status, add), paidMethods, now);
    expect(u?.status).toBe(expected);
    if (expected === 'paid') expect(u).toMatchObject({ amountPaidSats: 10_000, paidAt: now.toISOString(), txid: 'f'.repeat(64) });
  });

  it.each([
    ['InvoiceCreated', {}, undefined],
    ['InvoiceReceivedPayment', {}, 'pending'],
    ['InvoiceProcessing', {}, 'pending'],
    ['InvoicePaymentSettled', {}, 'pending'],
    ['InvoiceSettled', {}, 'paid'],
    ['InvoiceSettled', { overPaid: true }, 'overpaid'],
    ['InvoiceExpired', {}, 'expired'],
    ['InvoiceExpired', { partiallyPaid: true }, 'underpaid'],
    ['InvoiceInvalid', {}, 'failed'],
    ['SomethingElse', {}, undefined],
  ] as const)('webhook %s %j -> %s', (type, body, expected) => {
    expect(mapBtcpayWebhookType(type, body)).toBe(expected);
  });
});

describe('BtcpayProvider against a fake Greenfield server', () => {
  const server = new FakeBtcpayServer();
  const provider = new BtcpayProvider({ baseUrl: server.baseUrl, storeId: server.storeId, apiKey: server.apiKey, webhookSecret: server.webhookSecret, fetch: server.fetch });
  const order = { id: 'ord_1', product: 'scribbit' } as never;

  it('creates lightning and on-chain invoices with the right payment methods and amounts', async () => {
    const ln = await provider.createIntent({ intentId: 'pay_1', order, method: 'lightning', amountSats: 34_200, expiresAt: null, now });
    expect(ln).toMatchObject({ providerRef: 'inv1', checkout: { bolt11: 'lnbcinv1fake', checkoutUrl: 'https://btcpay.test/i/inv1' } });
    const create = server.requests.find((r) => r.method === 'POST' && r.url.endsWith('/invoices'))!;
    expect(create.body).toMatchObject({ amount: '0.00034200', currency: 'BTC', checkout: { paymentMethods: ['BTC-LightningNetwork'], expirationMinutes: 15 }, metadata: { orderId: 'ord_1', paymentId: 'pay_1' } });
    expect(create.auth).toBe('token apikey-secret');

    const oc = await provider.createIntent({ intentId: 'pay_2', order, method: 'onchain', amountSats: 1, expiresAt: new Date(T0 + 45 * 60_000).toISOString(), now });
    expect(oc.checkout).toEqual({ address: 'bc1qinv2fake', checkoutUrl: 'https://btcpay.test/i/inv2' });
    expect(server.requests.at(-2)!.body).toMatchObject({ amount: '0.00000001', checkout: { paymentMethods: ['BTC'], expirationMinutes: 45 } });
    await expect(provider.createIntent({ intentId: 'x', order, method: 'card', amountSats: 1, expiresAt: null, now })).rejects.toThrow(/cards/);
  });

  it('polls status and parses signed webhooks; refuses bad signatures and other stores', async () => {
    const intent = { providerRef: 'inv1', method: 'lightning', amountSats: 34_200 } as never;
    expect(await provider.poll(intent, now)).toBeUndefined();
    server.settle('inv1');
    expect(await provider.poll(intent, now)).toMatchObject({ status: 'paid', amountPaidSats: 34_200 });

    const ok = server.webhook('InvoiceSettled', 'inv1');
    const parsed = await provider.parseWebhook(ok.body, new Headers(ok.headers), now);
    expect(parsed).toMatchObject({ providerRef: 'inv1', eventType: 'InvoiceSettled', update: { status: 'paid' } });
    const redelivery = server.webhook('InvoiceSettled', 'inv1', { isRedelivery: true, originalDeliveryId: 'orig-1' });
    expect((await provider.parseWebhook(redelivery.body, new Headers(redelivery.headers), now)).deliveryId).toBe('orig-1');

    const bad = server.webhook('InvoiceSettled', 'inv1', {}, 'wrong-secret');
    await expect(provider.parseWebhook(bad.body, new Headers(bad.headers), now)).rejects.toThrow(WebhookError);
    await expect(provider.parseWebhook(ok.body, new Headers(), now)).rejects.toMatchObject({ code: 'invalid_signature' });
    const foreign = server.webhook('InvoiceSettled', 'inv1', { storeId: 'other-store' });
    await expect(provider.parseWebhook(foreign.body, new Headers(foreign.headers), now)).rejects.toMatchObject({ code: 'malformed_payload' });
    const junk = '{not json';
    await expect(provider.parseWebhook(junk, new Headers({ 'BTCPay-Sig': `sha256=${hmacHex(server.webhookSecret, junk)}` }), now)).rejects.toMatchObject({ code: 'malformed_payload' });
  });

  it('refunds create a pull payment', async () => {
    const r = await provider.refund({ providerRef: 'inv1', method: 'lightning' } as never, { id: 'ref_1', amountSats: 1_000, reason: 'oops' } as never);
    expect(r).toMatchObject({ status: 'pending', providerRef: 'pp_inv1' });
    expect(server.requests.at(-1)!.body).toMatchObject({ refundVariant: 'Custom', customAmount: '0.00001000', customCurrency: 'BTC', paymentMethod: 'BTC-LightningNetwork' });
  });
});

describe('webhook replay through the service', () => {
  it('the same delivery is applied once; the third delivery of a settled invoice is a no-op', async () => {
    const clock = fakeClock();
    const server = new FakeBtcpayServer();
    const provider = new BtcpayProvider({ baseUrl: server.baseUrl, storeId: server.storeId, apiKey: server.apiKey, webhookSecret: server.webhookSecret, fetch: server.fetch });
    const store = new MemoryOrderStore();
    const service = new LedgerService({ store, providers: [provider], now: clock.now, newId: seqIds() });
    const ctx = { product: 'scribbit' as const };
    const { order } = await service.createOrder({ product: 'scribbit', customerRef: 'c', lineItems: [{ sku: 's', description: 'd', quantity: 1, unitSats: 5_000 }] }, ctx);
    const { payment } = await service.createPayment(order.id, { method: 'lightning' }, ctx);
    server.settle(payment.providerRef);
    const hook = server.webhook('InvoiceSettled', payment.providerRef);
    expect(await service.handleWebhook('btcpay', hook.body, new Headers(hook.headers))).toMatchObject({ applied: true, duplicate: false });
    expect(await service.handleWebhook('btcpay', hook.body, new Headers(hook.headers))).toMatchObject({ applied: false, duplicate: true, reason: 'replay' });
    const again = server.webhook('InvoiceSettled', payment.providerRef); // new delivery id, same state
    expect(await service.handleWebhook('btcpay', again.body, new Headers(again.headers))).toMatchObject({ applied: false, duplicate: false, reason: 'no change' });
    // a late "expired" webhook cannot undo a paid intent
    server.setStatus(payment.providerRef, 'Expired');
    const late = server.webhook('InvoiceExpired', payment.providerRef);
    expect(await service.handleWebhook('btcpay', late.body, new Headers(late.headers))).toMatchObject({ applied: false, reason: expect.stringMatching(/illegal transition paid -> expired/) });
    expect((await service.getPayment(payment.id, ctx)).status).toBe('paid');
    // unknown invoice is acknowledged, not applied
    const unknown = server.webhook('InvoiceSettled', 'inv-nope');
    expect(await service.handleWebhook('btcpay', unknown.body, new Headers(unknown.headers))).toMatchObject({ applied: false, reason: 'unknown_reference' });
  });
});
