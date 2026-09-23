import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { timingSafeEqual } from '@bsh/edge';
import type { PaymentIntent, PaymentMethod, PaymentStatus, Refund } from '../domain/types.js';
import { btcToSats, satsToBtc } from '../money.js';
import { WebhookError, type CreateIntentInput, type Fetch, type PaymentProvider, type ProviderIntent, type ProviderRefundResult, type ProviderUpdate, type ProviderWebhook } from './provider.js';

/** BTCPay Greenfield invoice states and the `additionalStatus` refinements we act on. */
export type BtcpayInvoiceStatus = 'New' | 'Processing' | 'Settled' | 'Expired' | 'Invalid';
export type BtcpayAdditionalStatus = 'None' | 'PaidLate' | 'PaidPartial' | 'Marked' | 'Invalid' | 'PaidOver';

export interface BtcpayInvoice {
  id: string;
  status: BtcpayInvoiceStatus;
  additionalStatus?: BtcpayAdditionalStatus;
  amount: string;
  currency: string;
  checkoutLink?: string;
  /** Unix seconds. */
  expirationTime?: number;
  metadata?: Record<string, unknown>;
}

export interface BtcpayPaymentMethod {
  paymentMethodId?: string;
  /** Older servers. */
  paymentMethod?: string;
  destination?: string;
  paymentLink?: string;
  totalPaid?: string;
  due?: string;
  payments?: Array<{ id: string; receivedDate?: number; value: string; status: 'Processing' | 'Settled' | 'Invalid'; destination?: string }>;
}

/** Map an invoice (+ optional payment method detail) onto the ledger's payment states. */
export function mapBtcpayInvoice(inv: BtcpayInvoice, methods: readonly BtcpayPaymentMethod[] = [], now: Date): ProviderUpdate | undefined {
  const paidSats = methods.reduce((s, m) => s + (m.totalPaid ? btcToSats(m.totalPaid) : 0), 0);
  const settledPayment = methods.flatMap((m) => m.payments ?? []).find((p) => p.status === 'Settled');
  const txid = settledPayment && /^[0-9a-f]{64}/.test(settledPayment.id) ? settledPayment.id.slice(0, 64) : undefined;
  const base: ProviderUpdate = { status: 'pending', amountPaidSats: paidSats };
  if (txid) base.txid = txid;
  switch (inv.status) {
    case 'New':
      return undefined;
    case 'Processing':
      return { ...base, status: 'pending', detail: 'awaiting settlement' };
    case 'Settled':
      return { ...base, status: inv.additionalStatus === 'PaidOver' ? 'overpaid' : 'paid', paidAt: now.toISOString() };
    case 'Expired':
      if (inv.additionalStatus === 'PaidPartial') return { ...base, status: 'underpaid' };
      if (inv.additionalStatus === 'PaidLate') return { ...base, status: 'pending', detail: 'paid after expiry; awaiting settlement' };
      return { ...base, status: 'expired' };
    case 'Invalid':
      return { ...base, status: 'failed', detail: inv.additionalStatus === 'Marked' ? 'marked invalid by operator' : 'invalid' };
    default:
      return undefined;
  }
}

/** Webhook event type → payment status (undefined = informational, re-poll for detail). */
export function mapBtcpayWebhookType(type: string, body: Record<string, unknown>): PaymentStatus | undefined {
  switch (type) {
    case 'InvoiceReceivedPayment':
    case 'InvoiceProcessing':
    case 'InvoicePaymentSettled':
      return 'pending';
    case 'InvoiceSettled':
      return body.overPaid === true ? 'overpaid' : 'paid';
    case 'InvoiceExpired':
      return body.partiallyPaid === true ? 'underpaid' : 'expired';
    case 'InvoiceInvalid':
      return 'failed';
    default:
      return undefined;
  }
}

const SIG_RE = /^sha256=([0-9a-f]{64})$/i;

/** `BTCPay-Sig: sha256=<hex HMAC-SHA256(secret, raw body)>`. Constant-time; several secrets allowed for rotation. */
export function verifyBtcpaySignature(rawBody: string, header: string | null | undefined, secrets: string | readonly string[]): boolean {
  const m = header ? SIG_RE.exec(header.trim()) : null;
  if (!m) return false;
  const presented = m[1]!.toLowerCase();
  const body = new TextEncoder().encode(rawBody);
  for (const s of Array.isArray(secrets) ? secrets : [secrets as string]) {
    const expected = bytesToHex(hmac(sha256, new TextEncoder().encode(s), body));
    if (timingSafeEqual(expected, presented)) return true;
  }
  return false;
}

export interface BtcpayProviderOptions {
  baseUrl: string;
  storeId: string;
  apiKey: string;
  webhookSecret: string | readonly string[];
  fetch?: Fetch;
  /** BTCPay payment-method ids per ledger method. Defaults are the Greenfield names. */
  paymentMethodIds?: Partial<Record<Extract<PaymentMethod, 'lightning' | 'onchain'>, string>>;
  /** Default 15 (BTCPay's default invoice expiry). */
  expiryMinutes?: number;
  methods?: readonly Extract<PaymentMethod, 'lightning' | 'onchain'>[];
}

/**
 * BTCPay Server (Greenfield API) provider: Lightning and/or on-chain BTC invoices. BTCPay holds the
 * wallet; the ledger holds an API key scoped to the store (`btcpay.store.cancreateinvoice`,
 * `btcpay.store.canviewinvoices`, `btcpay.store.cancreatenonapprovedpullpayments` for refunds).
 */
