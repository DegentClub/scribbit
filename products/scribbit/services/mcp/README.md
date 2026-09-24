# @bsh/scribbit-mcp

**scribb.it: write to Bitcoin**, as an [MCP](https://modelcontextprotocol.io) server. It gives AI agents the
same exact maths the product uses (`@bsh/inscription`) and the same fee view (`@bsh/scribbit-fee-oracle`):
quote an inscription to the sat, derive the commit address, inspect the envelope, read the lane table, and
finalize a legacy self-rescue transaction. Since 0.2 it is also a **counterparty an external agent can transact
with**: `create_order` turns a quote into an order on the platform ledger (`@bsh/ledger`) with a `psbt` payment
intent, the agent funds it from **its own wallet**, `report_funding` records what the chain shows, and
`get_receipt` closes the loop. It still signs nothing, stores nothing and broadcasts nothing; it never sees a
key or a PSBT. Its only upstreams are the fee oracle and the ledger, each only when configured.

Two ways to run it:

| Entry point | Transport | Auth | For |
|---|---|---|---|
| `src/main.ts` (`pnpm --filter @bsh/scribbit-mcp dev`) | Streamable HTTP at `POST /mcp` (Hono, `@hono/node-server`) | API key via `@bsh/edge` `apiKeys` (`Authorization: Bearer bsh_live_…`), per-tool scopes, rate limits, JSON errors | Hosted use: Claude's MCP connector, Claude Desktop / Claude Code remote servers, other products, external agents |
| `src/stdio.ts` (`bin/scribbit-mcp.mjs`) | stdio | none (same user, same machine; every scope) | Local use from Claude Desktop / Claude Code |

```bash
pnpm --filter @bsh/scribbit-mcp test        # vitest: tools over InMemoryTransport, scopes, fake ledger, HTTP auth, contract
pnpm --filter @bsh/scribbit-mcp typecheck
pnpm --filter @bsh/scribbit-mcp mint-key -- --env test --id dev --owner me --scopes mcp:order   # prints the key once + the record
MCP_API_KEY_ENV=test MCP_API_KEYS_JSON='[<record>]' pnpm --filter @bsh/scribbit-mcp dev   # :3050
```

## Connecting

**Claude Code (local, stdio):**

```bash
claude mcp add scribbit -- node /path/to/scribbit/products/scribbit/services/mcp/bin/scribbit-mcp.mjs
# offline (no fee oracle; quotes need feeRate):
claude mcp add scribbit -e MCP_FEE_URL_MAINNET=off -- node .../bin/scribbit-mcp.mjs
# with the order tools (the local caller holds every scope; guard the ledger key like any secret):
claude mcp add scribbit -e MCP_LEDGER_URL=http://ledger.internal:3050 -e MCP_LEDGER_API_KEY=bsh_live_… -- node .../bin/scribbit-mcp.mjs
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

`GET /` on the hosted server is a discovery document (endpoint, auth scheme and scopes, tool / resource / prompt
names with the scopes each tool needs); `GET /.well-known/agent.json` and `GET /.well-known/mcp.json` say the same
for agents that discover by convention (see [Agent card](#agent-card)). All three lists are derived from the tool
registry in `src/mcp.ts`, so they cannot drift from `tools/list`.

## Scopes

API keys carry scopes; every tool declares which ones may call it. A call from a key without one is an ordinary
tool result with `isError: true` and code `forbidden_scope` (never a transport error), so an agent can read the
`details.required` list and ask for the right key.

| Scope | What it allows | Who holds it |
|---|---|---|
| `mcp` | The six read-only calculators (`get_fees`, `quote_inscription`, `build_envelope`, `commit_address`, `explain_lanes`, `rescue_tx`). The 0.1 behaviour, unchanged | Existing keys; tooling that only computes |
| `mcp:quote` | Calculators + `get_order`, `get_receipt` | Dashboards, auditors, a product reading its own orders |
| `mcp:order` | `mcp:quote` + `create_order` + `report_funding` — the **proposing** side | The agent that buys: it creates the order, funds it from its own wallet, reports the transaction |
| `mcp:settle` | `mcp:quote` + `report_funding`, never `create_order` — the **settling** side | A watcher / settlement plane that confirms what the chain shows but may not open orders |

`mcp:order` and `mcp:settle` are **never issued to one key**: `mint-key` refuses the combination, the config loader
refuses such a record at startup with a clear error, and the HTTP door answers 403 `insufficient_scope` should a
store hand one in anyway. This mirrors the FlashyOS propose / settle split: the party that proposes an exchange is
not the party that attests it settled. Any MCP scope opens `/mcp` and `/v1/keys/me` (which reports `mcpScopes`);
the per-tool check happens inside the call. Anonymous callers (`MCP_REQUIRE_API_KEY=false`, local development) and
the stdio entry point are unrestricted.

## Tools

The six calculators are `readOnlyHint: true`, deterministic, and return the same object twice: as
`structuredContent` for programs and as pretty-printed JSON text (with a one-line summary) for models. The four
order tools talk to the ledger (`get_order` / `get_receipt` are reads; `create_order` / `report_funding` write to
the ledger but move no money). Failures are results with `isError: true` and `structuredContent.error = { code,
message, details? }`; codes: `invalid_input`, `content_too_large`, `content_hash_mismatch`, `too_large`,
`invalid_psbt`, `fees_unavailable`, `fee_rate_required`, `unsupported_network`, `forbidden_scope`,
`ledger_unavailable`, `ledger_rejected` (with the ledger's own `details.code`), `order_not_found`, `internal`.
Schema violations are reported by the SDK the same way.

Content is passed as `contentBase64` (exact bytes, at most **4 MiB decoded**, checked on the string length
before decoding) or `contentLength` (size-only maths; the envelope weight depends only on the length).
Optional `contentSha256` / `contentLength` alongside `contentBase64` are cross-checked, so an agent that
quotes in one step and commits in another cannot silently drift.

| Tool | Scope | Input | Output | Backed by |
|---|---|---|---|---|
| `get_fees` | any | `network?` | `FeesResponse` (`standard.slow/normal/fast`, `block.min/recommended`, `minFeeRate`, `stale`) | `FeeProvider.getFees()` |
| `quote_inscription` | any | `contentType`, `contentBase64 \| contentLength`, `parentId?`, `feeRate?`, `tier?`, `recipientAddress?`, `postage?`, `metadataBase64?`, `network?` | exact `reveal.{weight,vsize,lane}`, `rescue` layout facts (with a parent), `envelope.{scriptBytes,bodyChunks}`, `feeRate` + `feeSource`, `fees.{revealFee,postage,commitValue}`, `warnings` | `estimateRevealWeight`, `laneFor`, `quoteReveal` |
| `build_envelope` | any | content, `revealPubkey?` | `scriptBytes`, `overheadBytes`, `body.{chunks,fullChunks,lastChunkBytes}`, `parentTagHex`, `scriptSha256` (exact + real key only), `hexPreview.{head,tail}` | `buildInscriptionScript` |
| `commit_address` | any | `network`, `revealPubkey`, `contentType`, `contentBase64` (required), `contentSha256?`, `contentLength?`, `parentId?`, `metadataBase64?` | `address`, `scriptPubKey`, `tapLeafHash`, `controlBlock`, `internalKey` (NUMS), `leafScriptBytes`, `contentSha256` | `commitAddress` |
| `explain_lanes` | any | `feeRate?` (default 2) | lane table (max weight / vsize / body per lane, both layouts), the README size rows with real numbers, `parentCostWeight` (402) | `estimateRevealWeight` over the documented assumptions |
| `rescue_tx` | any | `halfSignedPsbtBase64`, `network?` | `hex`, `txid`, `inscriptionId`, `weight`, `vsize`, `lane` | `buildRescueReveal` (legacy 0x83 replay only) |
| `create_order` | `mcp:order` | `network?`, `contentType`, `contentSha256`, `contentLength`, `parentId?`, `recipientAddress`, `commitAddress`, `feeRate? \| tier?`, `postage?`, `mintPriceSats?`, `payees?: [{kind, ref, address, bps}]`, `idempotencyKey?` | `orderId`, `paymentId`, `status`, `quote` (as `quote_inscription`), `expectedOutputs: [{scriptHex, address?, valueSats, payee}]`, `commitValueSats`, `payeeSats`, `totalSats`, `lineItems`, `expiresAt`, `quoteExpiresAt`, `warnings`, `next` | ledger `POST /v1/orders` + `POST /v1/orders/{id}/payments` (`psbt`) |
| `get_order` | `mcp:quote` `mcp:order` `mcp:settle` | `orderId` | `status.{order,payment}`, `order` (line items, metadata), `payment` (current intent: status, amounts, txid, expected outputs), `payments`, `payouts` | ledger `GET /v1/orders/{id}`, `/payments`, `/payouts` |
| `report_funding` | `mcp:order` `mcp:settle` | `orderId`, `paymentId?`, `txid`, `outputs[{scriptHex,valueSats}]` (every output, vout order), `confirmations?`, `rbfSignalled?` | `applied`, `reason`, `status.{order,payment}`, `amountPaidSats`, `expectedOutputs`, `settlements`, `payouts`, `next` | ledger `POST /v1/payments/{id}/observations` |
| `get_receipt` | `mcp:quote` `mcp:order` `mcp:settle` | `orderId` | `receipt` (JSON: line items, payments, payouts, totals) and `text` (the plain-text receipt, also as the result text) | ledger `GET /v1/orders/{id}/receipt` |

Without a `feeRate`, `quote_inscription` (and `create_order`) read the oracle: `standard.<tier>` for
standard-lane reveals, `block.recommended` for block-lane ones, and add a warning when the reveal needs a Libre
Relay / Slipstream broadcaster or the fee data is stale. With no oracle configured for the network they fail with
`fee_rate_required` rather than guessing.

`rescue_tx` is the **legacy 0x83** path (`sighash: 'single_anyonecanpay'`): there the half-signed PSBT *is* the
rescue transaction. The current `@bsh/inscription` default (ADR-0005) signs **0x81** (`SIGHASH_ALL |
ANYONECANPAY`) and pre-commits the parent return, so that PSBT is not broadcastable on its own and the tool
refuses it with a message pointing at `buildResignedRescue`: a fresh `[commit] -> [child]` transaction the user
re-signs locally with the ephemeral key `K_e` from their recovery bundle. The PSBT is never echoed back in any
result.

## Ordering and paying

`create_order` is the bridge between the calculator and the ledger. The sequence, with who does what:

```
agent / wallet                       scribbit-mcp                                 ledger (@bsh/ledger)
──────────────                       ────────────                                 ────────────────────
get_fees, quote_inscription ───────▶ exact weight / fee / commitValue
generate K_e locally
commit_address(pubkey, bytes) ─────▶ P2TR commit address for these bytes
create_order(sha256, length,
  recipient, commitAddress,
  payees[{kind,ref,address,bps}],
  mintPriceSats, feeRate|tier) ────▶ quote again (size-only)
                                     line items:
                                       network-cost = commitValue → payee platform/commit @ commitAddress
                                       share:<kind>:<ref> = floor(mintPriceSats × bps / 10000) → payee
                                     POST /v1/orders {product: scribbit, customerRef: recipient,
                                       metadata: {contentSha256, network, quoteExpiresAt, ...}} ─────────▶ order (created)
                                     POST /v1/orders/{id}/payments {method: psbt} ─────────────────────▶ intent (created), order → awaiting_payment
                                     ◀──────────────────────────────── checkout.outputs: one per payee SCRIPT, values summed
◀──── {orderId, paymentId, expectedOutputs[{scriptHex, valueSats, payee}], commitValueSats, totalSats, expiresAt}
build the funding PSBT in the
  agent's own wallet: one output
  per expectedOutput, exactly;
  sign; broadcast (outside)
report_funding(orderId, txid,
  every output, confirmations) ────▶ POST /v1/payments/{id}/observations ────────────────────────────▶ evaluate by script:
                                                                                                        pending | paid | overpaid | underpaid
                                     ◀──────────────────────────────── payment, order, applied, payouts (once paid)
◀──── {status, applied, payouts, next}
build the half-signed 0x81 reveal
  (buildHalfSignedReveal, K_e) and
  hand it to the mint service (outside)
get_receipt(orderId) ──────────────▶ GET /v1/orders/{id}/receipt ─────────────────────────────────────▶ receipt JSON + text
```

Facts that matter:

- **The commit output is a payee line item.** The ledger's `psbt` method needs a payee on every line item (it
  matches the funding transaction's outputs by script), so the network cost is a line item paid to the agent's own
  commit address as payee `platform/commit`, exactly as the degent Open Studio does it. That is why `create_order`
  takes `commitAddress` (derive it with `commit_address` first; it must be P2TR). The ledger then verifies the
  whole funding transaction: commit output plus every payee output. Two payees at one address become one expected
  output (values summed); `platform/commit` is reserved.
- **Payee shares** are `floor(mintPriceSats × bps / 10000)` sats; `bps` of all payees may not exceed 10000; a share
  that rounds to 0 is refused; a share under 546 sats is warned about (wallets treat it as dust). Only the shares
  are charged - the platform takes nothing here.
- **Money never touches the server.** `expectedOutputs` is a list of scripts and values. The agent's wallet builds
  and signs the funding transaction with its own inputs and change; the server never accepts, builds, signs or
  broadcasts a PSBT. Payouts are the ledger's *records* of money the agent's transaction sent to payees.
- **Pending / paid / underpaid** follow the ledger's psbt policy: nothing is credited while the transaction is
  unconfirmed and RBF-signalling or below the confirmation policy (report again with `confirmations`); `paid` when
  every expected output is present at or above its value; `underpaid` names what is short (a second transaction
  carrying every output settles it). One transaction settles at most one intent; reporting the same one twice is
  harmless (`applied: false`).
- **Idempotency.** Pass `idempotencyKey` on `create_order` and a retried call returns the same order and payment.
  The order's metadata carries `contentSha256`, `network`, `commitAddress`, `quoteExpiresAt` (10 minutes,
  informational: the server is stateless) so the mint service can check the reveal against what was ordered.
- **Half of the loop is outside this server today**: broadcasting the funding transaction and submitting the
  half-signed reveal to the mint service. See the walkthrough below.

## Agent card

Agents that discover by convention get two unauthenticated, cacheable (`Cache-Control: public, max-age=300`)
documents, both contract-fixed in `contracts/openapi/scribbit-mcp.yaml`:

- `GET /.well-known/agent.json` - an A2A-style agent card: `name`, `description`, `url` (the MCP endpoint),
  `provider: { organization: "Blockspace Holdings", url }`, `version`, `capabilities: { streaming: false, … }`,
  `securitySchemes` (bearer API key), and `skills` = the tool list, each with `id` (tool name), `name`,
  `description`, `scopes` and `tags` (`scope:mcp:order`, `read-only` / `ledger-write`). `x-flashyos` links the
  FlashyOS documents served beside it by the site (`/.well-known/flashyos-charter.json`,
  `/.well-known/frontdoor.json`, see `platform/mesh`); `x-mcp` points at the endpoint and the manifest;
  `x-scribbit` lists networks, resources, prompts and whether orders are enabled.
- `GET /.well-known/mcp.json` - the MCP manifest: `transport: streamable-http`, `endpoint`, `protocolVersions`,
  `stateless: true`, `auth` (scheme, headers, key prefix, every scope), `tools` with scopes and `readOnly`,
  resources, prompts, and the agent card's URL.

Both are built from the same registry as `tools/list`; the tests assert the three agree.

## External agent walkthrough

What a FlashyOS-style agent (or any agent with a Bitcoin wallet) does to inscribe through scribb.it end to end.
Steps 5 and 8 happen **outside this server** today: the agent broadcasts the funding transaction itself and hands
the half-signed reveal to the scribb.it mint service (`@bsh/scribbit-mint-api` / the product's mint flow); this
server records and quotes, it does not relay. Every call is `POST /mcp` with `Authorization: Bearer <key>` and
`Accept: application/json, text/event-stream`.

1. **Discover.** `GET /.well-known/agent.json`: confirm `provider.organization`, read `skills` and the scopes.
   Obtain an API key with `mcp:order` (operator-issued; see the runbook). `GET /v1/keys/me` echoes `mcpScopes`.
2. **See the market.** `tools/call get_fees { network }`; optionally read `scribbit://docs/lanes`.
3. **Quote.** `tools/call quote_inscription { contentType, contentBase64 | contentLength, parentId?, tier | feeRate }`
   → `reveal.lane`, `fees.commitValue`. A `block` lane needs a Libre Relay / Slipstream broadcaster later.
4. **Commit address.** Generate an ephemeral reveal key `K_e` in the agent's environment (never send it
   anywhere). `tools/call commit_address { network, revealPubkey, contentType, contentBase64, contentSha256, parentId? }`
   → `address`, `contentSha256`. Keep `K_e`, the bytes, `parentId`, recipient and postage in a recovery bundle.
