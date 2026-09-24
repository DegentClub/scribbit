# scribbit-mint-api runbook

Owner: team-scribbit. Service: `@bsh/scribbit-mint-api` (products/scribbit/services/mint-api). SLO: 99.9 %
availability, p95 500 ms (a compose with a multi-megabyte description is the slowest call; it is bounded by
the Counterparty node, not by this process).

## What it is

A stateless HTTP process (Hono on `@hono/node-server`, default port 3060) that the scribb.it mint pages call
for everything that needs a server: a fee snapshot, payment UTXOs, transaction lookups, broadcasts, and an
allowlisted Counterparty v2 proxy for the counters page. **It never sees a key** and never holds an unsigned
transaction it could alter. Losing the process loses nothing: the browser keeps every pending mint in
`localStorage` and the reveal can be re-signed against any Esplora.

Upstreams: one Esplora/mempool backend (`ESPLORA_URL`), optionally one Counterparty Core v2 node
(`CP_API_URL`), and a fee source (`FEE_URL`, default public mempool.space).

## Health

- `GET /healthz` → `{ status: "ok", network, counterparty: bool, fees: bool }` (liveness; upstreams not probed).
- `GET /api/fees` → 200 means the fee source answers; 503 `fees_unavailable` means every source failed
  (the page still lets the user type a rate).
- `GET /api/cp/blocks/last` → 200 means the Counterparty node answers; 503 `cp_unavailable` means none is
  configured; 502/504 means it is configured and down.
- Every response carries `X-Request-Id`; unexpected 5xx are logged as
  `{"msg":"unexpected error","where":...,"requestId":...}` on stderr with a generic body to the client.

```bash
curl -s https://api.scribb.it/healthz
curl -s https://api.scribb.it/api/fees
curl -s https://api.scribb.it/api/esplora/tx/<txid>
curl -s https://api.scribb.it/api/cp/blocks/last
```

## Configuration

`env.schema.json` is the reference. Startup refuses an unknown network, a non-http(s) URL, a malformed
number, and regtest without `ESPLORA_URL` (exit 2, reason on stderr). `CORS_ORIGINS` must list the exact
origins of the mint front end or every browser call is refused by CORS (non-browser callers are unaffected).

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| Page shows "fees unavailable", API answers 503 on `/api/fees` | fee source down or wrong `FEE_URL` | check the URL; point `FEE_URL` at the scribbit fee server or another mempool instance; users can still type a rate |
| UTXO/broadcast calls answer 502 `upstream_error` | Esplora down or rate-limiting us | switch `ESPLORA_URL` to the self-hosted backend; check its rate limits |
| 504 `upstream_timeout` on composes | Counterparty node slow on a large description | raise `UPSTREAM_TIMEOUT_MS` (default 20 s) or move to a closer node |
| 403 `cp_not_allowed` for a path the page needs | allowlist drift | extend `src/cp-allowlist.ts` **and** the contract; never widen to `*` |
| 429 storms from one IP behind a shared NAT | per-IP buckets | raise `RATE_LIMIT_IP_PER_MIN`; if behind our own proxy set `TRUSTED_PROXIES` so the real client IP is used |
| 413 on composes | description over `MAX_COMPOSE_BYTES` | the page refuses files over 4 MiB already; raise only with the node's own limit in mind |

Rate limit buckets are in-process: with more than one replica, limits are per replica (pass a shared
`RateLimitStore` to `createApp` for exact global limits; Redis shapes are in the `@bsh/edge` README).

## Deploy

`pnpm --filter @bsh/scribbit-mint-api start` with the environment from `env.schema.json`. No migrations,
no warm-up. Roll by replacing the process; in-flight composes fail with a network error and the page retries
on the user's click.
