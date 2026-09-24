import { Hono, type Context } from 'hono';
import {
  EdgeError,
  apiKeys,
  bodyLimit,
  jsonErrorHandler,
  jsonErrors,
  jsonNotFound,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
  type ApiKeyEnv,
  type ApiKeyStore,
  type RateLimitStore,
  type TrustProxyOptions,
} from '@bsh/edge';
import { LedgerError } from './domain/errors.js';
import { PRODUCTS, type Product } from './domain/types.js';
import { buildReceipt, renderReceiptText } from './receipt.js';
import { WebhookError, type CallerContext, type LedgerService } from './service.js';

export const API_VERSION = '1.1.0';
export const SCOPE_LEDGER = 'ledger';
export const SCOPE_ADMIN = 'ledger:admin';

export interface LedgerAppOptions {
  service: LedgerService;
  apiKeyStore: ApiKeyStore;
  /** Only accept keys of this environment (`live` in production). */
  environment?: ApiKeyEnv;
  /** Webhook route name → provider adapter name. Default `{ btcpay: 'btcpay', card: 'card' }`. */
  webhooks?: Record<string, string>;
  rateLimit?: { windowMs: number; max: number; store?: RateLimitStore };
  trustProxy?: TrustProxyOptions;
  now?: () => Date;
  onUnexpected?: (err: unknown, c: Context) => void;
  /** Reported by /v1/health. */
  version?: string;
}

const MAX_BODY = 64 * 1024;

/**
 * The ledger's HTTP surface (contracts/openapi/ledger.yaml). Products authenticate with an API key whose
 * `ownerId` is their product slug; every order they create or read is scoped to it. Webhooks authenticate
 * with provider signatures, never API keys.
 */