5. **Order.** `tools/call create_order { network, contentType, contentSha256, contentLength, parentId?, recipientAddress, commitAddress, feeRate | tier, mintPriceSats?, payees?, idempotencyKey }`
   → `orderId`, `paymentId`, `expectedOutputs`, `commitValueSats`, `totalSats`, `expiresAt`.
6. **Fund (outside).** In the agent's wallet build a transaction with exactly one output per `expectedOutputs`
   entry (`scriptHex`, `valueSats`), its own inputs and change; sign; broadcast before `expiresAt`. Note the txid
   and the vout of the commit output.
7. **Report.** `tools/call report_funding { orderId, txid, outputs: [every output], confirmations: 0 }` → `pending`;
   once mined, call again with `confirmations` → `paid`, `payouts` listed (one per payee output). `underpaid` says
   what is missing. `get_order` shows the same state at any time.
8. **Reveal (outside).** Build the half-signed 0x81 reveal with `@bsh/inscription`
   `buildHalfSignedReveal({ network, revealPrivkey: K_e, content, commitOutpoint: { txid, vout }, commitValue, recipientAddress, postage, parentReturnAddress, parentValue })`
   and hand it only to the scribb.it mint service, which attaches the parent input and broadcasts. The order's
   metadata (`contentSha256`, `commitAddress`) is what the mint service checks it against.
