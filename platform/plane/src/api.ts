// The plane's HTTP surface (contracts/openapi/plane.yaml) on the platform edge stack.
import { Hono, type Context } from 'hono';
import {
  apiKeys,
  bodyLimit,
  EdgeError,
  jsonErrorHandler,
  jsonErrors,
  jsonNotFound,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
  type ApiKeyEnv,
  type ApiKeyPrincipal,
  type ApiKeyStore,
  type RateLimitStore,
  type TrustProxyOptions,
} from '@bsh/edge';
import { PLANE_WELL_KNOWN } from '@bsh/mesh';
import { APPROVAL_HEADER, verifyApproval, type Approver } from './approval.ts';
import { principalOf, scopeConflict } from './config.ts';
import { NAME_RE, ORG_RE, SCOPE_DELEGATE, SCOPE_READ, SCOPE_SETTLE } from './decide.ts';
import { PlaneError, verdictStatus, type PlaneService } from './service.ts';
import type { NonceStore } from './store/types.ts';

export const API_VERSION = '0.1.0';
const MAX_BODY = 64 * 1024;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DECISION_ID_RE = /^dec_[A-Za-z0-9-]+$/;

export interface PlaneAppOptions {
  service: PlaneService;
  apiKeyStore: ApiKeyStore;
  /** People whose Ed25519 signature is the second factor on envelope changes and resolutions. */
  approvers?: readonly Approver[];
  /** Where approvals are marked used (default: the service's store). */
  nonces?: NonceStore;
  environment?: ApiKeyEnv;
  rateLimit?: { windowMs: number; max: number; store?: RateLimitStore };
  trustProxy?: TrustProxyOptions;
  onUnexpected?: (err: unknown, c: Context) => void;
  version?: string;
}

const toEdge = (err: Error): Error => (err instanceof PlaneError ? new EdgeError(err.status, err.code, err.message) : err);

