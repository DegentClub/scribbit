# scribbit-mcp runbook

Owner: team-scribbit. Service: `@bsh/scribbit-mcp` (products/scribbit/services/mcp). SLO: 99.9 % availability,
p95 300 ms per tool call (a 4 MiB `commit_address` is the slowest: one envelope build + hash).

## What it is

A stateless HTTP process (Hono on `@hono/node-server`, default port 3050) serving the MCP Streamable HTTP
endpoint at `POST /mcp` plus `/`, `/.well-known/agent.json`, `/.well-known/mcp.json`, `/healthz`, `/v1/keys/me`.
Pure compute over `@bsh/inscription` for the calculators; two upstreams: the fee oracle (`MCP_FEE_URL_<NETWORK>`:
the scribbit-fee-oracle server or mempool.space) and, when configured, the platform ledger (`MCP_LEDGER_URL` +
`MCP_LEDGER_API_KEY`) for the order tools. No database, no queue, no keys, no user funds: orders live in the
ledger, funds live in the agent's wallet. Losing the process loses nothing.

## Health

- `GET /healthz` → `{ "status": "ok", "orders": <ledger configured>, ... }` (liveness only; fee sources and the
  ledger are not probed).
- Ledger path: `tools/call get_order` with a known order id, or watch for `ledger_unavailable` / `ledger_rejected`
  results. `curl $MCP_LEDGER_URL/v1/health` tells whether the ledger itself is up (its own runbook:
  `platform/ledger/RUNBOOK.md`).
- Fee path: `POST /mcp` with `tools/call get_fees` and a valid key. `fees_unavailable` in the result means the
  oracle is down or misconfigured; quotes with an explicit `feeRate` keep working.
- Every response carries `X-Request-Id`; 5xx bodies are generic and the detail is logged as
  `{"msg":"unexpected error","where":...,"requestId":...}` on stderr.

```bash
curl -s https://mcp.scribb.it/healthz
curl -s https://mcp.scribb.it/v1/keys/me -H "Authorization: Bearer $KEY"
curl -s https://mcp.scribb.it/mcp -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_fees","arguments":{"network":"mainnet"}}}'
```

## Configuration

`env.schema.json` is the reference. Startup refuses: no keys unless `MCP_REQUIRE_API_KEY=false`, keys of the
wrong environment, plaintext keys in the key records, unknown networks, malformed numbers. The process exits 2
with the reason on stderr.

## API keys

Keys are minted offline and stored as SHA-256 hashes (secret path `services/scribbit-mcp/api-key-hashes`,
mounted as `MCP_API_KEYS_FILE`).

```bash
pnpm --filter @bsh/scribbit-mcp mint-key -- --env live --id partner-acme --owner acct_123 --scopes mcp
pnpm --filter @bsh/scribbit-mcp mint-key -- --env live --id agent-acme --owner acct_123 --scopes mcp:order   # may create orders
pnpm --filter @bsh/scribbit-mcp mint-key -- --env live --id watcher-acme --owner acct_123 --scopes mcp:settle  # may report funding, never create
# stderr: the key, once. stdout: the record {id, hash, env, scopes, ownerId} to append to the keys file.
```

- **Scopes**: `mcp` (read-only calculators, the 1.0 behaviour), `mcp:quote` (+ `get_order`, `get_receipt`),
  `mcp:order` (+ `create_order`, `report_funding`), `mcp:settle` (`report_funding` + reads, never `create_order`).
  `mint-key` and the config loader refuse `mcp:order` together with `mcp:settle` on one record; a store that
  hands such a key in anyway is answered 403 at the door. The scopes each tool accepts are on `GET /`
  (`mcp.toolScopes`) and in the agent card.
- **Ledger key** (`MCP_LEDGER_API_KEY`, secret path `services/scribbit-mcp/ledger-api-key`): a ledger key with
  scope `ledger` and `ownerId: scribbit`, minted on the ledger side. It is the only credential this service holds
  for another service; rotate it with the ledger's runbook and restart. It is never logged or returned.

- **Issue**: append the record, redeploy (the file is read at startup). Hand the key over out of band.
- **Revoke**: set `"revokedAt": <epoch ms>` on the record (or delete it), redeploy. `expiresAt` for
  time-boxed keys. Both fail as 401 `invalid_api_key`, indistinguishable from an unknown key.
- **Quota**: `"quota": { "limit": 1000, "windowMs": 86400000 }` per record → 429 `quota_exceeded` with
  `X-Quota-*` headers.
- **Leak**: revoke as above; keys are `bsh_live_`-prefixed so secret scanners find them.

## Rate limits, quotas and sizing

Per IP: `MCP_RATE_LIMIT_IP_PER_MIN` (600). Per key on `/mcp`: `MCP_RATE_LIMIT_KEY_PER_MIN` (120). Per-key quotas
(`quota: { limit, windowMs }` on the key record) count usage too.

