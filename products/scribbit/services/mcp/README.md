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

## Quickstart

Connect it to Claude Code from a checkout (stdio, offline: quotes then need a `feeRate`):

```bash
pnpm install
claude mcp add scribbit -e MCP_FEE_URL_MAINNET=off -- node "$PWD/products/scribbit/services/mcp/bin/scribbit-mcp.mjs"
```

Or drive it in-process with the MCP SDK (this is how the tests run it):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createScribbitMcpServer } from '@bsh/scribbit-mcp';

// The same server the stdio and HTTP entry points expose, driven in-process (no fee oracle: pass feeRate).
const server = createScribbitMcpServer();
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: 'quickstart', version: '1.0.0' });
await client.connect(clientT);

console.log((await client.listTools()).tools.map((t) => t.name)); // [ 'get_fees', 'quote_inscription', ... ]
const r = await client.callTool({
  name: 'quote_inscription',
  arguments: { contentType: 'text/plain', contentLength: 19, feeRate: 2, network: 'signet' },
});
console.log((r.structuredContent as { fees: { commitValue: number } }).fees.commitValue); // 824 (sats)
await client.close();
```

Runs as is with `tsx` (Node 22); the comments show its output.

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
| `playground_explain_step` | `step` (1-5 or `wallet` \| `coins` \| `file` \| `inscribe` \| `certificate`) | `title`, `summary`, `explanation[]`, `onChain`, `safety`, `glossary[{id,term,definition}]`, `goalSeconds`, `steps` | `@bsh/scribbit-playground-kit` (the text the Signet Playground page shows) |
| `ask_blockspace` | `question`, `level?`, `includeLiveFacts?`, `network?` | `answer`, `citations[{sourceId,type,title,url,score}]`, `groundedness`, `groundednessNote`, `refused` + `refusalReason?`, `liveFacts?`, `model` | `@bsh/blockspace-tutor-kb` (retrieval + guardrails; extractive/offline by default). Refuses price/keys/mainnet-signing; never fabricates a citation. |

Without a `feeRate`, `quote_inscription` reads the oracle: `standard.<tier>` for standard-lane reveals,
`block.recommended` for block-lane ones, and adds a warning when the reveal needs a Libre Relay / Slipstream
broadcaster or the fee data is stale. With no oracle configured for the network it fails with
`fee_rate_required` rather than guessing.

`rescue_tx` is the **0x83** path: the half-signed PSBT *is* the rescue transaction. The current
`@bsh/inscription` default (ADR-0005) signs **0x81** and pre-commits the parent return, so that PSBT cannot be
replayed; the tool refuses it with a message pointing at `buildResignedRescue`, which the user runs locally
with their ephemeral key. The PSBT is never echoed back in any result.

### Why there is no faucet tool

The Signet Playground (ADR-0009) has a signet faucet, but this server deliberately exposes **no**
`signet_faucet_challenge` / `signet_faucet_drip`. The faucet's budget is shared and small, its limits are per
address and per IP, and its proof of work is meant to cost the *learner's* browser a few seconds. An agent
calling it would spend that shared budget on someone's behalf, from one server IP, and turn a speed bump into a
loop. Agents explain (`playground_explain_step`) and quote (`quote_inscription` with `network: "signet"`); the
person gets coins from the page.

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

## Listing

[`server.json`](./server.json) is the listing for the official [MCP Registry](https://registry.modelcontextprotocol.io),
written against the registry schema `2025-12-11` (vendored in `test/fixtures/` for the test). It describes the
stdio server as the npm package `@bsh/scribbit-mcp` (`npx`) and the hosted server as a Streamable HTTP remote at
`https://mcp.scribb.it/mcp` with a secret `Authorization` header. The tool, resource and prompt names ride in
`_meta["io.modelcontextprotocol.registry/publisher-provided"]` (the only `_meta` key the registry keeps).
`test/registry.test.ts` validates it against the schema and fails when its version, `mcpName`, or tool,
resource or prompt lists drift from `package.json` and from what `createScribbitMcpServer()` registers.

Submission (not done yet):

1. Publish the npm package first: remove `"private": true`, give it a build or keep the `tsx` loader in `bin/`,
   and `npm publish --access public` with provenance. The registry verifies npm ownership by reading
   `mcpName` from the published `package.json`, which must equal `server.json` `name`.
2. Install the publisher CLI: `brew install mcp-publisher`, or the release binary from
   `https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_<os>_<arch>.tar.gz`.
3. Authenticate with the GitHub namespace. In CI (recommended): a workflow with `permissions: id-token: write`
   runs `mcp-publisher login github-oidc`; the registry grants `io.github.<repository owner>/*`. Locally:
   `mcp-publisher login github` (device flow); publishing under an organisation namespace requires an **Owner**
   of the organisation.
4. From this directory: `mcp-publisher publish` (it reads `./server.json`). Check with
   `curl "https://registry.modelcontextprotocol.io/v0/servers?search=scribbit-mcp"`.
5. Every release bumps `version` in `package.json`, `SERVER_VERSION` and `server.json` together (the test
   enforces it) and republishes; registry versions are immutable.

**Check against the live schema and registry before submitting** (the registry is in preview and changes):

| Field | Why |
|---|---|
| `$schema` | Must be a schema version the registry still accepts; `2025-12-11` was current when written. |
| `packages[0].identifier` / `version` | `@bsh/scribbit-mcp` is not on npm yet; the scope may change with the `@blockspace` rename. `mcpName` must be in the *published* `package.json`. |
| `remotes[0].url` | `https://mcp.scribb.it/mcp` must be live and reachable before listing it. |
| `repository` | Optionally add `id` (`gh api repos/DegentClub/scribbit --jq .id`) to guard against repository resurrection. |
| `description` | At most 100 characters (tested). |

## Configuration

See [`env.schema.json`](./env.schema.json). Minimal hosted setup:

```bash
MCP_API_KEY_ENV=live
MCP_API_KEYS_FILE=/run/secrets/scribbit-mcp-keys.json     # secret path services/scribbit-mcp/api-key-hashes
MCP_NETWORKS=mainnet,signet
MCP_FEE_URL_MAINNET=http://fee-oracle.internal:8080/v1/fees   # scribbit-fee-oracle; default is public mempool.space
MCP_PUBLIC_URL=https://mcp.scribb.it
MCP_TRUSTED_PROXIES=10.0.0.0/8
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
