# @bsh/scribbit-signet-faucet: free signet sats for the Signet Playground

A small HTTP service that sends a **fixed drip of signet sats** to a `tb1…` address, so a stranger can make their
first inscription in the [Signet Playground](../../apps/playground/README.md) without owning any bitcoin. Instead of
a third-party captcha it asks the browser for a moment of **SHA-256 proof of work**; per-address and per-IP
buckets and a daily global budget keep it from being drained. It pays **signet only** and refuses mainnet
addresses with their own error code. Off by default. Decision record: [ADR-0009](../../../../docs/adr/0009-signet-playground.md).

## Quickstart

```bash
pnpm install
pnpm --filter @bsh/scribbit-signet-faucet dev          # FAUCET_WALLET=fake: in-memory wallet, invented txids, port 3070

curl -s localhost:3070/v1/challenge
# {"algorithm":"sha256-leading-zero-bits/v1","nonce":"<32 hex>","difficulty":20,"expiresAt":"…","ttlSeconds":300,"message":"…"}
```

Solve it (any language; with the kit in this repo):

```ts
import { solvePow } from '@bsh/scribbit-playground-kit';
const { solution } = solvePow(nonce, 'tb1p…your signet address', 20);   // ~1M hashes, a few seconds
await fetch('http://localhost:3070/v1/drip', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: 'tb1p…', nonce, solution }),
});
// 200 {"network":"signet","address":"tb1p…","amountSats":50000,"txid":"…","explorerUrl":"https://mempool.space/signet/tx/…"}
```

Against a real signet node: `FAUCET_WALLET=bitcoind` with `BITCOIND_RPC_URL`, `BITCOIND_RPC_WALLET` and the RPC
credentials from the secret store (see "Configuration"). The process refuses to start unless the node reports
`chain: signet`.

```bash
pnpm --filter @bsh/scribbit-signet-faucet test         # 58 tests: limits, PoW + replay, network refusal, budget, bitcoind adapter, contract
pnpm --filter @bsh/scribbit-signet-faucet typecheck
```

## API

Contract: [`contracts/openapi/scribbit-signet-faucet.yaml`](../../../../contracts/openapi/scribbit-signet-faucet.yaml)
(every response has a schema there; `test/contract.test.ts` validates real responses against it).

| Route | What |
|---|---|
| `GET /v1/challenge` | Single-use nonce + difficulty + expiry |
| `POST /v1/drip` | `{ address, nonce, solution }` → `{ network, address, amountSats, txid, explorerUrl? }` |
| `GET /v1/status` | `open`, `reason`, `amountSats`, budget left today, when it resets |
| `GET /` | Discovery: drip amount, PoW rule, limits, wallet kind |
| `GET /healthz` | Liveness |
| `GET /metrics` | Prometheus text: challenges, drips by result, sats sent, budget; no addresses, no IPs |

**Error codes** (stable, `{ error: { code, message, requestId } }`): `bad_request`, `invalid_address`,
`mainnet_address_refused`, `wrong_network`, `challenge_unknown`, `challenge_expired` (410), `challenge_used` (409),
`pow_invalid`, `address_rate_limited` / `ip_rate_limited` / `rate_limited` (429 + `Retry-After`),
`budget_exhausted` (503 + `Retry-After` to 00:00 UTC), `faucet_disabled`, `faucet_empty` (503),
`wallet_unavailable` (502), `unsupported_media_type`, `payload_too_large`, `not_found`, `internal_error`.

### Order of checks in `POST /v1/drip`

body → address (signet only) → solution shape → wallet enabled → nonce (unknown / expired / used: **the first
attempt consumes it**, valid or not) → proof of work (against the difficulty the nonce was issued with and the
lower-cased address) → per-address and per-IP buckets (checked together, taken together) → daily budget →
send. If the wallet fails, the budget and both buckets are refunded.

## Configuration

Every variable is in [`env.schema.json`](./env.schema.json) (a test fails if `src/config.ts` reads one that is not).

| Env var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3070` / `0.0.0.0` | Listen address |
| `PUBLIC_URL` | unset | Advertised on `GET /` |
| `FAUCET_WALLET` | `off` | `off` (drips answer `faucet_disabled`) \| `bitcoind` \| `fake` (dev only: invented txids, nothing broadcast) |
| `BITCOIND_RPC_URL` | | Signet node RPC base, e.g. `http://bitcoind.internal.example:38332`; no credentials in the URL |
| `BITCOIND_RPC_WALLET` | | Loaded signet wallet that funds drips |
| `BITCOIND_RPC_USER` / `BITCOIND_RPC_PASSWORD` | | **Secrets**, from `services/scribbit-signet-faucet/bitcoind-rpc-user` / `-password` |
| `BITCOIND_RPC_TIMEOUT_MS` | `15000` | Per RPC call |
| `FAKE_WALLET_BALANCE_SATS` | `100000000` | Fake wallet's starting balance |
| `DRIP_SATS` | `50000` | Fixed drip (330..10,000,000). 50,000 covers a 50 KB inscription at a few sat/vB |
| `DAILY_BUDGET_SATS` | `5000000` | Global budget per UTC day (100 drips at the default) |
| `ADDRESS_DRIPS_PER_DAY` / `IP_DRIPS_PER_DAY` | `1` / `3` | Token buckets, refilled over 24 h |
| `POW_DIFFICULTY` | `20` | Leading zero bits (1..32); expected work 2^difficulty hashes |
| `CHALLENGE_TTL_SECONDS` | `300` | Nonce lifetime |
| `CHALLENGES_PER_MIN` / `RATE_LIMIT_IP_PER_MIN` | `20` / `60` | Per-IP request buckets |
| `CORS_ORIGINS` | none | Browser origins allowed (the playground's origin) |
| `TRUSTED_PROXIES` | none | CIDRs whose `X-Forwarded-For` is believed (client IP for the per-IP limits) |
| `EXPLORER_URL` | `https://mempool.space/signet` | Base for `explorerUrl` in drip responses |

## Limits and what is not claimed

- **Network.** `tb1` is shared by testnet and signet, so the address alone cannot prove "signet". The faucet
  refuses everything that is certainly not signet (mainnet `bc1`/`1…`/`3…`, regtest `bcrt1`) and the bitcoind
  adapter checks `getblockchaininfo.chain === "signet"` at startup and before its first send.
- **State is in memory.** A restart forgets challenges (clients get `challenge_unknown` and fetch a new one),
  buckets and today's spend. Acceptable for worthless test coins; one process per deployment (see RUNBOOK).
- **Proof of work is a speed bump, not identity.** A determined abuser with many IPs and CPUs can still collect
  drips; the daily budget caps the loss. Difficulty is a tuning knob, not a guarantee.
- **Drips are unconfirmed** when returned: the txid is in the node's mempool. Signet blocks target ten minutes.
- **No personal data.** The service keeps no log of addresses or IPs beyond the in-memory buckets; metrics carry
  result codes only.
- **Why no MCP tool.** Agents should not spend a shared faucet budget on a human's behalf; the scribb.it MCP server
  offers `playground_explain_step` instead (see its README).
