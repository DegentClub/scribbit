import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { timingSafeEqual } from '@bsh/edge';
import type { PaymentIntent, PaymentStatus, Refund } from '../domain/types.js';
import { satsToFiatMinor } from '../money.js';
import { WebhookError, type CardProvider, type CreateIntentInput, type Fetch, type ProviderIntent, type ProviderRefundResult, type ProviderUpdate, type ProviderWebhook } from './provider.js';

/** Fiat quote port: integer minor units (cents) per BTC. The ledger never does float FX. */
export interface RateSource {
  minorPerBtc(currency: string): Promise<number>;
}

export const fixedRate = (minorPerBtc: number): RateSource => ({ minorPerBtc: async () => minorPerBtc });

// ------------------------------------------------------------------------------------------ signature

export interface CardSignatureResult {
  ok: boolean;
  reason?: 'malformed_header' | 'no_v1_signature' | 'signature_mismatch' | 'timestamp_too_old' | 'timestamp_in_future';
}

/**
 * `<Header>: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` (the scheme Stripe and many
 * card processors use). The timestamp is inside the MAC, so replays outside `toleranceSeconds` are rejected;
 * inside the window the event id is de-duplicated by the service.
 */
export function verifyCardSignature(rawBody: string, header: string | null | undefined, secrets: string | readonly string[], nowSeconds: number, toleranceSeconds = 300): CardSignatureResult {
  if (!header) return { ok: false, reason: 'malformed_header' };
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t === undefined) return { ok: false, reason: 'malformed_header' };
  if (v1.length === 0) return { ok: false, reason: 'no_v1_signature' };
  const payload = new TextEncoder().encode(`${t}.${rawBody}`);
  const list = Array.isArray(secrets) ? secrets : [secrets as string];
  const matched = list.some((s) => {
    const expected = bytesToHex(hmac(sha256, new TextEncoder().encode(s), payload));
    return v1.some((sig) => timingSafeEqual(expected, sig));
  });
  if (!matched) return { ok: false, reason: 'signature_mismatch' };
  if (nowSeconds - t > toleranceSeconds) return { ok: false, reason: 'timestamp_too_old' };
  if (t - nowSeconds > toleranceSeconds) return { ok: false, reason: 'timestamp_in_future' };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------ provider

/** Provider-side intent states (Stripe-like vocabulary) → ledger states. */
export function mapCardIntentStatus(status: string): PaymentStatus | undefined {
  switch (status) {
    case 'succeeded':
      return 'paid';
    case 'processing':
      return 'pending';
    case 'canceled':
      return 'expired';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'requires_capture':
      return undefined;
    default:
      return undefined;
  }
}

export interface StripeLikeProviderOptions {
  baseUrl: string;
  secretKey: string;
  webhookSecret: string | readonly string[];
  rates: RateSource;
  /** ISO 4217 lower-case, e.g. `usd`. */
  fiatCurrency: string;
  fetch?: Fetch;
  signatureHeader?: string;
  toleranceSeconds?: number;
  /** Default 30 minutes: the fiat quote is only good for so long. */
  expiryMinutes?: number;
}

interface ProviderIntentObject {
  id: string;
  client_secret?: string;
  status: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  metadata?: Record<string, string>;
  latest_charge?: string;
}

/**
 * Card processor adapter over a Stripe-shaped REST API (`/v1/payment_intents`, `/v1/refunds`, signed webhooks).
 * Card data never reaches the ledger: the browser exchanges the `clientSecret` with the processor directly.
 * Sats are quoted to fiat at intent creation; the fiat amount is fixed for the intent's lifetime.
 */
export class StripeLikeProvider implements CardProvider {
  readonly name = 'card';
  readonly methods = ['card'] as const;
  private readonly fetchFn: Fetch;
  private readonly base: string;

