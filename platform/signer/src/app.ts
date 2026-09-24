/**
 * HTTP surface (contracts/openapi/signer.yaml) behind @bsh/edge. Authorisation is per key: an API key
 * needs scope `sign:<keyId>` to sign with a key, `keys:read` (or `sign:<keyId>`) to read its public key,
 * and `audit:read` for the audit endpoint. The service is meant to sit on a private network behind mTLS
 * (see README "Transport"); API keys are the application-level identity used for scopes and audit.
 */
import { Hono } from 'hono';
import {
  apiKeys,
  bodyLimit,
  EdgeError,
  InMemoryRateLimitStore,
  jsonErrorHandler,
  jsonErrors,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
  type ApiKeyEnv,
  type ApiKeyPrincipal,
  type ApiKeyStore,
  type RateLimitStore,
} from '@bsh/edge';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuditDecision, InMemoryAuditLog } from './audit.js';
import { isSignerError } from './errors.js';
import type { Signer } from './signer.js';

export const SERVICE_NAME = 'signer';
export const SERVICE_VERSION = '0.1.0';

export const scopeForKey = (keyId: string): string => `sign:${keyId}`;
export const SCOPE_KEYS_READ = 'keys:read';
export const SCOPE_AUDIT_READ = 'audit:read';

export interface SignerAppOptions {
  signer: Signer;
  keys: ApiKeyStore;
  keyEnv?: ApiKeyEnv;
  /** Needed for GET /v1/audit; without it the endpoint answers 404. */
  auditLog?: InMemoryAuditLog;
  trustedProxies?: readonly string[];
  rateLimit?: { ipPerMinute?: number; keyPerMinute?: number; store?: RateLimitStore };
  /** PSBT bodies are small; 256 KiB covers a few hundred inputs. */
  maxBodyBytes?: number;
  onUnexpected?: (info: { requestId: string | undefined; error: unknown }) => void;
  now?: () => number;
  version?: string;
}

function principalOf(c: { get(k: 'apiKey'): ApiKeyPrincipal | undefined }): ApiKeyPrincipal {
  const p = c.get('apiKey');
  if (!p) throw new EdgeError(401, 'missing_api_key', 'API key required', { 'WWW-Authenticate': 'Bearer realm="signer"' });
  return p;
}

function requireScope(p: ApiKeyPrincipal, ...anyOf: string[]): void {
  if (anyOf.some((s) => p.scopes.includes(s))) return;
  throw new EdgeError(403, 'insufficient_scope', `API key lacks scope: ${anyOf.join(' or ')}`, {
    'WWW-Authenticate': `Bearer realm="signer", error="insufficient_scope", scope="${anyOf.join(' ')}"`,
  });
}

async function jsonBody(c: { req: { json(): Promise<unknown>; header(n: string): string | undefined } }): Promise<Record<string, unknown>> {
  if (!/^application\/json/i.test(c.req.header('content-type') ?? '')) throw new EdgeError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new EdgeError(400, 'invalid_json', 'request body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new EdgeError(400, 'invalid_request', 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

function keyIdFrom(body: Record<string, unknown>): string {
  if (typeof body.keyId !== 'string' || !body.keyId) throw new EdgeError(400, 'invalid_request', 'keyId is required');
  return body.keyId;
}

export function createSignerApp(opts: SignerAppOptions): Hono {
  const version = opts.version ?? SERVICE_VERSION;
  const rlStore = opts.rateLimit?.store ?? new InMemoryRateLimitStore();
  const app = new Hono();

  app.onError(
    jsonErrorHandler({ onUnexpected: (error, c) => opts.onUnexpected?.({ requestId: c.get('requestId'), error }) }),
  );
  app.use(requestId());
  app.use(jsonErrors());
  app.use(securityHeaders());
  if (opts.trustedProxies?.length) app.use(trustProxy({ trusted: [...opts.trustedProxies] }));
  app.use(rateLimit({ windowMs: 60_000, max: opts.rateLimit?.ipPerMinute ?? 600, store: rlStore, prefix: 'ip' }));
  app.use(bodyLimit(opts.maxBodyBytes ?? 256 * 1024));

  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/health') return next();
    return apiKeys({ store: opts.keys, environment: opts.keyEnv ?? 'live', ...(opts.now ? { now: opts.now } : {}) })(c, next);
  });
  app.use('/v1/sign/*', rateLimit({ windowMs: 60_000, max: opts.rateLimit?.keyPerMinute ?? 120, key: 'apiKey', store: rlStore, prefix: 'key' }));

  // Signer errors become the uniform edge error body with the signer's code; policy denials are 403.
  const mapSignerError = (e: unknown): never => {
    if (isSignerError(e)) throw new EdgeError(e.status as ContentfulStatusCode, e.code, e.message);
    throw e;
  };

  app.get('/v1/health', async (c) =>
    c.json({ status: 'ok', service: SERVICE_NAME, version, network: opts.signer.network, keys: (await opts.signer.keyIds()).length }),
  );

  app.get('/v1/keys/:id/pubkey', async (c) => {
    const p = principalOf(c);
    const keyId = c.req.param('id');
    requireScope(p, SCOPE_KEYS_READ, scopeForKey(keyId));
    return c.json(await opts.signer.publicKey(keyId).catch(mapSignerError));
  });

  app.post('/v1/sign/taproot-keypath', async (c) => {
    const p = principalOf(c);
    const body = await jsonBody(c);
    const keyId = keyIdFrom(body);
    requireScope(p, scopeForKey(keyId));
    const result = await opts.signer
      .signTaprootKeyPath(
        { psbtBase64: body.psbtBase64 as string, inputIndex: body.inputIndex as number, keyId, finalize: body.finalize === true },
        { principal: p.id, requestId: c.get('requestId') },
      )
      .catch(mapSignerError);
    return c.json(result);
  });

  app.post('/v1/sign/digest', async (c) => {
    const p = principalOf(c);
    const body = await jsonBody(c);
    const keyId = keyIdFrom(body);
    requireScope(p, scopeForKey(keyId));
    const result = await opts.signer
      .signSchnorrDigest({ keyId, digest32: body.digest32 as string, purpose: body.purpose as string }, { principal: p.id, requestId: c.get('requestId') })
      .catch(mapSignerError);
    return c.json(result);
  });

  app.get('/v1/audit', (c) => {
    const p = principalOf(c);
    requireScope(p, SCOPE_AUDIT_READ);
    if (!opts.auditLog) throw new EdgeError(404, 'not_found', 'audit log is not queryable on this instance');
    const q = c.req.query();
    const decision = q.decision as AuditDecision | undefined;
    if (decision && !['allow', 'deny', 'error'].includes(decision)) throw new EdgeError(400, 'invalid_request', 'decision must be allow, deny or error');
    const limit = q.limit === undefined ? undefined : Number(q.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new EdgeError(400, 'invalid_request', 'limit must be a positive integer');
    const records = opts.auditLog.list({
      ...(q.keyId ? { keyId: q.keyId } : {}),
      ...(decision ? { decision } : {}),
      ...(q.principal ? { principal: q.principal } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ records, total: opts.auditLog.size });
  });

  return app;
}
