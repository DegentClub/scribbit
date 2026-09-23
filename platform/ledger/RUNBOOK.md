# ledger - runbook

Service: `@bsh/ledger` (`platform/ledger`). Owner: team-platform. Contract: `contracts/openapi/ledger.yaml`.
Health: `GET /v1/health` (no auth) lists configured providers. Logs go to stdout; errors carry the request id
(`X-Request-Id`) that the caller received.

## Configuration

Everything is environment (`env.schema.json`). Secrets are injected from the secret store at the paths in
`component.yaml#secrets`; never put them in files in the repo. Rotate a webhook secret by setting the
variable to `new,old` (comma-separated), deploying, updating the provider, then dropping `old`.

Minting a product API key: `generateApiKey('live')` from `@bsh/edge` - store only `{ id, hash, env, scopes:
['ledger'], ownerId: '<product>' }` in `LEDGER_API_KEYS_JSON`; hand the key to the product once.
Operator keys carry `scopes: ['ledger', 'ledger:admin']`.

## Symptoms and actions

| Symptom | Likely cause | Action |
|---|---|---|
| Intents stay `created` although customers paid | worker not ticking, or the chain/BTCPay backend is unreachable (`ledger worker: poll failed` in logs) | check `LEDGER_ESPLORA_URL` / `BTCPAY_URL` reachability from the host; the worker is idempotent, restart the service; every open intent is re-polled on the next tick |
| BTCPay webhooks return `401 invalid_signature` | secret mismatch between BTCPay store webhook and `BTCPAY_WEBHOOK_SECRET` | compare; nothing is lost - the worker reconciles from the API regardless of webhooks |
| Card webhooks `401 timestamp_too_old` | clock skew > 300 s or a replayed capture | check NTP on the host; replays are expected to fail |
| `409 payment_active` for a product | the previous intent is still `created`/`pending` | wait for expiry (worker) or have the product cancel; do NOT edit rows |
| Intent `underpaid` | customer sent less than the total | on-chain: they can top up the same address; BTCPay: the invoice is closed, refund via `POST /v1/payments/{id}/refund` (default = everything credited) |
| Intent `overpaid` | customer sent more | `POST /v1/payments/{id}/refund` with no amount refunds exactly the excess |
| Refund stuck `pending` (on-chain) | on-chain refunds are manual payouts | pay `destination` from the treasury wallet, then `POST /v1/refunds/{id}/settle {"status":"completed","detail":"<txid>"}` with an admin key |
| Refund stuck `pending` (BTCPay) | pull payment not yet claimed by the customer | nothing to do until they claim; if the claim link expired, settle `failed` and reissue |
| `409 concurrent_update` | two writers raced on one intent (webhook + worker) | benign; the loser retries automatically up to 3x, the caller may retry |
| `500 internal_error` | see the log line with the request id | file a bug with the request id; never patch state by hand |

## Data

- SQLite file at `LEDGER_DB_PATH` (WAL mode). Back it up with `sqlite3 <path> ".backup <dest>"` (consistent
  with WAL). Migrations (`src/store/migrations.ts`) apply on start; they are append-only.
- Tables: `orders`, `payments`, `refunds`, `idempotency_keys`, `webhook_deliveries`, `address_indexes`,
  `schema_migrations`. Amounts are integer satoshis.
- Never edit status columns directly: every transition is validated in code and emits an event. If a manual
  correction is unavoidable, do it through the service (`settleRefund`, `applyUpdate`) from a REPL and record it.

## Address derivation (on-chain)

Receive addresses are `m/<purpose>'/<coin>'/<account>'/0/<index>` from `LEDGER_XPUB`; `address_indexes` holds the
next index per (network, type, key fingerprint). Changing the xpub starts a new counter; keep the old
service instance polling until all its open intents settle or expire (24 h grace for late payments). The
watch-only xpub can be verified against the wallet: address index 0 must equal the wallet's first receive
address.

## Reconciliation checks

- Sum of `payments.amount_paid_sats - refunded_sats` for `paid/overpaid` intents should match the wallet's
  received total for the same address range (on-chain) and BTCPay's settled invoices for the store.
- Alerts worth wiring: worker tick errors > 0 for 5 min; webhook `401` rate; intents `pending` > 6 blocks.