9. **Receipt.** `tools/call get_receipt { orderId }` → the ledger receipt as JSON and text (line items, the payment,
   the payouts with `txid:vout`).
10. **Fallback.** If the service never reveals, the commit output is still the agent's: re-sign a fresh
    `[commit] -> [child]` with `buildResignedRescue` and `K_e` locally and broadcast it (no parent provenance).
    `rescue_tx` applies only to legacy 0x83 PSBTs.

Caveats, stated plainly: the server does not watch the chain for you (report what you see; the ledger may also
have its own esplora poller), does not broadcast, does not relay the reveal, and does not refund - refunds of a
`psbt` payment are operator payouts on the ledger side. The proposing key (`mcp:order`) and any settling key
(`mcp:settle`) must be different keys.

## Resources and prompts

| | Name | Content |
|---|---|---|
| resource | `scribbit://docs/lanes` | The lane table rendered as Markdown from `explain_lanes` (always current numbers) |
| resource | `scribbit://docs/security-model` | The "Security model" section of `@bsh/inscription`'s README (0x81 default, pre-committed parent return, re-signed rescue with `K_e`, the legacy 0x83 limitations), read from the installed package at first use (`_meta.source` says whether the README or the embedded summary was served) |
| prompt | `inscribe_this` (`contentType?`, `network?`, `parentId?`) | Walks an agent through fees → quote → commit → `create_order` → funding PSBT in the user's own wallet → `report_funding` → half-signed reveal to the mint service → `get_receipt` → the re-signed rescue, and tells it never to ask for a private key or send a PSBT to this server |

