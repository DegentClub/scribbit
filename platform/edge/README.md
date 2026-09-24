# @bsh/edge

Reusable [Hono](https://hono.dev) middleware so every public service has the same edge behaviour:
request ids, uniform JSON errors, CORS allowlist, security headers, body limits, token-bucket rate
limits, API keys with per-key quotas, and opt-in proxy trust. Runtime-neutral (Node via
`@hono/node-server`, Bun, Deno, workers).

## Quickstart

Inside this workspace, or a product repository that pins `deps/scribbit`: add `"@bsh/edge": "workspace:*"` to `dependencies` and `edge` to `depends_on` in your `component.yaml`, plus `hono` itself. (Not yet published to npm.)

```ts
import { Hono } from 'hono';
import { bodyLimit, jsonErrorHandler, jsonErrors, rateLimit, requestId, securityHeaders } from '@bsh/edge';

const app = new Hono();
app.onError(jsonErrorHandler());
app.use(requestId());
app.use(jsonErrors());
app.use(securityHeaders());
app.use(rateLimit({ windowMs: 60_000, max: 60 }));
app.use(bodyLimit(64 * 1024));
app.get('/hello', (c) => c.json({ hello: 'world', requestId: c.get('requestId') }));

const res = await app.request('/hello');
console.log(res.status, res.headers.get('RateLimit-Remaining'), await res.json());
const missing = await app.request('/nope');
console.log(missing.status, await missing.json()); // 404 {"error":{"code":"not_found",...}}
```

Runs as is with `tsx` (Node 22); the comments show its output. `pnpm --filter @bsh/edge test` runs the full behaviour suite.

## Recommended stack

```ts
import { Hono } from 'hono';
import {
  requestId, jsonErrors, jsonErrorHandler, securityHeaders, corsAllowlist, trustProxy,
  rateLimit, bodyLimit, apiKeys,
} from '@bsh/edge';

const app = new Hono();
app.onError(jsonErrorHandler({ onUnexpected: (err, c) => log.error({ err, requestId: c.get('requestId') }) }));
app.use(requestId());                                    // first: everything else reports it
app.use(jsonErrors());                                   // uniform {error:{code,message,requestId}}
app.use(securityHeaders());
app.use(corsAllowlist(['https://app.example.com'], { credentials: true }));
app.use(trustProxy({ trusted: ['10.40.0.0/16'] }));      // ONLY if a proxy we run sits in front
app.use(rateLimit({ windowMs: 60_000, max: 300 }));      // per client IP
app.use(bodyLimit(64 * 1024));
app.use('/v1/*', apiKeys({ store, scopes: ['read'], environment: 'live' }));
app.use('/v1/*', rateLimit({ windowMs: 60_000, max: 60, key: 'apiKey', prefix: 'key', store: redisStore }));
```

## API

| Export | Behaviour |
|---|---|
| `requestId({ header?, trustIncoming?, generator? })` | UUID per request → `c.get('requestId')` + `X-Request-Id`. Incoming ids ignored unless `trustIncoming` (and then only `[A-Za-z0-9._:-]{8,128}`). |
| `jsonErrors({ onUnexpected? })` | Thrown errors and any non-JSON 4xx/5xx (incl. default 404) become `{"error":{"code","message","requestId"}}`. 5xx messages are never exposed. Other middleware's headers (CORS, Retry-After, WWW-Authenticate) are kept. |
| `jsonErrorHandler()`, `jsonNotFound()`, `EdgeError(status, code, message, headers?)` | `app.onError` / `app.notFound` equivalents; throw `EdgeError` for specific codes. |
| `corsAllowlist(origins, { credentials?, allowMethods?, allowHeaders?, exposeHeaders?, maxAge? })` | Default deny. Exact serialised-origin match (no suffix/regex matching). Disallowed preflight → 403, no CORS headers. `*` refused with credentials; `null` never allowed; malformed origins throw at startup. Always `Vary: Origin`. |
| `securityHeaders(opts?)` | API defaults: `CSP default-src 'none'; frame-ancestors 'none'`, HSTS 2y, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP, Permissions-Policy, `Cache-Control: no-store` (unless set). Strips `X-Powered-By`/`Server`. Each header overridable or `false`. |
| `bodyLimit(bytes)` | 413 on declared `Content-Length` > limit; chunked bodies are counted while streaming (and re-buffered for the handler); invalid `Content-Length` → 400. |
| `rateLimit({ windowMs, max, key?, store?, prefix?, cost?, headers? })` | Token bucket (burst `max`, refill `max/windowMs`). `key`: `'ip'` (default), `'apiKey'` (falls back to IP), or `(c) => string`. Emits `RateLimit-Policy/Limit/Remaining/Reset`; 429 adds `Retry-After`. |
| `RateLimitStore`, `InMemoryRateLimitStore({ maxKeys? })` | Port + bounded LRU in-memory adapter. |
| `apiKeys({ store, required?, scopes?, environment?, header? })` | `X-API-Key: bsh_live_…` or `Authorization: Bearer bsh_…`. Principal in `c.get('apiKey')`. 401 `missing_api_key` / `invalid_api_key` (unknown, revoked, expired look identical), 403 `insufficient_scope`, 429 `quota_exceeded` with `X-Quota-*` headers. |
| `generateApiKey(env)`, `hashApiKey`, `parseApiKey`, `timingSafeEqual`, `ApiKeyStore`, `InMemoryApiKeyStore` | `bsh_<live|test>_<base58(32 random bytes)>`; persist only the SHA-256 hex. |
| `trustProxy({ hops } \| { trusted })`, `getClientIp(c)` | Opt-in `X-Forwarded-For`. `hops: n` = n proxies we run; `trusted: CIDRs` = XFF only read when the TCP peer is trusted, walking right-to-left past trusted hops. Without it, XFF is ignored. |

## Security notes

- **X-Forwarded-For is attacker-controlled** unless a proxy you run overwrites/appends it. Never
  enable `trustProxy` on a service that is reachable directly; prefer `trusted` CIDRs over `hops`.
- API keys: 256-bit secrets, only SHA-256 hashes stored (fast hash is fine for high-entropy
  secrets), lookup by hash + constant-time compare, env prefix enforced (`environment: 'live'`
  refuses `bsh_test_` keys), prefix enables GitHub secret scanning. Show the key once; keep `hint`
  for UIs.
- In-memory stores are per process. Multi-instance services need shared stores: Redis rate limit =
  one Lua script (`HMGET tokens ts` → refill → decrement → `HSET` + `PEXPIRE time-to-full`); quotas
  = `INCR bsh:quota:<id>:<windowStart>` + `PEXPIRE windowMs`.
- CORS is not authentication: non-browser clients ignore it. Pair with `apiKeys` or sessions.
- `jsonErrors` hides 5xx messages and stack traces; log them via `onUnexpected` with the request id.

```bash
pnpm --filter @bsh/edge test
pnpm --filter @bsh/edge typecheck
```