export function createLedgerApp(opts: LedgerAppOptions): Hono {
  const { service } = opts;
  const now = opts.now ?? (() => new Date());
  const webhooks = opts.webhooks ?? { btcpay: 'btcpay', card: 'card' };
  const app = new Hono();

  // Domain errors carry their own status/code; map them before the edge renderer sees them.
  const render = jsonErrorHandler({ onUnexpected: opts.onUnexpected ?? ((err, c) => console.error('ledger: unexpected error', c.get('requestId'), err)) });
  app.onError((err, c) => render(toEdgeError(err), c));
  app.notFound(jsonNotFound());
  app.use(requestId());
  app.use(jsonErrors());
  // Hono stores the raw thrown error on `c.error`; jsonErrors renders from it, so map it there too.
  app.use(async (c, next) => {
    await next();
    if (c.error) c.error = toEdgeError(c.error);
  });
  app.use(securityHeaders());
  if (opts.trustProxy) app.use(trustProxy(opts.trustProxy));
  app.use(bodyLimit(MAX_BODY));
  const rl = opts.rateLimit ?? { windowMs: 60_000, max: 600 };
  app.use(rateLimit({ windowMs: rl.windowMs, max: rl.max, ...(rl.store ? { store: rl.store } : {}), prefix: 'ip' }));

  app.get('/v1/health', (c) => c.json({ status: 'ok', version: opts.version ?? API_VERSION, providers: service.providerNames(), time: now().toISOString() }));

  // ---------------------------------------------------------------- product API (API keys)
  const auth = apiKeys({ store: opts.apiKeyStore, scopes: [SCOPE_LEDGER], ...(opts.environment ? { environment: opts.environment } : {}), now: () => now().getTime() });
  const keyLimit = rateLimit({ windowMs: rl.windowMs, max: Math.max(1, Math.floor(rl.max / 2)), key: 'apiKey', prefix: 'key', ...(rl.store ? { store: rl.store } : {}) });
  for (const p of ['/v1/orders', '/v1/orders/*', '/v1/payments/*', '/v1/refunds/*', '/v1/payees/*']) {
    app.use(p, auth);
    app.use(p, keyLimit);
  }

  const caller = (c: Context): CallerContext => {
    const principal = c.get('apiKey');
    const product = principal?.ownerId;
    const admin = principal?.scopes.includes(SCOPE_ADMIN) ?? false;
    if (!admin && !PRODUCTS.includes(product as Product)) throw new EdgeError(403, 'no_product', 'API key is not bound to a product');
    const ctx: CallerContext = { product: admin ? null : (product as Product) };
    const key = c.req.header('Idempotency-Key');
    if (key !== undefined) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new EdgeError(400, 'invalid_idempotency_key', 'Idempotency-Key must match [A-Za-z0-9._:-]{1,128}');
      ctx.idempotencyKey = key;
    }
    return ctx;
  };

  const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
    const ct = c.req.header('content-type') ?? '';
    if (!/^application\/json\b/i.test(ct)) throw new EdgeError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new EdgeError(400, 'invalid_json', 'Body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EdgeError(400, 'invalid_request', 'Body must be a JSON object');
    return body as Record<string, unknown>;
  };

  app.post('/v1/orders', async (c) => {
    const ctx = caller(c);
    const body = await jsonBody(c);
    // A product-bound key may omit `product`; it is filled from the key.
    if (ctx.product && body.product === undefined) body.product = ctx.product;
    const { order, created } = await service.createOrder(body as never, ctx);
    return c.json(order, created ? 201 : 200);
  });

  app.get('/v1/orders/:id', async (c) => c.json(await service.getOrder(c.req.param('id'), caller(c))));

  app.post('/v1/orders/:id/cancel', async (c) => c.json(await service.cancelOrder(c.req.param('id'), caller(c))));

  app.post('/v1/orders/:id/payments', async (c) => {
    const ctx = caller(c);
    const body = await jsonBody(c);
    const input: Parameters<LedgerService['createPayment']>[1] = { method: body.method as never };
    if (typeof body.provider === 'string') input.provider = body.provider;
    if (typeof body.expiresAt === 'string') input.expiresAt = body.expiresAt;
    const { payment, created } = await service.createPayment(c.req.param('id'), input, ctx);
    return c.json(payment, created ? 201 : 200);
  });

  app.get('/v1/orders/:id/payments', async (c) => c.json({ payments: await service.listPayments(c.req.param('id'), caller(c)) }));

  app.get('/v1/orders/:id/payouts', async (c) => c.json({ payouts: await service.listPayouts(c.req.param('id'), caller(c)) }));

  app.get('/v1/payees/:ref/payouts', async (c) => {
    const kind = c.req.query('kind');
    return c.json({ payouts: await service.listPayeePayouts(c.req.param('ref'), kind !== undefined ? { kind } : {}, caller(c)) });
  });

  app.get('/v1/orders/:id/receipt', async (c) => {
    const ctx = caller(c);
    const id = c.req.param('id');
    const order = await service.getOrder(id, ctx);
    const [payments, refunds, payouts] = await Promise.all([service.listPayments(id, ctx), service.listRefunds(id, ctx), service.listPayouts(id, ctx)]);
    const receipt = buildReceipt(order, payments, refunds, now().toISOString(), payouts);
    const wantsText = c.req.query('format') === 'text' || /^text\/plain\b/i.test(c.req.header('accept') ?? '');
    if (wantsText) return c.text(renderReceiptText(receipt), 200, { 'content-type': 'text/plain; charset=utf-8' });
    return c.json(receipt);
  });

  app.get('/v1/payments/:id', async (c) => c.json(await service.getPayment(c.req.param('id'), caller(c))));

  app.post('/v1/payments/:id/refund', async (c) => {
    const ctx = caller(c);
    const body = await jsonBody(c);
    const input: Parameters<LedgerService['refund']>[1] = { reason: body.reason as string };
    if (body.amountSats !== undefined) input.amountSats = body.amountSats as number;
    if (typeof body.destination === 'string') input.destination = body.destination;
    const { refund, created } = await service.refund(c.req.param('id'), input, ctx);
    return c.json(refund, created ? 201 : 200);
  });

  app.get('/v1/refunds/:id', async (c) => c.json(await service.getRefund(c.req.param('id'), caller(c))));

  /** Operators settle refunds that need a manual payout (on-chain). Requires the admin scope. */
  app.post('/v1/refunds/:id/settle', async (c) => {
    const principal = c.get('apiKey');
    if (!principal?.scopes.includes(SCOPE_ADMIN)) throw new EdgeError(403, 'insufficient_scope', `requires ${SCOPE_ADMIN}`);
    const body = await jsonBody(c);
    if (body.status !== 'completed' && body.status !== 'failed') throw new EdgeError(400, 'invalid_request', 'status must be completed or failed');
    const detail = typeof body.detail === 'string' ? body.detail : undefined;
    return c.json(await service.settleRefund(c.req.param('id'), body.status, detail));
  });

  // ---------------------------------------------------------------- webhooks (provider signatures)
  for (const [route, providerName] of Object.entries(webhooks)) {
    app.post(`/v1/webhooks/${route}`, async (c) => {
      const raw = await c.req.text();
      const result = await service.handleWebhook(providerName, raw, c.req.raw.headers);
      return c.json(result, 200);
    });
  }

  return app;
}

function toEdgeError(err: Error): Error {
  if (err instanceof LedgerError) return new EdgeError(err.status, err.code, err.message);
  if (err instanceof WebhookError) return new EdgeError(err.code === 'invalid_signature' ? 401 : 400, err.code, err.message);
  return err;
}