## HTTP surface

Contract: [`contracts/openapi/scribbit-mcp.yaml`](../../../../contracts/openapi/scribbit-mcp.yaml)
(the MCP messages themselves are owned by the MCP specification).

| Route | Auth | |
|---|---|---|
| `POST /mcp` | key (any MCP scope) | JSON-RPC over Streamable HTTP, **stateless**: no `Mcp-Session-Id`, every request self-contained, answered as `application/json`; tools then check their own scope |
| `GET /mcp`, `DELETE /mcp` | key | 405 (no server push, no sessions) |
| `GET /` | none | discovery document (tools with scopes, well-known links; derived from the registry) |
| `GET /.well-known/agent.json` | none | agent card, cacheable |
| `GET /.well-known/mcp.json` | none | MCP manifest, cacheable |
| `GET /healthz` | none | liveness (`orders: true` when a ledger is configured) |
| `GET /v1/keys/me` | key | the key's principal (`id`, `env`, `scopes`, `mcpScopes`, `ownerId`), never the key or hash |

Edge stack (`@bsh/edge`): `requestId` → `jsonErrors` → `securityHeaders` → optional `corsAllowlist` →
optional `trustProxy` → per-IP `rateLimit` → `bodyLimit` (8 MiB default) → `apiKeys` (one key environment) →
scope gate (any MCP scope; `mcp:order` + `mcp:settle` together is 403) → per-key `rateLimit` on `/mcp`. Errors
are the uniform `{ error: { code, message, requestId } }`.

