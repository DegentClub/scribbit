/**
 * HTTP surface (contracts/openapi/scribbit-mcp.yaml): the MCP Streamable HTTP endpoint at /mcp behind
 * @bsh/edge (request ids, JSON errors, security headers, rate limits, API keys), plus /healthz, / (discovery),
 * /.well-known/agent.json + /.well-known/mcp.json (unauthenticated, cacheable) and /v1/keys/me (introspect the
 * presented key). Stateless MCP mode: one McpServer + transport per request, built with the caller's scopes.
 */
import { Hono, type Context } from 'hono';
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
import { createScribbitMcpServer, promptNames, resourceUris, SERVER_NAME, SERVER_TITLE, SERVER_VERSION, TOOLS, toolNames, toolScopes } from './mcp.js';
import { isMcpScope, MCP_SCOPES, mcpScopesOf, SCOPE_MCP, scopeConflict } from './scopes.js';
import type { ScribbitMcpPorts } from './tools.js';

/** The base (read-only) scope; see `scopes.ts` for the others. */
export const MCP_SCOPE = SCOPE_MCP;
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const PROVIDER = { organization: 'Blockspace Holdings', url: 'https://blockspace.holdings' } as const;
export const AGENT_CARD_PATH = '/.well-known/agent.json';
export const MCP_MANIFEST_PATH = '/.well-known/mcp.json';
export const FLASHYOS_LINKS = { charter: '/.well-known/flashyos-charter.json', frontdoor: '/.well-known/frontdoor.json' } as const;
/** Well-known documents change only with a deploy: let clients and the edge cache them for a few minutes. */
export const WELL_KNOWN_CACHE_CONTROL = 'public, max-age=300';

export interface AppOptions {
  ports?: ScribbitMcpPorts;
  keys: ApiKeyStore;
  /** Only keys of this environment are accepted (default live). */
  keyEnv?: ApiKeyEnv;
  /** Default true. False allows anonymous MCP calls (local development only; anonymous callers are unrestricted). */
  requireApiKey?: boolean;
  networks?: readonly Network[];
  /** Absolute URL clients use; advertised on GET / and in the agent card. */
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

const endpointUrl = (publicUrl: string | undefined, path: string): string => (publicUrl ? new URL(path, publicUrl).href : path);

/** A2A-style agent card: who we are, where the endpoint is, and every skill (tool) with the scopes it needs. */
export function agentCard(o: { publicUrl?: string | undefined; version: string; networks: readonly Network[]; keyEnv: ApiKeyEnv; ledger: boolean }): Record<string, unknown> {
  return {
    name: SERVER_TITLE,
    description:
      'scribb.it writes data onto Bitcoin as ordinals inscriptions. This agent quotes an inscription to the sat, derives the commit address, turns a quote into a ledger order with a psbt payment intent your own wallet funds, records the funding transaction and issues the receipt. Non-custodial: it never holds a key, a PSBT or funds, and never broadcasts.',
    url: endpointUrl(o.publicUrl, '/mcp'),
    provider: { ...PROVIDER },
    version: o.version,
    documentationUrl: endpointUrl(o.publicUrl, '/'),
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', description: `A scribb.it API key (bsh_${o.keyEnv}_…) with one of the scopes ${MCP_SCOPES.join(', ')}; also accepted as X-API-Key.` },
    },
    security: [{ apiKey: [] }],
    skills: TOOLS.map((t) => ({
      id: t.name,
      name: t.title,
      description: t.description,
      tags: [...t.scopes.map((s) => `scope:${s}`), t.annotations.readOnlyHint ? 'read-only' : 'ledger-write'],
      scopes: [...t.scopes],
      inputModes: ['application/json'],
      outputModes: ['application/json', 'text/plain'],
    })),
    'x-flashyos': { ...FLASHYOS_LINKS },
    'x-mcp': { endpoint: endpointUrl(o.publicUrl, '/mcp'), transport: 'streamable-http', manifest: endpointUrl(o.publicUrl, MCP_MANIFEST_PATH), protocolVersions: [...PROTOCOL_VERSIONS] },
    'x-scribbit': { networks: [...o.networks], orders: o.ledger, resources: resourceUris(), prompts: promptNames() },
  };
}

/** How to reach the MCP endpoint: transport, protocol versions, auth scheme and the tool list with scopes. */
export function mcpManifest(o: { publicUrl?: string | undefined; version: string; networks: readonly Network[]; keyEnv: ApiKeyEnv; ledger: boolean }): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    title: SERVER_TITLE,
    version: o.version,
    transport: 'streamable-http',
    endpoint: endpointUrl(o.publicUrl, '/mcp'),
    protocolVersions: [...PROTOCOL_VERSIONS],
    stateless: true,
    auth: { scheme: 'bearer', header: 'Authorization', alternateHeader: 'X-API-Key', keyPrefix: `bsh_${o.keyEnv}_`, scopes: [...MCP_SCOPES], scope: MCP_SCOPE },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, scopes: [...t.scopes], readOnly: t.annotations.readOnlyHint === true })),
    resources: resourceUris(),
    prompts: promptNames(),
    networks: [...o.networks],
    orders: o.ledger,
    agentCard: endpointUrl(o.publicUrl, AGENT_CARD_PATH),
  };
}

