import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { InMemoryApiKeyStore, generateApiKey } from '@bsh/edge';
import { InMemoryBus, platformRegistry, type EventEnvelope } from '@bsh/events';
import { createLedgerApp, FakeProvider, LedgerService, MemoryOrderStore, type BtcpayInvoice, type BtcpayPaymentMethod, type Fetch, type Order, type PaymentProvider } from '../src/index.js';

export const T0 = Date.parse('2026-09-23T12:00:00.000Z');

/** Fake clock: `now()` returns the current instant; `tick(ms)` advances it. */
export function fakeClock(start = T0) {
  let t = start;
  return { now: () => new Date(t), tick: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

export function seqIds(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(4, '0')}`;
}

export const hmacHex = (secret: string, data: string): string => bytesToHex(hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(data)));

export function orderBody(overrides: Partial<{ product: string; customerRef: string; lineItems: unknown[]; metadata: Record<string, string> }> = {}) {
  return {
    product: 'scribbit',
    customerRef: 'user-42',
    lineItems: [
      { sku: 'inscribe-std', description: 'Standard inscription', quantity: 2, unitSats: 15_000 },
      { sku: 'fee', description: 'Network fee', quantity: 1, unitSats: 4_200 },
    ],
    metadata: { batch: 'b-1' },
    ...overrides,
  };
}
export const ORDER_TOTAL = 2 * 15_000 + 4_200;

/** Everything a test needs: service + bus + app + keys, on the in-memory store. */
export function harness(opts: { providers?: PaymentProvider[]; clock?: ReturnType<typeof fakeClock>; verifyWebhooks?: boolean } = {}) {
  const clock = opts.clock ?? fakeClock();
  const store = new MemoryOrderStore();
  const fake = new FakeProvider();
  const providers = opts.providers ?? [fake];
  const events: EventEnvelope[] = [];
  const bus = new InMemoryBus({ registry: platformRegistry() });
  const service = new LedgerService({ store, providers, bus, now: clock.now, newId: seqIds(), verifyWebhooks: opts.verifyWebhooks ?? true });
  const apiKeyStore = new InMemoryApiKeyStore();
  const mk = (ownerId: string, scopes: string[] = ['ledger']) => {
    const k = generateApiKey('test');
    apiKeyStore.add({ id: `key-${ownerId}`, hash: k.hash, env: 'test', scopes, ownerId });
    return k.key;
  };
  const keys = { scribbit: mk('scribbit'), degent: mk('degent'), admin: mk('ops', ['ledger', 'ledger:admin']), noProduct: mk('someone') };
  const app = createLedgerApp({ service, apiKeyStore, environment: 'test', now: clock.now, onUnexpected: (e) => console.error(e) });
  const ready = bus.subscribe('ledger.#', (e) => void events.push(e), { name: 'test.ledger' });
  const req = async (path: string, init: RequestInit & { key?: string; json?: unknown } = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set('X-API-Key', init.key);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    return app.request(path, { ...init, headers, ...(body !== undefined ? { body } : {}) });
  };
  return { clock, store, fake, providers, service, bus, app, keys, events, ready, req };
}

export async function createOrder(h: ReturnType<typeof harness>, overrides = {}): Promise<Order> {
  const res = await h.req('/v1/orders', { method: 'POST', key: h.keys.scribbit, json: orderBody(overrides) });
  if (res.status !== 201) throw new Error(`createOrder: ${res.status} ${await res.text()}`);
  return (await res.json()) as Order;
}

// ------------------------------------------------------------------------------------------ fake BTCPay server

/** In-memory Greenfield API: enough of BTCPay to create invoices, poll them, and settle them from a test. */
export class FakeBtcpayServer {
  readonly invoices = new Map<string, BtcpayInvoice & { methods: BtcpayPaymentMethod[] }>();
  readonly requests: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  private n = 0;

  constructor(
    readonly baseUrl = 'https://btcpay.test',
    readonly storeId = 'store1',
    readonly apiKey = 'apikey-secret',
    readonly webhookSecret = 'whsec-btcpay',
  ) {}

  fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url, body, auth: headers.get('authorization') ?? undefined });
    if (headers.get('authorization') !== `token ${this.apiKey}`) return json({ message: 'unauthorized' }, 401);
    const prefix = `${this.baseUrl}/api/v1/stores/${this.storeId}`;
    if (!url.startsWith(prefix)) return json({ message: 'not found' }, 404);
    const path = url.slice(prefix.length);
    if (method === 'POST' && path === '/invoices') {
      const id = `inv${++this.n}`;
      const ln = (body.checkout?.paymentMethods ?? []).some((m: string) => /lightning|ln/i.test(m));
      const inv = {
        id,
        status: 'New' as const,
        amount: body.amount,
        currency: body.currency,
        checkoutLink: `${this.baseUrl}/i/${id}`,
        expirationTime: Math.floor(T0 / 1000) + 60 * (body.checkout?.expirationMinutes ?? 15),
        metadata: body.metadata,
        methods: [
          ln
            ? { paymentMethodId: 'BTC-LightningNetwork', destination: `lnbc${id}fake`, totalPaid: '0', due: body.amount, payments: [] }
            : { paymentMethodId: 'BTC', destination: `bc1q${id}fake`, totalPaid: '0', due: body.amount, payments: [] },
        ],
      };
      this.invoices.set(id, inv);
      return json(stripMethods(inv));
    }
    const m = /^\/invoices\/([^/]+)(\/payment-methods|\/refund)?$/.exec(path);
    if (m) {
      const inv = this.invoices.get(decodeURIComponent(m[1]!));
      if (!inv) return json({ message: 'not found' }, 404);
      if (method === 'GET' && !m[2]) return json(stripMethods(inv));
      if (method === 'GET' && m[2] === '/payment-methods') return json(inv.methods);
      if (method === 'POST' && m[2] === '/refund') return json({ id: `pp_${inv.id}`, viewLink: `${this.baseUrl}/pull-payments/pp_${inv.id}` });
    }
    return json({ message: 'not found' }, 404);
  };

  settle(id: string, opts: { paidBtc?: string; over?: boolean; txid?: string } = {}): void {
    const inv = this.invoices.get(id)!;
    inv.status = 'Settled';
    inv.additionalStatus = opts.over ? 'PaidOver' : 'None';
    const pm = inv.methods[0]!;
    pm.totalPaid = opts.paidBtc ?? inv.amount;
    pm.payments = [{ id: opts.txid ?? `${'ab'.repeat(32)}-0`, value: pm.totalPaid, status: 'Settled' }];
  }

  setStatus(id: string, status: BtcpayInvoice['status'], additionalStatus?: BtcpayInvoice['additionalStatus']): void {
    const inv = this.invoices.get(id)!;
    inv.status = status;
    if (additionalStatus) inv.additionalStatus = additionalStatus;
  }

  /** A signed webhook request as BTCPay would send it. */
  webhook(type: string, invoiceId: string, extra: Record<string, unknown> = {}, secret = this.webhookSecret): { body: string; headers: Record<string, string> } {
    const payload = { deliveryId: `d${++this.n}`, webhookId: 'wh1', originalDeliveryId: `d${this.n}`, isRedelivery: false, type, timestamp: Math.floor(T0 / 1000), storeId: this.storeId, invoiceId, metadata: {}, ...extra };
    const body = JSON.stringify(payload);
    return { body, headers: { 'content-type': 'application/json', 'BTCPay-Sig': `sha256=${hmacHex(secret, body)}` } };
  }
}

const stripMethods = (inv: BtcpayInvoice & { methods: unknown }): BtcpayInvoice => {
  const { methods: _m, ...rest } = inv;
  return rest;
};

export const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** Signed card-provider webhook (`Stripe-Signature` scheme). */
export function cardWebhook(secret: string, event: unknown, t = Math.floor(T0 / 1000)): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  return { body, headers: { 'content-type': 'application/json', 'Stripe-Signature': `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}` } };
}