**All three are per replica today.** Both token buckets and the quota counter live in process memory
(`InMemoryRateLimitStore`, `InMemoryApiKeyStore.incrementUsage`); nothing is shared between replicas and a restart
resets every counter. With N replicas behind a round-robin edge a key effectively gets N x its limit and N x its
quota, and a key that is revoked in the keys file stays valid on replicas that have not restarted. This is
acceptable for one replica or a sticky edge, and it is what the current deployment runs. **Production with more
than one replica must** (a) pass a shared `RateLimitStore` and an `ApiKeyStore` with a shared usage counter to
`createApp` (`@bsh/edge`'s README documents the Redis key shapes: `rl:<prefix>:<key>` token buckets and
`quota:<id>:<windowStart>` counters with TTL), and (b) treat the well-known and `GET /` routes as edge-cacheable so
the IP bucket is not spent on discovery. Until that lands, set the per-key limits as if divided by the replica
count, and revoke keys by redeploying every replica. No Redis is wired in this service on purpose (no new
dependencies); the ports exist so the store can be injected from `main.ts` when the infrastructure provides one. Memory: one 4 MiB request holds ~3 copies of the body transiently (JSON, base64 string, bytes); size
the container for `concurrency × 16 MiB` plus baseline. `MCP_MAX_BODY_BYTES` (8 MiB) bounds the request.

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| 401 on every call | wrong `MCP_API_KEY_ENV` for the keys in use, or the key file was not updated | `GET /` shows the accepted `keyPrefix`; check the keys file and redeploy |
| `fees_unavailable` / `fee_rate_required` | oracle URL down, `off`, or unset for the network | `curl $MCP_FEE_URL_MAINNET`; the fee oracle has its own runbook; agents can pass `feeRate` meanwhile |
| 413 on large content | body over `MCP_MAX_BODY_BYTES` | 8 MiB fits one 4 MiB body; do not raise beyond what the edge proxy allows |
| 429 storms from one key | agent loop | per-key bucket is doing its job; lower the key's quota or revoke |
| `too_large` results | content over the block lane (3,966,141 B with a parent) | expected; the message says how much to shrink |
| `forbidden_scope` results | the key lacks the tool's scope (e.g. a 1.0 `mcp` key calling `create_order`) | mint a key with the right scope; never add `mcp:settle` to an `mcp:order` key |
| `ledger_unavailable` results | `MCP_LEDGER_URL` unset, or the ledger is unreachable / timing out (15 s) | `curl $MCP_LEDGER_URL/v1/health`; calculators keep working meanwhile |
| `ledger_rejected` with `details.code` | the ledger refused: `invalid_api_key` (rotate `MCP_LEDGER_API_KEY`), `payee_required`, `payment_active`, `idempotency_conflict`, `not_observable` | the ledger's runbook; the agent sees the ledger's own code and message |
| `report_funding` stays `pending` | unconfirmed / RBF-signalling, or below the ledger's confirmation policy | expected; the agent reports again with `confirmations` once mined |
| 403 `insufficient_scope` on every call from one key | the record holds both `mcp:order` and `mcp:settle`, or no MCP scope | fix the record; startup would have refused it from the keys file |
| 405 on `GET /mcp` | client expects server push / sessions | expected: the server is stateless. Clients must POST and accept `application/json` |
| 406 on `POST /mcp` | client `Accept` lacks `text/event-stream` | MCP transport requirement; fix the client header |

## Deploy and rollback

No state, no migrations: roll the image forward or back freely. Config changes (keys, oracle URLs, ledger, limits)
need a restart. Verify with `/healthz`, `/.well-known/agent.json` (tool list = the registry), then a
`tools/call explain_lanes` (pure), a `get_fees` (oracle) and, with a ledger, a `get_order` on a known order.

## Local development

```bash
pnpm --filter @bsh/scribbit-mcp mint-key -- --env test --id dev > /tmp/dev-key.json   # key on stderr
MCP_API_KEY_ENV=test MCP_API_KEYS_JSON="[$(cat /tmp/dev-key.json)]" MCP_NETWORKS=mainnet,signet pnpm --filter @bsh/scribbit-mcp dev
# or, no auth at all (anonymous callers are unrestricted: every scope):
MCP_REQUIRE_API_KEY=false pnpm --filter @bsh/scribbit-mcp dev
# with a local ledger for the order tools (pnpm --filter @bsh/ledger dev, LEDGER_FAKE_PROVIDER=1 is NOT enough: psbt needs the psbt provider):
MCP_REQUIRE_API_KEY=false MCP_LEDGER_URL=http://localhost:3051 MCP_LEDGER_API_KEY=bsh_test_… pnpm --filter @bsh/scribbit-mcp dev
# stdio for Claude Desktop / Claude Code:
pnpm --filter @bsh/scribbit-mcp stdio
```