## Security

- **Non-custodial, still.** No tool takes or returns a private key or a PSBT to keep. `commit_address` needs
  only the x-only public key; `create_order` needs only addresses and returns scripts and values; the funding
  transaction and the reveal are built and signed by the caller with their wallet and `@bsh/inscription`. The
  ledger records what the chain shows (ADR-0009); payouts are facts, not transfers. The prompt says so explicitly.
- **Scopes split proposing from settling.** See [Scopes](#scopes). The refusal is enforced three times (mint,
  load, door) so a mis-issued key cannot exist quietly.
- **API keys** are 256-bit `bsh_<env>_…` secrets; the server holds SHA-256 hashes only (`MCP_API_KEYS_JSON`
  / `MCP_API_KEYS_FILE`; a record with a plaintext `key` is refused at startup). Unknown, revoked, expired and
  wrong-environment keys are indistinguishable (401 `invalid_api_key`). Per-key quotas and rate limits apply.
  The ledger key (`MCP_LEDGER_API_KEY`) is sent to the ledger only and never logged or returned.
- **Nothing sensitive is echoed.** Half-signed PSBTs (broadcastable, RBF-able transactions) never appear in
  results or errors; ledger errors are relayed as their stable code and message only; unexpected exceptions
  become `internal` with a generic message and are logged with the request id only.
