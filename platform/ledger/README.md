# @bsh/ledger

One order / payment ledger for block.space, scribb.it and degent.club. Products create **orders** priced in
satoshis, open a **payment intent** with the method the customer picked (on-chain, Lightning, card, or a
product-built **PSBT**), and read the result back as state, **events** and a **receipt**. Refunds go through
the same ledger; money that a customer's own transaction sent to a **payee** (an artist, the club) is recorded
as a **payout**. Contracts:
[`contracts/openapi/ledger.yaml`](../../contracts/openapi/ledger.yaml) (HTTP) and
[`contracts/asyncapi/ledger.yaml`](../../contracts/asyncapi/ledger.yaml) (events, also registered in the
canonical `platform-events.yaml`).

```
product ──API key──▶ Hono API (@bsh/edge) ──▶ LedgerService ──▶ OrderStore (memory | node:sqlite)
                                                   │  ▲                 └─ transition tables, idempotency, versions
              provider webhooks ───────────────────┘  │
              (BTCPay-Sig / Stripe-Signature)         │ poll()
                                             LedgerWorker.tick() ──▶ PaymentProvider adapters
                                                                       onchain (xpub + esplora) · btcpay · card · psbt · fake
                                        events: ledger.order.{status}, ledger.payment.{status}, ledger.payout.{status}
```

## Domain

| Entity | Fields | States |
|---|---|---|
| `Order` | `id, product, customerRef, lineItems[], currency:'sat', totalSats, status, metadata, version` | `created → awaiting_payment → paid → refunded`; `cancelled`/`expired` from the first two |
| `LineItem` | `sku, description, quantity, unitSats, payee?` - `payee = { kind: artist\|club\|platform\|other, ref (≤128, opaque), address xor scriptHex }` | - |
| `PaymentIntent` | `id, orderId, method, provider, providerRef, amountSats, amountPaidSats, refundedSats, status, checkout, expiresAt, paidAt, txid?, preimage?, providerData` | `created → pending → paid \| underpaid \| overpaid \| expired \| failed`; `underpaid` can still complete; `expired` can still be paid late (on-chain); `paid/overpaid/underpaid → refunded` |
| `Refund` | `id, paymentId, amountSats, status, reason, providerRef, destination, detail, version` | `pending → completed \| failed` |
| `Payout` | `id, orderId, paymentId, product, payee, amountSats, txid, vout, status, settledAt, version` - one per payee output found in the transaction that settled a `psbt` intent | `settled` (created so); `pending → settled \| failed` reserved for manual corrections |

The transition tables live in `src/domain/state.ts`; anything not listed throws `illegal_transition` (409).
Every state change funnels through `LedgerService.applyUpdate` (provider updates) or a service method
(product calls); nothing writes status fields directly. Stores use optimistic concurrency (`version`).

**Idempotency.** `POST` routes take `Idempotency-Key`. The key is scoped (`order:<product>`,
`payment:<orderId>`, `refund:<paymentId>`) and bound to a fingerprint of the request; a replay returns the
original resource (`200`), a different request under the same key is `422 idempotency_conflict`. Replays are
answered before state checks, so a replay after settlement still returns the resource.

**Money.** Integer satoshis only (`src/money.ts`). BTC strings exist solely at the provider boundary; fiat
conversion for cards is integer minor units at an integer rate, rounded half up.

**Refund availability.** `credited − completed refunds − pending refunds`: a refund that is still being paid
out reserves its amount. Concurrent `refund()` calls are serialised on the payment row (a version-checked
write between computing the availability and creating the refund), so two callers cannot both spend the same
availability; `updateRefund` is version-checked in both stores like every other entity.

## Providers (`PaymentProvider` port)