export function createApp(opts: AppOptions): Hono {
  const version = opts.version ?? SERVER_VERSION;
  const networks = opts.networks ?? ['mainnet'];
  const keyEnv = opts.keyEnv ?? 'live';
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rlStore = opts.rateLimit?.store ?? new InMemoryRateLimitStore();
  const basePorts: ScribbitMcpPorts = {
    ...opts.ports,
    onUnexpected: (tool, error) => {
      opts.ports?.onUnexpected?.(tool, error);
      opts.onUnexpected?.({ requestId: undefined, error, where: `tool:${tool}` });
    },
  };
  const wellKnown = { publicUrl: opts.publicUrl, version, networks, keyEnv, ledger: opts.ports?.ledger !== undefined };

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

  // Any MCP scope opens the door; each tool then checks its own (see scopes.ts). A key holding both mcp:order
  // and mcp:settle is refused outright: configuration must never let one party propose and settle.
  const auth = apiKeys({ store: opts.keys, required: opts.requireApiKey ?? true, scopes: [], environment: keyEnv, ...(opts.now ? { now: opts.now } : {}) });
  const scopeGate = async (c: Context, next: () => Promise<void>) => {
    const p = c.get('apiKey');
    if (p) {
      const conflict = scopeConflict(p.scopes);
      if (conflict) throw new EdgeError(403, 'insufficient_scope', `API key ${p.id}: ${conflict}`);
      if (!p.scopes.some(isMcpScope))
        throw new EdgeError(403, 'insufficient_scope', `API key lacks an MCP scope (one of ${MCP_SCOPES.join(', ')})`, {
          'WWW-Authenticate': `Bearer realm="api", error="insufficient_scope", scope="${MCP_SCOPES.join(' ')}"`,
        });
    }
    await next();
  };
  for (const p of ['/mcp', '/v1/*']) {
    app.use(p, auth);
    app.use(p, scopeGate);
  }
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: opts.rateLimit?.keyPerMinute ?? 120, key: 'apiKey', store: rlStore, prefix: 'key' }));

  app.get('/', (c) =>
    c.json({
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version,
      mcp: {
        endpoint: endpointUrl(opts.publicUrl, '/mcp'),
        transport: 'streamable-http',
        protocolVersions: [...PROTOCOL_VERSIONS],
        auth: { scheme: 'bearer', keyPrefix: `bsh_${keyEnv}_`, scope: MCP_SCOPE, scopes: [...MCP_SCOPES], header: 'Authorization' },
        tools: toolNames(),
        toolScopes: toolScopes(),
        resources: resourceUris(),
        prompts: promptNames(),
      },
      wellKnown: { agentCard: endpointUrl(opts.publicUrl, AGENT_CARD_PATH), mcp: endpointUrl(opts.publicUrl, MCP_MANIFEST_PATH), ...FLASHYOS_LINKS },
      orders: wellKnown.ledger,
      networks,
      limits: { maxBodyBytes: maxBody, maxContentBytes: 4 * 1024 * 1024 },
    }),
  );

  app.get(AGENT_CARD_PATH, (c) => {
    c.header('Cache-Control', WELL_KNOWN_CACHE_CONTROL);
    return c.json(agentCard(wellKnown));
  });
  app.get(MCP_MANIFEST_PATH, (c) => {
    c.header('Cache-Control', WELL_KNOWN_CACHE_CONTROL);
    return c.json(mcpManifest(wellKnown));
  });

  app.get('/healthz', (c) => c.json({ status: 'ok', service: SERVER_NAME, version, networks, orders: wellKnown.ledger }));

  app.get('/v1/keys/me', (c) => {
    const p = c.get('apiKey');
    if (!p) throw new EdgeError(401, 'missing_api_key', 'API key required', { 'WWW-Authenticate': 'Bearer realm="api"' });
    return c.json({ id: p.id, env: p.env, scopes: [...p.scopes], mcpScopes: mcpScopesOf(p.scopes), ...(p.ownerId !== undefined ? { ownerId: p.ownerId } : {}) });
  });

  // Stateless: no server-initiated stream (GET) and no session to terminate (DELETE). The transport would
  // otherwise open an SSE stream that nothing ever writes to.
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST /mcp' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.post('/mcp', async (c) => {
    const principal = c.get('apiKey');
    // A key restricts the caller to its scopes; an anonymous caller (MCP_REQUIRE_API_KEY=false, local dev) is unrestricted.
    const server = createScribbitMcpServer(principal ? { ...basePorts, scopes: principal.scopes } : basePorts);
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
