/**
 * HTTP surface (contracts/openapi/scribbit-mint-api.yaml). Everything the scribb.it mint pages need from a
 * server, and nothing that touches a key:
 *
 *   GET  /api/fees                          fee snapshot (@bsh/scribbit-fee-oracle, injectable sources)
 *   GET  /api/esplora/address/:addr/utxo    payment UTXOs
 *   GET  /api/esplora/tx/:txid              a transaction (did the commit land? is it confirmed?)
 *   POST /api/esplora/tx                    broadcast a signed raw transaction (hex body)
 *   ANY  /api/cp/*                          allowlisted Counterparty v2 proxy (see cp-allowlist.ts)
 *   GET  /healthz, GET /
 *
 * Behind @bsh/edge: request ids, uniform JSON errors, security headers, CORS allowlist, per-IP token buckets
 * (a tighter one on broadcasts and composes), body limits.
 */
import { Hono } from 'hono';
import {
  bodyLimit,
  corsAllowlist,
  EdgeError,
  InMemoryRateLimitStore,
  jsonErrorHandler,
  jsonErrors,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
  type RateLimitStore,
} from '@bsh/edge';
import { FeesUnavailableError, isNetwork, type FeeProvider, type Network } from '@bsh/scribbit-fee-oracle';
import { CP_ALLOWLIST_DOC, cpRoute } from './cp-allowlist.js';
import { ADDRESS_RE, callUpstream, HEX_RE, TXID_RE, upstreamText, type FetchLike } from './upstream.js';

export const SERVICE_NAME = 'scribbit-mint-api';
export const SERVICE_VERSION = '0.1.0';

export interface Limits {
  /** POST /api/cp/addresses/:addr/compose/* form bodies: a 4 MiB description in hex is ~8 MiB. */
  maxComposeBytes: number;
  /** POST /api/esplora/tx and POST /api/cp/bitcoin/transactions: a block-sized reveal in hex. */
  maxBroadcastBytes: number;
  /** Every other body. */
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxComposeBytes: 8 * 1024 * 1024,
  maxBroadcastBytes: 8 * 1024 * 1024,
  maxBodyBytes: 64 * 1024,
  upstreamTimeoutMs: 20_000,
});

export interface AppOptions {
  network: Network;
  /** Esplora/mempool REST base, e.g. https://mempool.space/api (no trailing slash). */
  esploraUrl: string;
  /** Counterparty Core v2 base, e.g. https://api.counterparty.io:4000/v2. Unset: /api/cp/* answers 503. */
  cpUrl?: string | undefined;
  /** Fee provider for `network`. Unset: /api/fees answers 503. */
  fees?: FeeProvider | undefined;
  fetch?: FetchLike;
  /** Browser origins allowed to call the API. Default: none (every browser call is refused by CORS). */
  corsOrigins?: readonly string[];
  /** X-Forwarded-For is trusted only from these CIDRs. */
  trustedProxies?: readonly string[];
  rateLimit?: { ipPerMinute?: number; writePerMinute?: number; store?: RateLimitStore };
  limits?: Partial<Limits>;
  publicUrl?: string | undefined;
  onUnexpected?: (info: { requestId: string | undefined; error: unknown; where: string }) => void;
  version?: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function createApp(opts: AppOptions): Hono {
  if (!isNetwork(opts.network)) throw new Error(`unknown network "${opts.network}"`);
  const version = opts.version ?? SERVICE_VERSION;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const f: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const esplora = trimSlash(opts.esploraUrl);
  const cp = opts.cpUrl ? trimSlash(opts.cpUrl) : undefined;
  const rlStore = opts.rateLimit?.store ?? new InMemoryRateLimitStore();
  const up = (label: string) => ({ fetch: f, timeoutMs: limits.upstreamTimeoutMs, label });

  const app = new Hono();
  app.onError(jsonErrorHandler({ onUnexpected: (error, c) => opts.onUnexpected?.({ requestId: c.get('requestId'), error, where: 'http' }) }));
  app.use(requestId());
  app.use(jsonErrors());
  app.use(securityHeaders());
  if (opts.corsOrigins?.length) app.use(corsAllowlist([...opts.corsOrigins], { allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'X-Request-Id'] }));
  if (opts.trustedProxies?.length) app.use(trustProxy({ trusted: [...opts.trustedProxies] }));
  app.use(rateLimit({ windowMs: 60_000, max: opts.rateLimit?.ipPerMinute ?? 300, store: rlStore, prefix: 'ip' }));
  // Writes (broadcasts, composes) get a second, tighter bucket: they are the expensive calls upstream.
  const writeLimit = rateLimit({ windowMs: 60_000, max: opts.rateLimit?.writePerMinute ?? 30, store: rlStore, prefix: 'write', headers: false });
  app.use((c, next) => (c.req.method === 'POST' ? writeLimit(c, next) : next()));
  // Body limits by route: composes and broadcasts carry a whole inscription; nothing else carries anything.
  const composeBody = bodyLimit(limits.maxComposeBytes);
  const broadcastBody = bodyLimit(limits.maxBroadcastBytes);
  const smallBody = bodyLimit(limits.maxBodyBytes);
  app.use((c, next) => {
    const p = c.req.path;
    if (c.req.method !== 'POST') return next();
    if (p === '/api/esplora/tx' || p === '/api/cp/bitcoin/transactions') return broadcastBody(c, next);
    if (/^\/api\/cp\/addresses\/[^/]+\/compose\/[^/]+$/.test(p)) return composeBody(c, next);
    return smallBody(c, next);
  });

