# scribb.it: write

**scribb.it** is the writing product: the place to put data on Bitcoin, from one inscription to a whole collection,
with exact costs up front and no custody of user keys. It is the engine that degent.club's mint pattern
(ADR-0002) generalises into.

## Vision

- **Inscribe anything that fits**: standard and block-sized inscriptions, parent/child provenance, batches.
- **Never hold user keys**: browser-side ephemeral keys and `SIGHASH_SINGLE|ANYONECANPAY` reveals with
  self-rescue, as proven in the degent.club mint.
- **Show exactly what lands**: the same `@bsh/inscription` code quotes in the browser and builds on the server.
- **Serve builders and agents**: a public API and an MCP server, so other products and AI agents can inscribe.

## Components

| Component | Package | Kind | Path | Notes |
|---|---|---|---|---|
| `scribbit-fee-oracle` | `@bsh/scribbit-fee-oracle` | library (+ optional server) | `packages/fee-oracle` | Multi-source fee aggregation (mempool.space, Esplora, bitcoind, Libre Relay block lane): median, outlier rejection, min-relay floor, TTL cache, source health. Provides `contracts/openapi/scribbit-fees.yaml` |
| `scribbit-cli` | `@bsh/scribbit-cli` | tool | `apps/cli` | Developer CLI `scribbit`: exact `quote`, `envelope` dump, `commit-address`, self-`rescue`; `--json` everywhere |
| `scribbit-mcp` | `@bsh/scribbit-mcp` | service | `services/mcp` | MCP server "scribb.it: write to Bitcoin" for AI agents: `get_fees`, `quote_inscription`, `build_envelope`, `commit_address`, `explain_lanes`, `rescue_tx` + docs resources and an `inscribe_this` prompt. Streamable HTTP at `/mcp` behind `@bsh/edge` API keys, or stdio for Claude Desktop / Claude Code. Provides `contracts/openapi/scribbit-mcp.yaml` |
| `scribbit-mint` | `@bsh/scribbit-mint` | app | `apps/mint` | The retail mint "scribb.it: write to Bitcoin": `/ordinals` (any file/text as an inscription, batches) and `/counters` (counter, reinscription, fairminter/XCP-69). PSBTs only: the wallet signs every transaction; exact quotes, commit-txid check, resumable pending mints, rescue; `?demo=1` |
| `scribbit-mint-api` | `@bsh/scribbit-mint-api` | service | `services/mint-api` | Keyless, stateless edge for the mint: `/api/fees`, Esplora UTXO/tx/broadcast proxy, allowlisted Counterparty v2 proxy, behind `@bsh/edge`. Provides `contracts/openapi/scribbit-mint-api.yaml` |

## Components to come

Planned components (provisional names; each ships with a manifest, contracts first):

| Component | Kind | Path | Notes |
|---|---|---|---|
| `scribbit-engine` | service | `services/engine` | Order state machine, commit/reveal, lane broadcaster; generalised from `degent-mint` |
| `scribbit-ledger` | service | `services/ledger` | Order and payment ledger, reconciliation, receipts |
| `scribbit-console` | app | `apps/console` | Operator and creator console |
| `scribbit-mint-suite` | app + package | `apps/mint-suite`, `packages/mint-kit` | White-label collection mints (degent.club-style) for other creators |
| `scribbit-api` | service | `services/api` | Public API; provides `contracts/openapi/scribbit.yaml` (the MCP server will gain order tools over it) |

Shared maths and wallet code stays in `platform/` (`@bsh/inscription`, `@bsh/wallet-kit`); anything the engine and
degent.club both need moves there rather than being imported across products.
