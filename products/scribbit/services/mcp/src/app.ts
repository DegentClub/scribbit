/**
 * HTTP surface (contracts/openapi/scribbit-mcp.yaml): the MCP Streamable HTTP endpoint at /mcp behind
 * @bsh/edge (request ids, JSON errors, security headers, rate limits, API keys), plus /healthz, / (discovery)
 * and /v1/keys/me (introspect the presented key). Stateless MCP mode: one McpServer + transport per request.
 */
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  apiKeys,
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
  type ApiKeyEnv,
  type ApiKeyStore,
  type RateLimitStore,
} from '@bsh/edge';
import type { Network } from '@bsh/inscription';
import { DEFAULT_MAX_BODY_BYTES } from './limits.js';
import { createScribbitMcpServer, SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from './mcp.js';
import type { ScribbitMcpPorts } from './tools.js';

/** Scope an API key needs to call the MCP endpoint. */
export const MCP_SCOPE = 'mcp';

export interface AppOptions {
  ports?: ScribbitMcpPorts;
  keys: ApiKeyStore;
  /** Only keys of this environment are accepted (default live). */
  keyEnv?: ApiKeyEnv;
  /** Default true. False allows anonymous MCP calls (local development only). */
  requireApiKey?: boolean;
  networks?: readonly Network[];
  /** Absolute URL clients use; advertised on GET /. */
  publicUrl?: string | undefined;
  /** Enables X-Forwarded-For from these CIDRs only. Leave unset when reachable directly. */
  trustedProxies?: readonly string[];
  /** Browser origins allowed to call the API (MCP clients are usually not browsers). Default: none. */
  corsOrigins?: readonly string[];
  rateLimit?: { ipPerMinute?: number; keyPerMinute?: number; store?: RateLimitStore };
  maxBodyBytes?: number;
  /** Sink for unexpected 5xx / tool failures (request id, never a stack to the client). */
  onUnexpected?: (info: { requestId: string | undefined; error: unknown; where: string }) => void;
  now?: () => number;
  version?: string;
}

export function createApp(opts: AppOptions): Hono {
  const version = opts.version ?? SERVER_VERSION;
  const networks = opts.networks ?? ['mainnet'];
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rlStore = opts.rateLimit?.store ?? new InMemoryRateLimitStore();
  const ports: ScribbitMcpPorts = {
    ...opts.ports,
    onUnexpected: (tool, error) => {
      opts.ports?.onUnexpected?.(tool, error);
      opts.onUnexpected?.({ requestId: undefined, error, where: `tool:${tool}` });
    },
  };

  const app = new Hono();
  app.onError(jsonErrorHandler({ onUnexpected: (error, c) => opts.onUnexpected?.({ requestId: c.get('requestId'), error, where: 'http' }) }));
  app.use(requestId());
  app.use(jsonErrors());
  app.use(securityHeaders());
  if (opts.corsOrigins?.length)
    app.use(corsAllowlist([...opts.corsOrigins], { allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'X-API-Key'], exposeHeaders: ['Mcp-Session-Id', 'X-Request-Id'] }));
  if (opts.trustedProxies?.length) app.use(trustProxy({ trusted: [...opts.trustedProxies] }));
  // Per-IP bucket everywhere (before auth, so unauthenticated floods are cheap). On /mcp the per-key bucket
  // below reports the RateLimit-* headers instead, so the IP bucket stays silent there.
  const ipLimit = { windowMs: 60_000, max: opts.rateLimit?.ipPerMinute ?? 600, store: rlStore, prefix: 'ip' };
  const ipLimitLoud = rateLimit(ipLimit);
  const ipLimitQuiet = rateLimit({ ...ipLimit, headers: false });
  app.use((c, next) => (c.req.path === '/mcp' ? ipLimitQuiet(c, next) : ipLimitLoud(c, next)));
  app.use(bodyLimit(maxBody));

  const auth = apiKeys({ store: opts.keys, required: opts.requireApiKey ?? true, scopes: [MCP_SCOPE], environment: opts.keyEnv ?? 'live', ...(opts.now ? { now: opts.now } : {}) });
  app.use('/mcp', auth);
  app.use('/v1/*', auth);
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: opts.rateLimit?.keyPerMinute ?? 120, key: 'apiKey', store: rlStore, prefix: 'key' }));

  app.get('/', (c) =>
    c.json({
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version,
      mcp: {
        endpoint: opts.publicUrl ? new URL('/mcp', opts.publicUrl).href : '/mcp',
        transport: 'streamable-http',
        protocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26'],
        auth: { scheme: 'bearer', keyPrefix: `bsh_${opts.keyEnv ?? 'live'}_`, scope: MCP_SCOPE, header: 'Authorization' },
        tools: ['get_fees', 'quote_inscription', 'build_envelope', 'commit_address', 'explain_lanes', 'rescue_tx'],
        resources: ['scribbit://docs/lanes', 'scribbit://docs/security-model'],
        prompts: ['inscribe_this'],
      },
      networks,
      limits: { maxBodyBytes: maxBody, maxContentBytes: 4 * 1024 * 1024 },
    }),
  );

  app.get('/healthz', (c) => c.json({ status: 'ok', service: SERVER_NAME, version, networks }));

  app.get('/v1/keys/me', (c) => {
    const p = c.get('apiKey');
    if (!p) throw new EdgeError(401, 'missing_api_key', 'API key required', { 'WWW-Authenticate': 'Bearer realm="api"' });
    return c.json({ id: p.id, env: p.env, scopes: [...p.scopes], ...(p.ownerId !== undefined ? { ownerId: p.ownerId } : {}) });
  });

  // Stateless: no server-initiated stream (GET) and no session to terminate (DELETE). The transport would
  // otherwise open an SSE stream that nothing ever writes to.
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST /mcp' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.post('/mcp', async (c) => {
    const server = createScribbitMcpServer(ports);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no Mcp-Session-Id, every request is self-contained
      enableJsonResponse: true, // tools answer synchronously; JSON bodies are simpler for clients and proxies
      maxRequestBodySize: maxBody,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  return app;
}