  app.get('/', (c) =>
    c.json({
      name: SERVICE_NAME,
      title: 'scribb.it mint API',
      version,
      network: opts.network,
      endpoints: {
        fees: '/api/fees',
        esplora: ['/api/esplora/address/{addr}/utxo', '/api/esplora/tx/{txid}', 'POST /api/esplora/tx'],
        cp: cp ? CP_ALLOWLIST_DOC : null,
      },
      limits: { maxComposeBytes: limits.maxComposeBytes, maxBroadcastBytes: limits.maxBroadcastBytes },
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
    }),
  );

  app.get('/healthz', (c) => c.json({ status: 'ok', service: SERVICE_NAME, version, network: opts.network, counterparty: cp !== undefined, fees: opts.fees !== undefined }));

  // ---------------------------------------------------------------- fees
  app.get('/api/fees', async (c) => {
    if (!opts.fees) throw new EdgeError(503, 'fees_unavailable', 'No fee source is configured for this network');
    try {
      const fees = await opts.fees.getFees();
      c.header('Cache-Control', fees.stale ? 'no-store' : 'public, max-age=10');
      return c.json(fees);
    } catch (e) {
      if (e instanceof FeesUnavailableError) throw new EdgeError(503, 'fees_unavailable', e.message, { 'Retry-After': '5' });
      throw e;
    }
  });

  // ---------------------------------------------------------------- esplora
  app.get('/api/esplora/address/:addr/utxo', async (c) => {
    const addr = c.req.param('addr');
    if (!ADDRESS_RE.test(addr)) throw new EdgeError(400, 'bad_request', 'Malformed address');
    const res = await callUpstream(`${esplora}/address/${encodeURIComponent(addr)}/utxo`, { headers: { accept: 'application/json' } }, up('Esplora'));
    if (!res.ok) throw new EdgeError(502, 'upstream_error', `Esplora answered ${res.status}: ${await upstreamText(res)}`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) throw new EdgeError(502, 'upstream_error', 'Esplora returned something that is not a UTXO list');
    c.header('Cache-Control', 'no-store');
    return c.json(
      list.map((u: { txid: string; vout: number; value: number; status?: { confirmed?: boolean; block_height?: number } }) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        status: { confirmed: u.status?.confirmed === true, ...(typeof u.status?.block_height === 'number' ? { block_height: u.status.block_height } : {}) },
      })),
    );
  });

  app.get('/api/esplora/tx/:txid', async (c) => {
    const txid = c.req.param('txid');
    if (!TXID_RE.test(txid)) throw new EdgeError(400, 'bad_request', 'Malformed txid');
    const res = await callUpstream(`${esplora}/tx/${txid.toLowerCase()}`, { headers: { accept: 'application/json' } }, up('Esplora'));
    if (res.status === 404) throw new EdgeError(404, 'not_found', 'Transaction not found (not in the mempool or the chain this Esplora sees)');
    if (!res.ok) throw new EdgeError(502, 'upstream_error', `Esplora answered ${res.status}: ${await upstreamText(res)}`);
    const tx = (await res.json()) as Record<string, unknown>;
    c.header('Cache-Control', 'no-store');
    return c.json(tx);
  });

  app.post('/api/esplora/tx', async (c) => {
    const hex = (await c.req.text()).trim();
    if (!hex || hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new EdgeError(400, 'bad_request', 'Body must be the raw transaction as hex');
    const res = await callUpstream(`${esplora}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex }, up('Esplora'));
    const text = await upstreamText(res, 2000);
    if (!res.ok) throw new EdgeError(res.status === 400 ? 400 : 502, res.status === 400 ? 'broadcast_rejected' : 'upstream_error', `Broadcast refused: ${text}`);
    if (!TXID_RE.test(text)) throw new EdgeError(502, 'upstream_error', `Esplora did not return a txid: ${text}`);
    c.header('Cache-Control', 'no-store');
    return c.json({ txid: text.toLowerCase() });
  });

  // ---------------------------------------------------------------- counterparty
  app.all('/api/cp/*', async (c) => {
    const path = c.req.path.replace(/^\/api\/cp\//, '');
    const route = cpRoute(c.req.method, path);
    if (!route) throw new EdgeError(403, 'cp_not_allowed', `not proxied: ${c.req.method} /${path}`);
    if (!cp) throw new EdgeError(503, 'cp_unavailable', 'No Counterparty node is configured for this network');
    const url = new URL(c.req.url);
    const target = `${cp}/${path}${url.search}`;
    const init: RequestInit = { method: c.req.method, headers: { accept: 'application/json' } };
    if (c.req.method === 'POST') {
      const ct = c.req.header('content-type') ?? 'application/x-www-form-urlencoded';
      if (!ct.startsWith('application/x-www-form-urlencoded')) throw new EdgeError(415, 'unsupported_media_type', 'Composes and broadcasts are form-encoded (application/x-www-form-urlencoded)');
      const body = await c.req.text();
      if (route.kind === 'broadcast') {
        const hex = new URLSearchParams(body).get('signedhex') ?? '';
        if (!hex || hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new EdgeError(400, 'bad_request', 'signedhex must be the raw transaction as hex');
      }
      init.body = body;
      (init.headers as Record<string, string>)['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await callUpstream(target, init, up('Counterparty'));
    const text = await res.text();
    // Upstream status and JSON body pass through: 404 "no such asset" is an answer the page relies on.
    c.header('Cache-Control', 'no-store');
    return c.body(text, res.status as 200, { 'content-type': res.headers.get('content-type') ?? 'application/json' });
  });

  return app;
}