| Adapter | Methods | How it settles | Refunds |
|---|---|---|---|
| `OnchainAddressProvider` | `onchain` | Derives one fresh address per intent from an **account xpub** (BIP84 `p2wpkh` or BIP86 `p2tr`, `@scure/bip32` + `@scure/btc-signer`; private keys refused). The worker polls an esplora-compatible `ChainPort` and applies `ConfirmationPolicy` | Needs a `destination`; stays `pending` until an operator pays out and settles it (`/v1/refunds/{id}/settle`) - the ledger holds no keys |
| `BtcpayProvider` | `lightning`, `onchain` | BTCPay Greenfield: `POST /invoices` with `checkout.paymentMethods` = `BTC-LightningNetwork` or `BTC`, `GET /invoices/{id}` (+ `/payment-methods` for amounts). Webhooks verified with `BTCPay-Sig`; invoice states `New/Processing/Settled/Expired/Invalid` (+ `PaidOver`, `PaidPartial`, `PaidLate`) map onto the intent states | `POST /invoices/{id}/refund` → pull payment (`pending` until claimed) |
| `StripeLikeProvider` (`CardProvider`) | `card` | `POST /v1/payment_intents` priced in fiat at intent creation; the browser finishes with `checkout.clientSecret` and the processor's SDK. `poll`/`confirm`/webhooks map `succeeded/processing/canceled` | `POST /v1/refunds`; refund webhooks complete them |
| `PsbtProvider` | `psbt` | "The customer pays by signing a PSBT the product builds." Every line item must carry a `payee` (`409 payee_required`); `createIntent` derives the **expected outputs** (`expectedOutputsFor`: line items summed per payee *script*, addresses decoded for the configured network) and returns them in `checkout.outputs` / `providerData.expectedOutputs`. `evaluate(intent, tx)` / pure `evaluatePsbt` compare an observed transaction's outputs by **script, never address string**: `paid` when every expected output is present at or above its value at the confirmation depth (`overpaid` above the tolerance), `underpaid` when some are short or missing (with what did arrive), `pending` while replaceable or shallow. Each satisfied output is handed to the service as a payout settlement. With an esplora `chain` the worker finds the transaction by the first payee script (`/scripthash/:h/txs`); with the `store` port it skips txids already claimed by another intent, and the service refuses in any case to let one txid settle two `psbt` intents. Without a chain the product reports the transaction (`provider.evaluate` + `service.applyUpdate`). No keys, nothing built, nothing signed | Needs a `destination`; manual payout like on-chain |
| `FakeProvider` | all | Tests and dev: `settle()/pending()/expire()/fail()` are delivered on the next poll | configurable |

On-chain policy (`evaluateOnchain`, pure): only **confirmed or unreplaceable** (no BIP125 signalling)
transactions count at all; only those at `confirmations` depth are credited. Sums over every output to the
address, so top-ups work and an RBF replacement that drops out of the mempool is forgotten. `paid` when
credited ≥ amount (- `underpaymentToleranceSats`), `overpaid` above amount + `overpaymentToleranceSats`,
`pending` while money is seen but not deep enough, `underpaid` once partial funds are confirmed, `expired` only
when nothing was ever received.

Webhooks are **trust-but-verify**: after a signature check and delivery de-duplication the service re-fetches
the provider's state (`poll`) and applies that; the webhook body is only used when the provider is unreachable.

## API