- **Bounded input.** 4 MiB decoded content (checked before decoding), 1 MiB metadata, 6 MiB PSBT, 8 MiB body,
  20 payees, 1000 reported outputs. The SDK transport applies the same body cap independently.
- **Stateless by design.** No sessions to hijack or exhaust; orders live in the ledger. Horizontal scaling needs
  only shared rate-limit and quota stores (per replica today; see the runbook).
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
MCP_LEDGER_URL=http://ledger.internal:3050                    # enables the order tools
MCP_LEDGER_API_KEY=bsh_live_…                                 # secret path services/scribbit-mcp/ledger-api-key
MCP_PUBLIC_URL=https://mcp.scribb.it
MCP_TRUSTED_PROXIES=10.40.0.0/16
```

Operations: [`RUNBOOK.md`](./RUNBOOK.md).

## Layout

`src/tools.ts` (pure calculator implementations) · `orders.ts` (order tools over the ledger client) ·
`ledger-client.ts` (typed client for `contracts/openapi/ledger.yaml`, injectable fetch) · `scopes.ts` (the scope
model) · `content.ts` (decoding, limits, validation) · `mcp.ts` (the `TOOLS` / `RESOURCES` / `PROMPTS` registry,
`McpServer` registration, instructions, prompt) · `app.ts` (Hono + edge + transport, discovery, agent card,
manifest) · `config.ts` · `fees.ts` (fee provider factory) · `docs.ts` (security-model resource) · `main.ts` /
`stdio.ts` / `mint-key.ts`.

Tests: `test/tools.test.ts` (every calculator over `InMemoryTransport`, asserted against `@bsh/inscription`
directly, including the README size table and lane boundaries), `orders.test.ts` (the four order tools against
`test/fake-ledger.ts`, an in-memory ledger that validates every body it returns against `ledger.yaml`),
`scopes.test.ts` (the scope model, the per-tool matrix over the protocol, key loading, the HTTP door),
`app.test.ts` (auth, quotas, rate limits, stateless JSON-RPC, body limits, headers, discovery derived from the
registry, well-known routes), `contract.test.ts` (every HTTP body validated against the OpenAPI schemas with
Ajv, including the agent card and manifest), `resources.test.ts` (resources, prompt, 0x81 wording),
`config.test.ts`.
