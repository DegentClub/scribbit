# scribbit-signet-faucet runbook

Owner: team-scribbit. Service: `@bsh/scribbit-signet-faucet` (products/scribbit/services/signet-faucet). SLO: 99.0 %
availability, p95 800 ms (one `sendtoaddress` dominates). It moves **signet** coins only; an outage costs learners
time, not money.

## What it is

One stateless-ish Hono process (default port 3070). State lives in memory: issued challenges, per-address and
per-IP buckets, today's spend. The only key is the faucet wallet's, inside bitcoind; this process talks to it over
RPC with credentials from the secret store (`services/scribbit-signet-faucet/bitcoind-rpc-user`,
`…/bitcoind-rpc-password`).

Run **one** replica. Two replicas would double the per-address, per-IP and daily limits and would not share
challenges (a nonce issued by one is `challenge_unknown` on the other).

## Health

- `GET /healthz` → `{ status: "ok", wallet: "off" | "bitcoind" | "fake" }` (bitcoind is not probed).
- `GET /v1/status` → `open: false` with `reason: faucet_disabled | budget_exhausted` explains a closed faucet.
- `GET /metrics` → alert on `rate(faucet_drips_total{result="wallet_unavailable"}[5m]) > 0`,
  `faucet_drips_total{result="faucet_empty"}` increasing, and `faucet_budget_remaining_sats == 0` well before
  midnight UTC (the budget is too small or someone is farming it).

## Common operations

| Symptom | Action |
|---|---|
| `faucet_empty` | Refill the signet wallet (`getnewaddress` on the faucet wallet, send signet coins to it). Nothing else to do: drips resume at once |
| `wallet_unavailable` | Check the node (`bitcoin-cli -signet getblockchaininfo`), the wallet is loaded (`listwallets`), the RPC credentials in the secret store |
| Process exits with code 3, `refusing to start` | `BITCOIND_RPC_URL` points at a node that is not on signet. Fix the URL; never override the check |
| Budget gone by mid-morning | Raise `POW_DIFFICULTY` by 1-2 (each bit doubles the client's work) before raising `DAILY_BUDGET_SATS` |
| A drip is stuck unconfirmed | Drips are BIP 125 replaceable: `bitcoin-cli -signet -rpcwallet=<w> bumpfee <txid>` |
| Restart | Safe at any time. Learners holding a challenge get `challenge_unknown` and the app fetches a new one |

## Configuration

See `env.schema.json` and the README table. Defaults are safe: `FAUCET_WALLET=off`.