export class BtcpayProvider implements PaymentProvider {
  readonly name = 'btcpay';
  readonly methods: readonly PaymentMethod[];
  private readonly fetchFn: Fetch;
  private readonly base: string;

  constructor(private readonly opts: BtcpayProviderOptions) {
    if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error('btcpay baseUrl must be http(s)');
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.methods = opts.methods ?? ['lightning', 'onchain'];
  }

  private methodId(m: PaymentMethod): string {
    return m === 'lightning' ? (this.opts.paymentMethodIds?.lightning ?? 'BTC-LightningNetwork') : (this.opts.paymentMethodIds?.onchain ?? 'BTC');
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}/api/v1/stores/${encodeURIComponent(this.opts.storeId)}${path}`, {
      method,
      headers: { Authorization: `token ${this.opts.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`btcpay ${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
    if (input.method === 'card') throw new Error('btcpay does not take cards');
    const expiryMinutes = input.expiresAt ? Math.max(1, Math.round((Date.parse(input.expiresAt) - input.now.getTime()) / 60_000)) : (this.opts.expiryMinutes ?? 15);
    const inv = await this.api<BtcpayInvoice>('POST', '/invoices', {
      amount: satsToBtc(input.amountSats),
      currency: 'BTC',
      metadata: { orderId: input.order.id, paymentId: input.intentId, product: input.order.product },
      checkout: { paymentMethods: [this.methodId(input.method)], expirationMinutes: expiryMinutes },
    });
    const methods = await this.api<BtcpayPaymentMethod[]>('GET', `/invoices/${encodeURIComponent(inv.id)}/payment-methods`).catch(() => [] as BtcpayPaymentMethod[]);
    const pm = methods.find((m) => matchesMethod(m, input.method)) ?? methods[0];
    const checkout: ProviderIntent['checkout'] = {};
    if (inv.checkoutLink) checkout.checkoutUrl = inv.checkoutLink;
    if (pm?.destination) {
      if (input.method === 'lightning') checkout.bolt11 = pm.destination;
      else checkout.address = pm.destination;
    }
    const expiresAt = inv.expirationTime ? new Date(inv.expirationTime * 1000).toISOString() : new Date(input.now.getTime() + expiryMinutes * 60_000).toISOString();
    return { providerRef: inv.id, checkout, expiresAt, providerData: { storeId: this.opts.storeId, paymentMethodId: this.methodId(input.method) } };
  }

  async poll(intent: PaymentIntent, now: Date): Promise<ProviderUpdate | undefined> {
    const inv = await this.api<BtcpayInvoice>('GET', `/invoices/${encodeURIComponent(intent.providerRef)}`);
    const methods = inv.status === 'New' ? [] : await this.api<BtcpayPaymentMethod[]>('GET', `/invoices/${encodeURIComponent(inv.id)}/payment-methods`).catch(() => []);
    return mapBtcpayInvoice(inv, methods, now);
  }

  async refund(intent: PaymentIntent, refund: Refund): Promise<ProviderRefundResult> {
    const pp = await this.api<{ id: string; viewLink?: string }>('POST', `/invoices/${encodeURIComponent(intent.providerRef)}/refund`, {
      name: `Refund ${refund.id}`,
      description: refund.reason,
      paymentMethod: this.methodId(intent.method),
      refundVariant: 'Custom',
      customAmount: satsToBtc(refund.amountSats),
      customCurrency: 'BTC',
    });
    // A pull payment is claimable by the customer; it completes when they claim it (webhook PullPaymentPayout*/manual check).
    return { status: 'pending', providerRef: pp.id, detail: pp.viewLink ? `claim at ${pp.viewLink}` : 'pull payment created' };
  }

  async parseWebhook(rawBody: string, headers: Headers, _now?: Date): Promise<ProviderWebhook> {
    if (!verifyBtcpaySignature(rawBody, headers.get('BTCPay-Sig'), this.opts.webhookSecret)) throw new WebhookError('invalid_signature', 'BTCPay-Sig mismatch');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new WebhookError('malformed_payload', 'body is not JSON');
    }
    const invoiceId = body.invoiceId;
    const deliveryId = body.deliveryId;
    const type = body.type;
    if (typeof invoiceId !== 'string' || typeof deliveryId !== 'string' || typeof type !== 'string') throw new WebhookError('malformed_payload', 'missing invoiceId/deliveryId/type');
    if (body.storeId !== undefined && body.storeId !== this.opts.storeId) throw new WebhookError('malformed_payload', 'webhook for another store');
    // Redeliveries carry a fresh deliveryId but the same originalDeliveryId: de-duplicate on the original.
    const dedupeId = typeof body.originalDeliveryId === 'string' && body.originalDeliveryId ? body.originalDeliveryId : deliveryId;
    const status = mapBtcpayWebhookType(type, body);
    const out: ProviderWebhook = { deliveryId: dedupeId, providerRef: invoiceId, eventType: type };
    if (status) out.update = { status };
    return out;
  }
}

function matchesMethod(m: BtcpayPaymentMethod, method: PaymentMethod): boolean {
  const id = (m.paymentMethodId ?? m.paymentMethod ?? '').toUpperCase();
  const isLn = id.includes('LIGHTNING') || id.endsWith('-LN') || id.includes('LNURL');
  return method === 'lightning' ? isLn : !isLn;
}