`createLedgerApp({ service, apiKeyStore, environment })` - see the OpenAPI file for the full surface:
`POST /v1/orders`, `GET /v1/orders/{id}`, `POST /v1/orders/{id}/payments`, `GET /v1/payments/{id}`,
`POST /v1/payments/{id}/refund`, `GET /v1/orders/{id}/receipt` (JSON, or text with `Accept: text/plain` /
`?format=text`; includes payouts), `GET /v1/orders/{id}/payouts`, `GET /v1/payees/{ref}/payouts[?kind=]`
(scoped to the key's product; admin sees all), `POST /v1/webhooks/{btcpay,card}`, `GET /v1/health`, plus
cancel, list payments, get/settle refund. Contract note: `PaymentIntent.method` in responses is an
`x-extensible-enum` (open set) - CI's `oasdiff breaking` locks closed enums in responses, so new methods are
added to the request-side `PaymentMethod` enum and clients must tolerate unknown values in responses.
Edge stack from `@bsh/edge`: request ids, uniform errors, security headers, 64 KiB body limit, per-IP
and per-key token buckets, API keys (scope `ledger`; `ownerId` = product slug, which scopes every order;
`ledger:admin` sees all products and may settle refunds).

```ts
import { createLedgerApp, LedgerService, LedgerWorker, SqliteOrderStore, BtcpayProvider, OnchainAddressProvider, EsploraChain } from '@bsh/ledger';

const store = new SqliteOrderStore('/var/lib/ledger/ledger.sqlite');
const providers = [
  new OnchainAddressProvider({ xpub, network: 'mainnet', addressType: 'p2wpkh', chain: new EsploraChain(esploraUrl), store, policy: { confirmations: 1 } }),
  new BtcpayProvider({ baseUrl, storeId, apiKey, webhookSecret }),
  new PsbtProvider({ network: 'mainnet', chain: new EsploraChain(esploraUrl), store, policy: { confirmations: 1 } }),
];
const service = new LedgerService({ store, providers, bus });          // bus: AmqpBusAdapter from @bsh/events
const app = createLedgerApp({ service, apiKeyStore, environment: 'live' });
new LedgerWorker({ service, store, providers }).start(15_000);         // or call tick() from a scheduler
```

`src/main.ts` wires all of this from the environment (`env.schema.json`).

## Events

`ledger.order.{status}`, `ledger.payment.{status}` and `ledger.payout.{status}` (CloudEvents, `source:
urn:bsh:ledger`, `subject` = order id) are published after each persisted transition; a `psbt` intent going
`paid` publishes `ledger.payment.paid`, then one `ledger.payout.settled` per payee output (`payoutId, orderId,
paymentId, product, payee, amountSats, txid, vout, status, at`), then `ledger.order.paid`. `ledger.payment`
is at topic version 1.1.0 (`method` gained `psbt`). Publishing is best-effort after the write
(`onPublishError`); for exactly-once relay put an `OutboxStore` between the store and the bus (see
`@bsh/events`). Consumers must de-duplicate on `(source, id)` and tolerate new enum values.

## Security

- **Webhooks are authenticated by signature over the raw body**, never by API key: `BTCPay-Sig`
  (`sha256=<hex HMAC-SHA256(secret, body)>`) and the `t=…,v1=…` scheme (`HMAC-SHA256(secret, "<t>.<body>")`,
  300 s tolerance, timestamp inside the MAC). Constant-time comparison; several secrets accepted during rotation.
  Deliveries are de-duplicated on the provider's delivery/event id, then the provider is re-polled.
- **No card data touches us.** The card adapter only ever sees the processor's intent id and a client
  secret; the customer's browser sends card details to the processor. This keeps the ledger out of PCI DSS
  cardholder-data scope (SAQ A posture); do not add endpoints that accept PANs, CVCs or raw card tokens.
- **Non-custodial on chain.** The on-chain provider takes an account **xpub** and refuses private keys
  (`parseAccountXpub`). Refunds of on-chain payments are operator payouts from the treasury wallet.
- **PSBT payments are non-custodial by construction.** The ledger never sees a PSBT, an input or a key: it
  publishes the outputs the product's PSBT must carry and later checks a broadcast transaction against them.
  Payee outputs are matched by scriptPubKey (addresses are decoded once, at intent creation, for the configured
  network); one transaction can settle only one `psbt` intent. Payouts are records of money the customer's own
  transaction moved, never transfers by the ledger.
- **Secrets** (API keys, BTCPay key, webhook secrets, xpub) come from the secret store as environment values
  (`component.yaml#secrets`). Only SHA-256 hashes of ledger API keys are stored.
- `customerRef` and `metadata` are contractually opaque, non-PII references owned by the product.
- The HTTP surface is meant to sit behind the fleet edge; `LEDGER_TRUSTED_PROXIES` controls XFF trust.

## Tests

`pnpm --filter @bsh/ledger test` covers: transition tables; BIP84/BIP86 address vectors (account keys and
addresses derived from the BIP test mnemonic); the on-chain policy (exact/under/over, confirmation depth,
RBF, late payment, expiry) with a fake chain and the worker's `tick()` under a fake clock; BTCPay signature
valid/invalid/replay and state mapping; card signature and mapping; memory/SQLite store parity (incl. payouts,
refund versions and the 0002 in-place migration of a 0001 database with rows); the API via `app.request` with
every response validated against `ledger.yaml` (ajv); an end-to-end order → Lightning invoice (fake BTCPay) →
webhook → paid → event → receipt → refund flow, plus a card flow; the psbt policy (`evaluatePsbt`: exact,
over, under, missing, RBF, depth, script matching) and an open-studio mint flow (payees → `checkout.outputs`
→ observed tx → paid → payouts → events → receipt → refund), the worker with a fake scripthash chain (late
payment, expiry, candidate ranking, one txid settles one intent); and the refund race (two concurrent pending
refunds cannot exceed `amountPaidSats`).

```bash
pnpm --filter @bsh/ledger test
pnpm --filter @bsh/ledger typecheck
pnpm --filter @bsh/ledger dev        # LEDGER_FAKE_PROVIDER=1 for a local loop
```
