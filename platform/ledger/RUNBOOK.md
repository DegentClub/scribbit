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
| `409 payee_required` on `method: psbt` | a line item has no `payee`, or payee outputs do not sum to the order total | the product must put a payee on every line (the mint's own commit output is a `platform` payee); nothing to do on our side |
| `400 invalid_payee_address` | a payee address is not valid on `LEDGER_NETWORK` | product bug (wrong network); the intent was not opened |
| psbt intent stays `created` although the customer's transaction is on chain | no `LEDGER_ESPLORA_URL` (the product must report the transaction via `PsbtProvider.evaluate` + `applyUpdate`), esplora unreachable, or the transaction does not carry every expected output (check `checkout.outputs` against the tx: scripts, not addresses) | fix reachability / have the product report; an `underpaid` intent lists the short outputs in `detail` - a complete second transaction settles it |
| worker log `txid … already settles pay_…` / intent not credited | two `psbt` orders expect identical outputs (same payees, no unique output) and one transaction matched both | by design: one txid settles one intent. Products must make each order's outputs distinguishable (unique commit output); the second order needs its own transaction |
| `409 refund_exceeds_paid` with `… reserved by pending refunds` | pending refunds reserve their amount | settle or fail the pending refund first (`/v1/refunds/{id}/settle`) |
| `500 internal_error` | see the log line with the request id | file a bug with the request id; never patch state by hand |

## Data

- SQLite file at `LEDGER_DB_PATH` (WAL mode). Back it up with `sqlite3 <path> ".backup <dest>"` (consistent
  with WAL). Migrations (`src/store/migrations.ts`) apply on start; they are append-only. Migration
  `0002_psbt_payees_payouts` rebuilds `payments` in place (SQLite cannot widen a CHECK), runs with foreign keys
  off and verifies `PRAGMA foreign_key_check` before committing - take a backup before the first start on the
  new version; it is idempotent and rolls back on any error.
- Tables: `orders`, `payments`, `refunds`, `payouts`, `idempotency_keys`, `webhook_deliveries`,
  `address_indexes`, `schema_migrations`. Amounts are integer satoshis. Payees live inside the `line_items`
  JSON of an order; `payouts` denormalises `payee_kind` / `payee_ref` for listing.
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
- For `psbt` intents: `SUM(payouts.amount_sats)` per payment equals `amount_paid_sats` when every line item
  has a payee (it does - `payee_required`), and each `payouts.txid:vout` exists on chain paying
  `payee.scriptHex`. The ledger moved none of it; an artist asking "where is my share" is answered with
  `GET /v1/payees/{ref}/payouts` and the explorer.
- Pending refunds (`refunds.status = 'pending'`) never sum above `amount_paid_sats - refunded_sats` per payment.
- Alerts worth wiring: worker tick errors > 0 for 5 min; webhook `401` rate; intents `pending` > 6 blocks.
