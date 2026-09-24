/**
 * A small typed client for the platform ledger's HTTP API (contracts/openapi/ledger.yaml). Only what the order
 * tools need: create an order and a `psbt` payment intent, read them back, report a funding transaction, fetch the
 * receipt. `fetch` is injectable so tests run against an in-memory fake that mirrors the contract shapes. The API
 * key is sent and never returned, logged or included in an error.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LedgerPayeeKind = 'artist' | 'club' | 'platform' | 'other';
export type LedgerOrderStatus = 'created' | 'awaiting_payment' | 'paid' | 'expired' | 'cancelled' | 'refunded';
export type LedgerPaymentStatus = 'created' | 'pending' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'failed' | 'refunded';

export interface LedgerPayee {
  kind: LedgerPayeeKind;
  ref: string;
  address?: string;
  scriptHex?: string;
}

export interface LedgerLineItem {
  sku: string;
  description: string;
  quantity: number;
  unitSats: number;
  payee?: LedgerPayee;
}

export interface LedgerOrder {
  id: string;
  product: string;
  customerRef: string;
  lineItems: LedgerLineItem[];
  currency: 'sat';
  totalSats: number;
  status: LedgerOrderStatus;
  metadata: Record<string, string>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerExpectedOutput {
  scriptHex: string;
  valueSats: number;
  address?: string;
  payee: LedgerPayee;
}

export interface LedgerPayment {
  id: string;
  orderId: string;
  product: string;
  method: string;
  provider: string;
  providerRef: string;
  amountSats: number;
  amountPaidSats: number;
  refundedSats: number;
  status: LedgerPaymentStatus;
  checkout: { address?: string; bolt11?: string; checkoutUrl?: string; clientSecret?: string; outputs?: LedgerExpectedOutput[] };
  expiresAt: string | null;
  paidAt: string | null;
  txid?: string;
  providerData: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerPayout {
  id: string;
  orderId: string;
  paymentId: string;
  product: string;
  payee: LedgerPayee;
  amountSats: number;
  txid: string;
  vout: number;
  status: 'settled' | 'pending' | 'failed';
  settledAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerReceipt {
  receiptId: string;
  issuedAt: string;
  order: Pick<LedgerOrder, 'id' | 'product' | 'customerRef' | 'status' | 'currency' | 'totalSats' | 'lineItems' | 'createdAt' | 'metadata'>;
  payments: Array<{ id: string; method: string; provider: string; status: LedgerPaymentStatus; amountSats: number; amountPaidSats: number; refundedSats: number; paidAt: string | null; txid?: string; reference: string }>;
  refunds: Array<{ id: string; paymentId: string; amountSats: number; status: string; reason: string; createdAt: string }>;
  payouts?: Array<{ id: string; paymentId: string; payee: LedgerPayee; amountSats: number; txid: string; vout: number; status: string }>;
  totals: { totalSats: number; paidSats: number; refundedSats: number; dueSats: number };
}

export interface LedgerCreateOrder {
  product?: string;
  customerRef: string;
  lineItems: LedgerLineItem[];
  metadata?: Record<string, string>;
}

export interface LedgerObservation {
  txid: string;
  outputs: Array<{ scriptHex: string; valueSats: number }>;
  confirmations?: number;
  rbfSignalled?: boolean;
}

export interface LedgerObservationResult {
  payment: LedgerPayment;
  order: LedgerOrder;
  applied: boolean;
  reason?: string;
  payouts: LedgerPayout[];
}

/** A non-2xx answer (with the ledger's stable `code`) or an unreachable ledger (`status: 0`, code `unreachable`). */
export class LedgerClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string | null,
  ) {
    super(message);
    this.name = 'LedgerClientError';
  }
}

export interface LedgerClient {
  readonly baseUrl: string;
  createOrder(body: LedgerCreateOrder, idempotencyKey?: string): Promise<LedgerOrder>;
  createPayment(orderId: string, body: { method: 'psbt'; expiresAt?: string }, idempotencyKey?: string): Promise<LedgerPayment>;
  getOrder(id: string): Promise<LedgerOrder>;
  getPayment(id: string): Promise<LedgerPayment>;
  listPayments(orderId: string): Promise<LedgerPayment[]>;
  listPayouts(orderId: string): Promise<LedgerPayout[]>;
  getReceipt(orderId: string): Promise<LedgerReceipt>;
  getReceiptText(orderId: string): Promise<string>;
  observe(paymentId: string, body: LedgerObservation): Promise<LedgerObservationResult>;
}

export interface LedgerClientOptions {
  /** e.g. `http://ledger.internal:3050` (no trailing slash needed). */
  baseUrl: string;
  /** A ledger API key (scope `ledger`, owner `scribbit`). Sent as `Authorization: Bearer`, never surfaced. */
  apiKey: string;
  fetch?: FetchLike;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
}

export function createLedgerClient(opts: LedgerClientOptions): LedgerClient {
  let parsed: URL;
  try {
    parsed = new URL(opts.baseUrl);
  } catch {
    throw new Error(`invalid ledger URL "${opts.baseUrl}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`ledger URL must be http(s): "${opts.baseUrl}"`);
  if (!opts.apiKey) throw new Error('ledger API key is required');
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const f: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(method: 'GET' | 'POST', path: string, init: { body?: unknown; idempotencyKey?: string; accept?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}`, accept: init.accept ?? 'application/json' };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await f(`${baseUrl}${path}`, { method, headers, signal: ctrl.signal, ...(body !== undefined ? { body } : {}) });
    } catch (e) {
      throw new LedgerClientError(0, 'unreachable', `ledger unreachable: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = text.slice(0, 200) || res.statusText;
      let requestId: string | null = null;
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string; requestId?: string | null } };
        if (j.error?.code) code = j.error.code;
        if (j.error?.message) message = j.error.message;
        if (j.error?.requestId !== undefined) requestId = j.error.requestId;
      } catch {
        /* not JSON: keep the excerpt */
      }
      throw new LedgerClientError(res.status, code, message, requestId);
    }
    if (init.accept === 'text/plain') return text as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LedgerClientError(res.status, 'malformed_response', 'ledger returned a body that is not JSON');
    }
  }

  const enc = encodeURIComponent;
  return {
    baseUrl,
    createOrder: (body, idempotencyKey) => call('POST', '/v1/orders', { body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    createPayment: (orderId, body, idempotencyKey) => call('POST', `/v1/orders/${enc(orderId)}/payments`, { body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    getOrder: (id) => call('GET', `/v1/orders/${enc(id)}`),
    getPayment: (id) => call('GET', `/v1/payments/${enc(id)}`),
    listPayments: async (orderId) => (await call<{ payments: LedgerPayment[] }>('GET', `/v1/orders/${enc(orderId)}/payments`)).payments,
    listPayouts: async (orderId) => (await call<{ payouts: LedgerPayout[] }>('GET', `/v1/orders/${enc(orderId)}/payouts`)).payouts,
    getReceipt: (orderId) => call('GET', `/v1/orders/${enc(orderId)}/receipt`),
    getReceiptText: (orderId) => call('GET', `/v1/orders/${enc(orderId)}/receipt?format=text`, { accept: 'text/plain' }),
    observe: (paymentId, body) => call('POST', `/v1/payments/${enc(paymentId)}/observations`, { body }),
  };
}
