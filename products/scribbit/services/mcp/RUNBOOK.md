# scribbit-mcp runbook

Owner: team-scribbit. Service: `@bsh/scribbit-mcp` (products/scribbit/services/mcp). SLO: 99.9 % availability,
p95 300 ms per tool call (a 4 MiB `commit_address` is the slowest: one envelope build + hash).

## What it is

A stateless HTTP process (Hono on `@hono/node-server`, default port 3050) serving the MCP Streamable HTTP
endpoint at `POST /mcp` plus `/`, `/healthz`, `/v1/keys/me`. Pure compute over `@bsh/inscription`; the only
upstream is the fee oracle (`MCP_FEE_URL_<NETWORK>`: the scribbit-fee-oracle server or mempool.space). No
database, no queue, no keys, no user funds. Losing the process loses nothing.

## Health

- `GET /healthz` → `{ "status": "ok", ... }` (liveness only; fee sources are not probed).
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
# stderr: the key, once. stdout: the record {id, hash, env, scopes, ownerId} to append to the keys file.
```

- **Issue**: append the record, redeploy (the file is read at startup). Hand the key over out of band.
- **Revoke**: set `"revokedAt": <epoch ms>` on the record (or delete it), redeploy. `expiresAt` for
  time-boxed keys. Both fail as 401 `invalid_api_key`, indistinguishable from an unknown key.
- **Quota**: `"quota": { "limit": 1000, "windowMs": 86400000 }` per record → 429 `quota_exceeded` with
  `X-Quota-*` headers.
- **Leak**: revoke as above; keys are `bsh_live_`-prefixed so secret scanners find them.

## Rate limits and sizing

Per IP: `MCP_RATE_LIMIT_IP_PER_MIN` (600). Per key on `/mcp`: `MCP_RATE_LIMIT_KEY_PER_MIN` (120). Both are
in-process token buckets: with more than one replica, limits are per replica (pass a shared
`RateLimitStore` / `ApiKeyStore` to `createApp` for exact global limits; Redis shapes are in the `@bsh/edge`
README). Memory: one 4 MiB request holds ~3 copies of the body transiently (JSON, base64 string, bytes); size
the container for `concurrency × 16 MiB` plus baseline. `MCP_MAX_BODY_BYTES` (8 MiB) bounds the request.

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| 401 on every call | wrong `MCP_API_KEY_ENV` for the keys in use, or the key file was not updated | `GET /` shows the accepted `keyPrefix`; check the keys file and redeploy |
| `fees_unavailable` / `fee_rate_required` | oracle URL down, `off`, or unset for the network | `curl $MCP_FEE_URL_MAINNET`; the fee oracle has its own runbook; agents can pass `feeRate` meanwhile |
| 413 on large content | body over `MCP_MAX_BODY_BYTES` | 8 MiB fits one 4 MiB body; do not raise beyond what the edge proxy allows |
| 429 storms from one key | agent loop | per-key bucket is doing its job; lower the key's quota or revoke |
| `too_large` results | content over the block lane (3,966,141 B with a parent) | expected; the message says how much to shrink |
| 405 on `GET /mcp` | client expects server push / sessions | expected: the server is stateless. Clients must POST and accept `application/json` |
| 406 on `POST /mcp` | client `Accept` lacks `text/event-stream` | MCP transport requirement; fix the client header |

## Deploy and rollback

No state, no migrations: roll the image forward or back freely. Config changes (keys, oracle URLs, limits)
need a restart. Verify with `/healthz`, then a `tools/call explain_lanes` (pure) and a `get_fees` (oracle).

## Local development

```bash
pnpm --filter @bsh/scribbit-mcp mint-key -- --env test --id dev > /tmp/dev-key.json   # key on stderr
MCP_API_KEY_ENV=test MCP_API_KEYS_JSON="[$(cat /tmp/dev-key.json)]" MCP_NETWORKS=mainnet,signet pnpm --filter @bsh/scribbit-mcp dev
# or, no auth at all:
MCP_REQUIRE_API_KEY=false pnpm --filter @bsh/scribbit-mcp dev
# stdio for Claude Desktop / Claude Code:
pnpm --filter @bsh/scribbit-mcp stdio
```
