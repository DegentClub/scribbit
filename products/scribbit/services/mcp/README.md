# @bsh/scribbit-mcp

**scribb.it: write to Bitcoin**, as an [MCP](https://modelcontextprotocol.io) server. It gives AI agents the
same exact maths the product uses (`@bsh/inscription`) and the same fee view (`@bsh/scribbit-fee-oracle`):
quote an inscription to the sat, derive the commit address, inspect the envelope, read the lane table, and
build a self-rescue transaction. It signs nothing, stores nothing and broadcasts nothing; the only network
access is the fee oracle, and only when one is configured.

Two ways to run it:

| Entry point | Transport | Auth | For |
|---|---|---|---|
| `src/main.ts` (`pnpm --filter @bsh/scribbit-mcp dev`) | Streamable HTTP at `POST /mcp` (Hono, `@hono/node-server`) | API key via `@bsh/edge` `apiKeys` (`Authorization: Bearer bsh_live_…`), rate limits, JSON errors | Hosted use: Claude's MCP connector, Claude Desktop / Claude Code remote servers, other products |
| `src/stdio.ts` (`bin/scribbit-mcp.mjs`) | stdio | none (same user, same machine) | Local use from Claude Desktop / Claude Code |

```bash
pnpm --filter @bsh/scribbit-mcp test        # vitest: tools over InMemoryTransport, HTTP auth, contract
pnpm --filter @bsh/scribbit-mcp typecheck
pnpm --filter @bsh/scribbit-mcp mint-key -- --env test --id dev --owner me   # prints the key once + the record to configure
MCP_API_KEY_ENV=test MCP_API_KEYS_JSON='[<record>]' pnpm --filter @bsh/scribbit-mcp dev   # :3050
```

## Connecting

**Claude Code (local, stdio):**

```bash
claude mcp add scribbit -- node /path/to/scribbit/products/scribbit/services/mcp/bin/scribbit-mcp.mjs
# offline (no fee oracle; quotes need feeRate):
claude mcp add scribbit -e MCP_FEE_URL_MAINNET=off -- node .../bin/scribbit-mcp.mjs
```

**Claude Code (hosted, Streamable HTTP):**

```bash
claude mcp add --transport http scribbit https://mcp.scribb.it/mcp --header "Authorization: Bearer bsh_live_…"
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{ "mcpServers": { "scribbit": { "command": "node", "args": ["/path/to/scribbit/products/scribbit/services/mcp/bin/scribbit-mcp.mjs"] } } }
```

**Claude API (MCP connector, beta `mcp-client-2025-11-20`)** — the hosted server, called server-side by Anthropic:

```ts
await client.beta.messages.create({
  model: 'claude-opus-5', max_tokens: 4096,
  betas: ['mcp-client-2025-11-20'],
  mcp_servers: [{ type: 'url', url: 'https://mcp.scribb.it/mcp', name: 'scribbit', authorization_token: process.env.SCRIBBIT_API_KEY }],
  tools: [{ type: 'mcp_toolset', mcp_server_name: 'scribbit' }],
  messages: [{ role: 'user', content: 'Quote a 1.2 MB webp inscription on mainnet at the normal tier.' }],
});
```

`GET /` on the hosted server is a discovery document (endpoint, auth scheme, tool/resource/prompt names).

## Tools

All tools are `readOnlyHint: true`, deterministic, and return the same object twice: as `structuredContent`
for programs and as pretty-printed JSON text (with a one-line summary) for models. Failures are results with
`isError: true` and `structuredContent.error = { code, message, details? }`; codes: `invalid_input`,
`content_too_large`, `content_hash_mismatch`, `too_large`, `invalid_psbt`, `fees_unavailable`,
`fee_rate_required`, `unsupported_network`, `internal`. Schema violations are reported by the SDK the same way.

Content is passed as `contentBase64` (exact bytes, at most **4 MiB decoded**, checked on the string length
before decoding) or `contentLength` (size-only maths; the envelope weight depends only on the length).
Optional `contentSha256` / `contentLength` alongside `contentBase64` are cross-checked, so an agent that
quotes in one step and commits in another cannot silently drift.

| Tool | Input | Output | Backed by |
|---|---|---|---|
| `get_fees` | `network?` | `FeesResponse` (`standard.slow/normal/fast`, `block.min/recommended`, `minFeeRate`, `stale`) | `FeeProvider.getFees()` |
| `quote_inscription` | `contentType`, `contentBase64 \| contentLength`, `parentId?`, `feeRate?`, `tier?`, `recipientAddress?`, `postage?`, `metadataBase64?`, `network?` | exact `reveal.{weight,vsize,lane}`, `rescue` layout facts (with a parent), `envelope.{scriptBytes,bodyChunks}`, `feeRate` + `feeSource`, `fees.{revealFee,postage,commitValue}`, `warnings` | `estimateRevealWeight`, `laneFor`, `quoteReveal` |
| `build_envelope` | content, `revealPubkey?` | `scriptBytes`, `overheadBytes`, `body.{chunks,fullChunks,lastChunkBytes}`, `parentTagHex`, `scriptSha256` (exact + real key only), `hexPreview.{head,tail}` | `buildInscriptionScript` |
| `commit_address` | `network`, `revealPubkey`, `contentType`, `contentBase64` (required), `contentSha256?`, `contentLength?`, `parentId?`, `metadataBase64?` | `address`, `scriptPubKey`, `tapLeafHash`, `controlBlock`, `internalKey` (NUMS), `leafScriptBytes`, `contentSha256` | `commitAddress` |
| `explain_lanes` | `feeRate?` (default 2) | lane table (max weight / vsize / body per lane, both layouts), the README size rows with real numbers, `parentCostWeight` (402) | `estimateRevealWeight` over the documented assumptions |
| `rescue_tx` | `halfSignedPsbtBase64`, `network?` | `hex`, `txid`, `inscriptionId`, `weight`, `vsize`, `lane` | `buildRescueReveal` (0x83 replay) |

Without a `feeRate`, `quote_inscription` reads the oracle: `standard.<tier>` for standard-lane reveals,
`block.recommended` for block-lane ones, and adds a warning when the reveal needs a Libre Relay / Slipstream
broadcaster or the fee data is stale. With no oracle configured for the network it fails with
`fee_rate_required` rather than guessing.

`rescue_tx` is the **0x83** path: the half-signed PSBT *is* the rescue transaction. The current
`@bsh/inscription` default (ADR-0005) signs **0x81** and pre-commits the parent return, so that PSBT cannot be
replayed; the tool refuses it with a message pointing at `buildResignedRescue`, which the user runs locally
with their ephemeral key. The PSBT is never echoed back in any result.

## Resources and prompts

| | Name | Content |
|---|---|---|
| resource | `scribbit://docs/lanes` | The lane table rendered as Markdown from `explain_lanes` (always current numbers) |
| resource | `scribbit://docs/security-model` | The "Security model" section of `@bsh/inscription`'s README, read from the installed package at first use (`_meta.source` says whether the README or the embedded summary was served) |
| prompt | `inscribe_this` (`contentType?`, `network?`, `parentId?`) | Walks an agent through fees → quote → commit → half-signed reveal (built in the user's environment) → rescue, and tells it never to ask for a private key |

## HTTP surface

Contract: [`contracts/openapi/scribbit-mcp.yaml`](../../../../contracts/openapi/scribbit-mcp.yaml)
(the MCP messages themselves are owned by the MCP specification).

| Route | Auth | |
|---|---|---|
| `POST /mcp` | key | JSON-RPC over Streamable HTTP, **stateless**: no `Mcp-Session-Id`, every request self-contained, answered as `application/json` |
| `GET /mcp`, `DELETE /mcp` | key | 405 (no server push, no sessions) |
| `GET /` | none | discovery document |
| `GET /healthz` | none | liveness |
| `GET /v1/keys/me` | key | the key's principal (`id`, `env`, `scopes`, `ownerId`), never the key or hash |

Edge stack (`@bsh/edge`): `requestId` → `jsonErrors` → `securityHeaders` → optional `corsAllowlist` →
optional `trustProxy` → per-IP `rateLimit` → `bodyLimit` (8 MiB default) → `apiKeys` (`mcp` scope, one key
environment) → per-key `rateLimit` on `/mcp`. Errors are the uniform `{ error: { code, message, requestId } }`.

## Security

- **Non-custodial.** No tool takes or returns a private key. `commit_address` needs only the x-only public
  key; the reveal is built and signed by the caller with `@bsh/inscription`. The prompt says so explicitly.
- **API keys** are 256-bit `bsh_<env>_…` secrets; the server holds SHA-256 hashes only (`MCP_API_KEYS_JSON`
  / `MCP_API_KEYS_FILE`; a record with a plaintext `key` is refused at startup). Unknown, revoked, expired and
  wrong-environment keys are indistinguishable (401 `invalid_api_key`). Per-key quotas and rate limits apply.
- **Nothing sensitive is echoed.** Half-signed PSBTs (broadcastable, RBF-able transactions) never appear in
  results or errors; unexpected exceptions become `internal` with a generic message and are logged with the
  request id only.
- **Bounded input.** 4 MiB decoded content (checked before decoding), 1 MiB metadata, 6 MiB PSBT, 8 MiB body.
  The SDK transport applies the same body cap independently.
- **Stateless by design.** No sessions to hijack or exhaust; horizontal scaling needs only shared rate-limit
  and quota stores (see `@bsh/edge` README for the Redis shapes).
- **Trust no proxy by default.** `X-Forwarded-For` is honoured only from `MCP_TRUSTED_PROXIES` CIDRs.

### OAuth 2.1 (planned, not implemented)

The MCP authorization spec makes the server an OAuth 2.1 *resource server*: it would publish
`/.well-known/oauth-protected-resource` (RFC 9728) naming Blockspace ID (`@bsh/identity`) as the authorization
server, answer 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, and validate bearer JWTs (RFC 9068,
`aud` = this server) in place of API keys. `apiKeys` already ignores non-`bsh_` bearer tokens, so the two can
coexist behind one `Authorization` header. Until then, API keys are the only credential.

## Configuration

See [`env.schema.json`](./env.schema.json). Minimal hosted setup:

```bash
MCP_API_KEY_ENV=live
MCP_API_KEYS_FILE=/run/secrets/scribbit-mcp-keys.json     # secret path services/scribbit-mcp/api-key-hashes
MCP_NETWORKS=mainnet,signet
MCP_FEE_URL_MAINNET=http://fee-oracle.internal:8080/v1/fees   # scribbit-fee-oracle; default is public mempool.space
MCP_PUBLIC_URL=https://mcp.scribb.it
MCP_TRUSTED_PROXIES=10.40.0.0/16
```

Operations: [`RUNBOOK.md`](./RUNBOOK.md).

## Layout

`src/tools.ts` (pure tool implementations) · `content.ts` (decoding, limits, validation) · `mcp.ts`
(`McpServer` registration: tools, resources, prompt) · `app.ts` (Hono + edge + transport) · `config.ts` ·
`fees.ts` (fee provider factory) · `docs.ts` (security-model resource) · `main.ts` / `stdio.ts` / `mint-key.ts`.

Tests: `test/tools.test.ts` (every tool over `InMemoryTransport`, asserted against `@bsh/inscription`
directly, including the README size table and lane boundaries), `app.test.ts` (auth, quotas, rate limits,
stateless JSON-RPC, body limits, headers), `contract.test.ts` (every HTTP body validated against the OpenAPI
schemas with Ajv), `resources.test.ts`, `config.test.ts`.