  constructor(private readonly opts: StripeLikeProviderOptions) {
    if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error('card baseUrl must be http(s)');
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  private async api<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.secretKey}`, accept: 'application/json' };
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.fetchFn(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    if (!res.ok) throw new Error(`card provider ${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
    const rate = await this.opts.rates.minorPerBtc(this.opts.fiatCurrency);
    const fiatMinor = satsToFiatMinor(input.amountSats, rate);
    if (fiatMinor <= 0) throw new Error('amount rounds to zero in fiat');
    const pi = await this.api<ProviderIntentObject>(
      'POST',
      '/v1/payment_intents',
      {
        amount: String(fiatMinor),
        currency: this.opts.fiatCurrency,
        'metadata[orderId]': input.order.id,
        'metadata[paymentId]': input.intentId,
        'metadata[product]': input.order.product,
        'metadata[amountSats]': String(input.amountSats),
        'automatic_payment_methods[enabled]': 'true',
      },
      input.intentId,
    );
    const checkout: ProviderIntent['checkout'] = {};
    if (pi.client_secret) checkout.clientSecret = pi.client_secret;
    const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + (this.opts.expiryMinutes ?? 30) * 60_000).toISOString();
    return { providerRef: pi.id, checkout, expiresAt, providerData: { fiatCurrency: this.opts.fiatCurrency, fiatMinor, minorPerBtc: rate } };
  }

  async confirm(intent: PaymentIntent, paymentMethodToken: string): Promise<ProviderUpdate> {
    const pi = await this.api<ProviderIntentObject>('POST', `/v1/payment_intents/${encodeURIComponent(intent.providerRef)}/confirm`, { payment_method: paymentMethodToken }, `${intent.id}:confirm`);
    return this.toUpdate(intent, pi, new Date());
  }

  private toUpdate(intent: PaymentIntent, pi: ProviderIntentObject, now: Date): ProviderUpdate {
    const status = mapCardIntentStatus(pi.status) ?? 'created';
    const u: ProviderUpdate = { status };
    if (status === 'paid') {
      u.amountPaidSats = intent.amountSats; // fiat settled at the quoted rate = the quoted sats
      u.paidAt = now.toISOString();
    }
    return u;
  }

  async poll(intent: PaymentIntent, now: Date): Promise<ProviderUpdate | undefined> {
    const pi = await this.api<ProviderIntentObject>('GET', `/v1/payment_intents/${encodeURIComponent(intent.providerRef)}`);
    const status = mapCardIntentStatus(pi.status);
    if (!status) return intent.expiresAt && now.getTime() >= Date.parse(intent.expiresAt) ? { status: 'expired' } : undefined;
    return this.toUpdate(intent, pi, now);
  }

  async refund(intent: PaymentIntent, refund: Refund): Promise<ProviderRefundResult> {
    const rate = Number(intent.providerData.minorPerBtc);
    const fiatMinor = satsToFiatMinor(refund.amountSats, rate);
    const r = await this.api<{ id: string; status: string }>('POST', '/v1/refunds', { payment_intent: intent.providerRef, amount: String(fiatMinor), 'metadata[refundId]': refund.id }, refund.id);
    return { status: r.status === 'succeeded' ? 'completed' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending', providerRef: r.id };
  }

  async parseWebhook(rawBody: string, headers: Headers, now: Date): Promise<ProviderWebhook> {
    const v = verifyCardSignature(rawBody, headers.get(this.opts.signatureHeader ?? 'Stripe-Signature'), this.opts.webhookSecret, Math.floor(now.getTime() / 1000), this.opts.toleranceSeconds);
    if (!v.ok) throw new WebhookError('invalid_signature', v.reason ?? 'signature invalid');
    let ev: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      ev = JSON.parse(rawBody);
    } catch {
      throw new WebhookError('malformed_payload', 'body is not JSON');
    }
    const obj = ev.data?.object;
    if (typeof ev.id !== 'string' || typeof ev.type !== 'string' || !obj || typeof obj !== 'object') throw new WebhookError('malformed_payload', 'missing id/type/data.object');
    const type = ev.type;
    if (type.startsWith('payment_intent.')) {
      const out: ProviderWebhook = { deliveryId: ev.id, providerRef: String(obj.id), eventType: type };
      const status: PaymentStatus | undefined =
        type === 'payment_intent.succeeded' ? 'paid' : type === 'payment_intent.payment_failed' ? 'failed' : type === 'payment_intent.canceled' ? 'expired' : type === 'payment_intent.processing' ? 'pending' : undefined;
      if (status) {
        out.update = { status };
        if (status === 'paid') out.update.paidAt = now.toISOString();
        if (status === 'failed') out.update.detail = String((obj.last_payment_error as { message?: string } | undefined)?.message ?? 'declined');
      }
      return out;
    }
    if (type.startsWith('refund.') || type === 'charge.refunded') {
      const refundObj = type === 'charge.refunded' ? undefined : obj;
      const providerRef = String(obj.payment_intent ?? '');
      const out: ProviderWebhook = { deliveryId: ev.id, providerRef, eventType: type };
      if (refundObj && typeof refundObj.id === 'string') {
        const st = refundObj.status === 'succeeded' ? 'completed' : refundObj.status === 'failed' || refundObj.status === 'canceled' ? 'failed' : undefined;
        if (st) out.refund = { providerRef: refundObj.id, status: st };
      }
      return out;
    }
    return { deliveryId: ev.id, providerRef: String(obj.payment_intent ?? obj.id ?? ''), eventType: type };
  }
}