export function createPlaneApp(opts: PlaneAppOptions): Hono {
  const { service } = opts;
  const approvers = opts.approvers ?? [];
  const nonces = opts.nonces ?? service.store;
  const app = new Hono();

  const render = jsonErrorHandler({ onUnexpected: opts.onUnexpected ?? ((err, c) => console.error('plane: unexpected error', c.get('requestId'), err)) });
  app.onError((err, c) => render(toEdge(err), c));
  app.notFound(jsonNotFound());
  app.use(requestId());
  app.use(jsonErrors());
  app.use(async (c, next) => {
    await next();
    if (c.error) c.error = toEdge(c.error);
  });
  app.use(securityHeaders());
  if (opts.trustProxy) app.use(trustProxy(opts.trustProxy));
  app.use(bodyLimit(MAX_BODY));
  const rl = opts.rateLimit ?? { windowMs: 60_000, max: 600 };
  app.use(rateLimit({ windowMs: rl.windowMs, max: rl.max, prefix: 'ip', ...(rl.store ? { store: rl.store } : {}) }));

  app.get('/v1/health', (c) => c.json({ status: 'ok', version: opts.version ?? API_VERSION, chains: [...service.chains], ledger: service.ledger !== undefined, time: service.now().toISOString() }));

  // Public, never cached (FlashyOS Phase 23). securityHeaders already sends Cache-Control: no-store.
  app.get(PLANE_WELL_KNOWN, (c) => c.json(service.planeDocument()));

  app.use('/v1/orgs/*', apiKeys({ store: opts.apiKeyStore, scopes: [], ...(opts.environment ? { environment: opts.environment } : {}), now: () => service.now().getTime() }));
  app.use('/v1/orgs/*', rateLimit({ windowMs: rl.windowMs, max: Math.max(1, Math.floor(rl.max / 2)), key: 'apiKey', prefix: 'key', ...(rl.store ? { store: rl.store } : {}) }));

  /** The caller, bound to the route's organisation. */
  const caller = (c: Context): { key: ApiKeyPrincipal; org: string; name: string } => {
    const org = c.req.param('org') ?? '';
    if (!ORG_RE.test(org)) throw new EdgeError(400, 'invalid_request', 'org is an organisation slug');
    const key = c.get('apiKey');
    const who = principalOf(key?.ownerId);
    if (!key || !who) throw new EdgeError(403, 'not_a_plane_key', 'this API key is not bound to an organisation and a name');
    const conflict = scopeConflict(key.scopes);
    if (conflict) throw new EdgeError(403, 'insufficient_scope', conflict);
    if (who.org !== org) throw new EdgeError(403, 'org_mismatch', `this key belongs to ${who.org}, not ${org}`);
    return { key, org, name: who.name };
  };
  const requireScope = (key: ApiKeyPrincipal, ...anyOf: string[]): void => {
    if (!anyOf.some((s) => key.scopes.includes(s)))
      throw new EdgeError(403, 'insufficient_scope', `requires ${anyOf.join(' or ')}`, { 'WWW-Authenticate': `Bearer realm="api", error="insufficient_scope", scope="${anyOf.join(' ')}"` });
  };
  const requireJson = (c: Context): void => {
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) throw new EdgeError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  };
  const parseJson = (text: string): Record<string, unknown> => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new EdgeError(400, 'invalid_json', 'Body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EdgeError(400, 'invalid_request', 'Body must be a JSON object');
    return body as Record<string, unknown>;
  };
  const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
    requireJson(c);
    return parseJson(await c.req.text());
  };
  /** Read the raw body once, check the approval over it, then parse it. */
  const approvedBody = async (c: Context, org: string, key: ApiKeyPrincipal) => {
    requireJson(c);
    const raw = await c.req.text();
    const check = await verifyApproval(c.req.header(APPROVAL_HEADER), { method: c.req.method, path: c.req.path, body: raw, apiKeyId: key.id, org, approvers, now: service.now(), nonces });
    if (!check.ok) throw new EdgeError(403, check.code, check.detail);
    return { body: parseJson(raw), approver: check.approver };
  };

  app.post('/v1/orgs/:org/wallet/propose', async (c) => {
    const { key, org, name } = caller(c);
    const idem = c.req.header('Idempotency-Key');
    if (idem !== undefined && !IDEMPOTENCY_RE.test(idem)) throw new EdgeError(400, 'invalid_idempotency_key', 'Idempotency-Key must match [A-Za-z0-9._:-]{1,128}');
    const body = await jsonBody(c);
    const verdict = await service.propose(org, { orgId: org, agentName: name, scopes: key.scopes }, body, { ...(idem !== undefined ? { idempotencyKey: idem } : {}), caller: { apiKeyId: key.id } });
    return c.json(verdict, verdictStatus(verdict));
  });

  app.post('/v1/orgs/:org/wallet/settle', async (c) => {
    const { key, org } = caller(c);
    requireScope(key, SCOPE_SETTLE);
    const body = await jsonBody(c);
    return c.json(await service.settle(org, body, { apiKeyId: key.id }));
  });

  const agentParam = (c: Context): string => {
    const agent = c.req.param('agent') ?? '';
    if (!NAME_RE.test(agent)) throw new EdgeError(400, 'invalid_request', 'agent is a name ([a-z0-9][a-z0-9._-]{0,63})');
    return agent;
  };

  app.get('/v1/orgs/:org/wallet/envelopes/:agent', async (c) => {
    const { key, org } = caller(c);
    requireScope(key, SCOPE_DELEGATE);
    const agent = agentParam(c);
    return c.json({ orgId: org, agentName: agent, envelopes: await service.listEnvelopes(org, agent) });
  });

  app.put('/v1/orgs/:org/wallet/envelopes/:agent', async (c) => {
    const { key, org } = caller(c);
    requireScope(key, SCOPE_DELEGATE);
    const agent = agentParam(c);
    const { body, approver } = await approvedBody(c, org, key);
    return c.json(await service.putEnvelope(org, agent, body, { apiKeyId: key.id, approver: approver.name, approverKid: approver.kid }));
  });

  app.get('/v1/orgs/:org/wallet/decisions', async (c) => {
    const { key, org } = caller(c);
    requireScope(key, SCOPE_READ, SCOPE_DELEGATE);
    const sinceRaw = c.req.query('since');
    const limitRaw = c.req.query('limit');
    if (sinceRaw !== undefined && !/^(-1|0|[1-9][0-9]*)$/.test(sinceRaw)) throw new EdgeError(400, 'invalid_request', 'since is an integer >= -1');
    if (limitRaw !== undefined && (!/^[1-9][0-9]*$/.test(limitRaw) || Number(limitRaw) > 1000)) throw new EdgeError(400, 'invalid_request', 'limit is 1..1000');
    return c.json(await service.listAudit(org, sinceRaw === undefined ? -1 : Number(sinceRaw), limitRaw === undefined ? 200 : Number(limitRaw)));
  });

  app.post('/v1/orgs/:org/wallet/decisions/:decisionId/resolve', async (c) => {
    const { key, org } = caller(c);
    requireScope(key, SCOPE_DELEGATE);
    const decisionId = c.req.param('decisionId') ?? '';
    if (!DECISION_ID_RE.test(decisionId)) throw new EdgeError(400, 'invalid_request', 'decisionId looks like dec_…');
    const { body, approver } = await approvedBody(c, org, key);
    if (body.resolution !== 'APPROVED' && body.resolution !== 'REJECTED') throw new EdgeError(400, 'invalid_request', 'resolution is APPROVED or REJECTED');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) throw new EdgeError(400, 'invalid_request', 'note is a string of at most 1000 characters');
    const res = await service.resolveDecision(org, decisionId, body.resolution, { approver: approver.name, apiKeyId: key.id, ...(typeof body.note === 'string' ? { note: body.note } : {}) });
    return c.json(res);
  });

  return app;
}
