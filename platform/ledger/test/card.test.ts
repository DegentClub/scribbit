import { describe, expect, it } from 'vitest';
import { StripeLikeProvider, fixedRate, mapCardIntentStatus, satsToFiatMinor, verifyCardSignature, type Fetch } from '../src/index.js';
import { T0, cardWebhook, hmacHex, json } from './helpers.js';

const nowS = Math.floor(T0 / 1000);

describe('verifyCardSignature (t=…,v1=… scheme)', () => {
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const header = (t: number, secret = 'whsec') => `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;

  it('accepts a fresh, correctly signed body and any matching v1 during rotation', () => {
    expect(verifyCardSignature(body, header(nowS), 'whsec', nowS)).toEqual({ ok: true });
    expect(verifyCardSignature(body, header(nowS - 299), 'whsec', nowS)).toEqual({ ok: true });
    expect(verifyCardSignature(body, `${header(nowS, 'old')},v1=${'0'.repeat(64)}`, ['whsec', 'old'], nowS).ok).toBe(true);
  });

  it('rejects malformed headers, wrong secrets, tampered bodies and stale timestamps', () => {
    expect(verifyCardSignature(body, null, 'whsec', nowS)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(verifyCardSignature(body, 'v1=abc', 'whsec', nowS)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(verifyCardSignature(body, `t=${nowS}`, 'whsec', nowS)).toEqual({ ok: false, reason: 'no_v1_signature' });
    expect(verifyCardSignature(body, `t=${nowS},v1=zz`, 'whsec', nowS)).toEqual({ ok: false, reason: 'no_v1_signature' });
    expect(verifyCardSignature(body, header(nowS, 'other'), 'whsec', nowS)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(verifyCardSignature(body + 'x', header(nowS), 'whsec', nowS)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(verifyCardSignature(body, header(nowS - 301), 'whsec', nowS)).toEqual({ ok: false, reason: 'timestamp_too_old' });
    expect(verifyCardSignature(body, header(nowS + 301), 'whsec', nowS)).toEqual({ ok: false, reason: 'timestamp_in_future' });
    // a signature over a different timestamp does not verify (t is inside the MAC)
    expect(verifyCardSignature(body, `t=${nowS},v1=${hmacHex('whsec', `${nowS - 1}.${body}`)}`, 'whsec', nowS).ok).toBe(false);
  });
});

describe('fiat conversion', () => {
  it('rounds half up in integer arithmetic', () => {
    expect(satsToFiatMinor(100_000_000, 6_500_000)).toBe(6_500_000); // 1 BTC
    expect(satsToFiatMinor(34_200, 6_500_000)).toBe(2223); // 0.000342 BTC * $65,000 = $22.23
    expect(satsToFiatMinor(1, 6_500_000)).toBe(0);
    expect(satsToFiatMinor(8, 6_500_000)).toBe(1); // 0.52 cents → 1
    expect(() => satsToFiatMinor(1, 1.5)).toThrow(/integer/);
  });

  it.each([
    ['succeeded', 'paid'],
    ['processing', 'pending'],
    ['canceled', 'expired'],
    ['requires_payment_method', undefined],
    ['requires_action', undefined],
    ['weird', undefined],
  ] as const)('%s -> %s', (s, e) => expect(mapCardIntentStatus(s)).toBe(e));
});

describe('StripeLikeProvider against a fake processor', () => {
  const intents = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; url: string; form: URLSearchParams; headers: Headers }> = [];
  const fetchFn: Fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    calls.push({ method: init.method ?? 'GET', url, form, headers });
    if (headers.get('authorization') !== 'Bearer sk_test_x') return json({ error: 'unauthorized' }, 401);
    if (url.endsWith('/v1/payment_intents') && init.method === 'POST') {
      const id = `pi_${intents.size + 1}`;
      const pi = { id, client_secret: `${id}_secret`, status: 'requires_payment_method', amount: Number(form.get('amount')), currency: form.get('currency') };
      intents.set(id, pi);
      return json(pi);
    }
    const m = /\/v1\/payment_intents\/([^/]+)(\/confirm)?$/.exec(url);
    if (m && intents.has(m[1]!)) {
      const pi = intents.get(m[1]!)!;
      if (m[2]) pi.status = form.get('payment_method') === 'pm_declined' ? 'requires_payment_method' : 'succeeded';
      return json(pi);
    }
    if (url.endsWith('/v1/refunds')) return json({ id: 're_1', status: form.get('amount') === '1' ? 'pending' : 'succeeded' });
    return json({}, 404);
  };
  const provider = new StripeLikeProvider({ baseUrl: 'https://cards.test/', secretKey: 'sk_test_x', webhookSecret: 'whsec', rates: fixedRate(6_500_000), fiatCurrency: 'usd', fetch: fetchFn });
  const order = { id: 'ord_1', product: 'blockspace' } as never;
  const now = new Date(T0);

  it('creates an intent priced in fiat, with an idempotency key and no card data', async () => {
    const created = await provider.createIntent({ intentId: 'pay_1', order, method: 'card', amountSats: 34_200, expiresAt: null, now });
    expect(created).toMatchObject({ providerRef: 'pi_1', checkout: { clientSecret: 'pi_1_secret' }, providerData: { fiatCurrency: 'usd', fiatMinor: 2223, minorPerBtc: 6_500_000 } });
    expect(created.expiresAt).toBe(new Date(T0 + 30 * 60_000).toISOString());
    const c = calls[0]!;
    expect(c.headers.get('Idempotency-Key')).toBe('pay_1');
    expect(c.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(c.form)).toMatchObject({ amount: '2223', currency: 'usd', 'metadata[orderId]': 'ord_1', 'metadata[paymentId]': 'pay_1', 'metadata[amountSats]': '34200' });
    await expect(provider.createIntent({ intentId: 'pay_0', order, method: 'card', amountSats: 1, expiresAt: null, now })).rejects.toThrow(/rounds to zero/);
  });

  it('polls, confirms server-side and refunds in fiat at the quoted rate', async () => {
    const intent = { id: 'pay_1', providerRef: 'pi_1', amountSats: 34_200, expiresAt: new Date(T0 + 30 * 60_000).toISOString(), providerData: { minorPerBtc: 6_500_000 } } as never;
    expect(await provider.poll(intent, now)).toBeUndefined();
    expect(await provider.poll(intent, new Date(T0 + 31 * 60_000))).toEqual({ status: 'expired' });
    expect((await provider.confirm(intent, 'pm_declined')).status).toBe('created');
    expect(await provider.confirm(intent, 'pm_card_visa')).toMatchObject({ status: 'paid', amountPaidSats: 34_200 });
    expect(await provider.poll(intent, now)).toMatchObject({ status: 'paid', amountPaidSats: 34_200, paidAt: now.toISOString() });
    const r = await provider.refund(intent, { id: 'ref_1', amountSats: 10_000, reason: 'x' } as never);
    expect(r).toEqual({ status: 'completed', providerRef: 're_1' });
    const refundCall = calls.at(-1)!;
    expect(refundCall.form.get('amount')).toBe('650'); // 10_000 sats at $65k = $6.50
    expect(refundCall.form.get('payment_intent')).toBe('pi_1');
    expect(refundCall.headers.get('Idempotency-Key')).toBe('ref_1');
  });

  it('parses signed webhooks for intents and refunds', async () => {
    const succeeded = cardWebhook('whsec', { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', object: 'payment_intent', status: 'succeeded' } } });
    expect(await provider.parseWebhook(succeeded.body, new Headers(succeeded.headers), now)).toMatchObject({ deliveryId: 'evt_1', providerRef: 'pi_1', update: { status: 'paid', paidAt: now.toISOString() } });
    const failed = cardWebhook('whsec', { id: 'evt_2', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_1', last_payment_error: { message: 'card_declined' } } } });
    expect(await provider.parseWebhook(failed.body, new Headers(failed.headers), now)).toMatchObject({ update: { status: 'failed', detail: 'card_declined' } });
    const refund = cardWebhook('whsec', { id: 'evt_3', type: 'refund.updated', data: { object: { id: 're_1', object: 'refund', status: 'succeeded', payment_intent: 'pi_1' } } });
    expect(await provider.parseWebhook(refund.body, new Headers(refund.headers), now)).toMatchObject({ providerRef: 'pi_1', refund: { providerRef: 're_1', status: 'completed' } });
    const info = cardWebhook('whsec', { id: 'evt_4', type: 'charge.succeeded', data: { object: { id: 'ch_1', payment_intent: 'pi_1' } } });
    const parsed = await provider.parseWebhook(info.body, new Headers(info.headers), now);
    expect(parsed.update).toBeUndefined();
    expect(parsed.providerRef).toBe('pi_1');

    const stale = cardWebhook('whsec', { id: 'evt_5', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } }, nowS - 1000);
    await expect(provider.parseWebhook(stale.body, new Headers(stale.headers), now)).rejects.toMatchObject({ code: 'invalid_signature', message: 'timestamp_too_old' });
    const forged = cardWebhook('other', { id: 'evt_6', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });
    await expect(provider.parseWebhook(forged.body, new Headers(forged.headers), now)).rejects.toMatchObject({ code: 'invalid_signature' });
    const malformed = cardWebhook('whsec', { id: 'evt_7', type: 'payment_intent.succeeded' });
    await expect(provider.parseWebhook(malformed.body, new Headers(malformed.headers), now)).rejects.toMatchObject({ code: 'malformed_payload' });
  });
});
