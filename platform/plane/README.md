# @bsh/plane

An open, minimal **authorization plane** for our agents: FlashyOS's published wallet-plane shape
(`flashyos-wdk`, Apache-2.0) - five checks, three verdicts, signed single-use `SpendAuthorization`s -
implemented independently of FlashyOS's own (private) plane. ADR-0014.

```
agent / MCP tool ──POST /v1/orgs/{org}/wallet/propose──► @bsh/plane
                                                            │  decide(): identity → authority → record
                                                            │            → envelope → budget → grading
                                                            ├─ ALLOW    → signed SpendAuthorization (300 s, single use)
                                                            ├─ ESCALATE → held reservation, a person resolves it
                                                            └─ DENY     → nothing reserved, a denial code
signer / settler  ──POST /v1/orgs/{org}/wallet/settle────► redeems the authorization against the ACTUAL call
```

## The five checks (`decide()`, `src/decide.ts`)

Order is load-bearing and tested; cheap identity-shaped checks run before anything touches the budget.

1. **identity** - the caller is an agent of this organisation, and any envelope named is its own.
2. **authority** - the key holds `wallet:propose` (exact match, default deny) and never `wallet:settle`.
   The `OperationRecord` also has to parse here (`INVALID_RECORD` / `INVALID_AMOUNT` before evaluation).
3. **envelope** - a `SpendEnvelope` exists for the record's chain, is `active`, and permits the kind, the
   asset, the destination (exact address or a `payee:<kind>` class) and an amount `<= perTxMax`.
4. **budget** - today's reserved + committed + this amount `<= dailyMax`, reserved atomically
   (`Budget.reserve`: read, decide, compare-and-set; a losing writer retries, never double-spends the cap).
5. **grading** - the envelope's own policy (`autoApproveMax`, `alwaysEscalate`,
   `humanApprovalAtOrAbove`) plus a pluggable `Grader` (default: denylist + first-payment-to-a-new-destination
   escalation). A grader may `DENY` (releases the reservation) or `ESCALATE` (holds it for a person); it may
   never loosen a verdict.

Verdicts: `ALLOW | ESCALATE | DENY`. Denial codes: `SCOPE_MISSING`, `NO_ENVELOPE`, `ENVELOPE_INACTIVE`,
`KIND_NOT_PERMITTED`, `ASSET_NOT_PERMITTED`, `DESTINATION_NOT_PERMITTED`, `PER_TX_CAP`, `DAILY_CAP`,
`INVALID_AMOUNT`, `INVALID_RECORD` - FlashyOS's, field for field. Identity/authority failures surface as
`SCOPE_MISSING` (FlashyOS has no separate identity code; the reason string says which check failed).

Money is `bigint` inside the package, decimal strings on the wire - never `Number` an amount.

## Library

| Export | What |
|---|---|
| `decide(input, agent, envelope, budget, now, options)` | The policy. Returns `{ verdict, code?, reasons, impact, checks, record?, reservation? }` |
| `parseOperationRecord`, `recordForAudit` | `OperationRecord` validation (`src/record.ts`); btc destinations checked with `@bsh/mesh`'s bech32/bech32m validator, amounts capped at the 21M BTC supply |
| `parseEnvelopeInput`, `destinationPermitted`, `policyGrade`, `envelopeForRole` | `SpendEnvelope` validation and check 5's policy half (`src/envelope.ts`); `envelopeForRole` derives `humanApprovalAtOrAbove` from an `aao/0.1` charter role |
| `Budget`, `BudgetContentionError` | Two-phase (RESERVED → COMMITTED / RELEASED) atomic daily-cap accounting (`src/budget.ts`) |
| `defaultGrader`, `composeGraders`, `type Grader` | Check 5's pluggable half (`src/grading.ts`) |
| `signAuthorization`, `verifyAuthorization`, `canonicalAuthorization`, `MemoryNonceStore` | `SpendAuthorization`: sign, and the signer's side - signature, window, re-derive-and-match against the actual call, then consume the nonce (`src/authorization.ts`) |
| `chainEntry`, `verifyAuditChain`, `signAuditHead`, `verifyAuditHead` | The hash-chained audit log and its FlashyOS-compatible `ProvenanceEntry` shape (`src/audit.ts`) |
| `verifyApproval`, `signApproval`, `parseApprovers` | The `X-Approval` second factor for people changing envelopes or resolving decisions (`src/approval.ts`) |
| `httpLedgerPort`, `type LedgerPort` | Optional: reports a `CONFIRMED` settlement to the platform ledger as an observation (`src/ledger.ts`) |
| `loadConfig`, `parsePlaneKeys`, `scopeConflict` | Environment parsing; refuses a key holding both `wallet:propose` and `wallet:settle`, or `wallet:delegate` with either (`src/config.ts`) |
| `PlaneService` | Runs `decide`, records every verdict (refusals too), signs authorizations, settles/releases reservations, resolves escalations, sweeps expiry, publishes the plane document (`src/service.ts`) |
| `MemoryPlaneStore`, `SqlitePlaneStore` | The `PlaneStore` port: envelopes, budget, reservations, decisions, authorizations, idempotency, destinations-seen, audit, nonces - one adapter each, identical compare-and-set semantics (`src/store/`) |
| `createPlaneApp` | The Hono service (`src/api.ts`) |

## Service

```bash
pnpm --filter @bsh/plane dev           # env in env.schema.json; contract in contracts/openapi/plane.yaml
curl -s localhost:3070/v1/health
curl -s localhost:3070/.well-known/flashyos-plane.json
```

| Route | Scope | Notes |
|---|---|---|
| `POST /v1/orgs/:org/wallet/propose` | `wallet:propose` | Runs the five checks; `Idempotency-Key` replays the same verdict without re-reserving |
| `POST /v1/orgs/:org/wallet/settle` | `wallet:settle` | `{ authorizationId, outcome: CONFIRMED \| REVERTED, txHash, ledger? }` - redeems or rolls back |
| `GET /v1/orgs/:org/wallet/envelopes/:agent` | `wallet:delegate` | Current envelope per chain |
| `PUT /v1/orgs/:org/wallet/envelopes/:agent` | `wallet:delegate` + `X-Approval` | Sets a new envelope version; the old one is kept, never deleted |
| `GET /v1/orgs/:org/wallet/decisions` | `wallet:read` or `wallet:delegate` | The audit log, paginated (`since`, `limit`), with a signed head |
| `POST /v1/orgs/:org/wallet/decisions/:decisionId/resolve` | `wallet:delegate` + `X-Approval` | A person approves (issues the held authorization) or rejects (releases) an `ESCALATE` |
| `GET /.well-known/flashyos-plane.json` | none | The `PlaneDocument` (`@bsh/mesh`): active + retired keys, chains, schemas enforced |
| `GET /v1/health` | none | |

Edge stack (`@bsh/edge`): request ids, uniform JSON errors, security headers, per-IP and per-key token
buckets, 64 KiB body limit, API keys scoped per route. `wallet:propose` + `wallet:settle`, and
`wallet:delegate` with either, are refused together at key load (`SCOPE_CONFLICT`) - never at request time,
so a misconfiguration cannot silently degrade into a bypass.

### `X-Approval`: the second factor for people

FlashyOS lets a signed-in org owner/admin change an envelope. We have API keys, not sessions: a
`wallet:delegate` key alone is not enough. The request must also carry `X-Approval: kid=…, at=…, sig=…`, an
Ed25519 signature by a configured approver over `canonical({ v, method, path, bodySha256, apiKeyId, at })` -
bound to the exact request, valid for 300 s, single use (the signature is its own nonce). A stolen API key
cannot change an envelope; a stolen approval cannot be replayed or moved to another request.

### `SpendAuthorization`: signed, single-use, re-derived at redemption

On `ALLOW`, the plane signs `{ id, orgId, agentName, chain, kind, asset, maxAmount, destination,
reservationId, decisionId, issuedAt, expiresAt }` (canonical JSON, Ed25519, `@bsh/mesh`). A verifier
(typically a signer service) checks the signature under a trusted key (the plane document's `active` and
`retired` keys), the window, then re-derives `{ chain, kind, asset, amount, destination }` from the *actual*
call and requires an exact match plus `amount <= maxAmount` - never trusting the authorization's own claim
about what it authorizes - before consuming the nonce. A call the signer refuses never burns the
authorization; a second successful use is `REPLAY`.

### Audit: hash-chained, append-only, refusals included

Every verdict, authorization, settlement, resolution, envelope change and expiry is one entry:
`hash = sha256(canonical({ seq, at, kind, id, data, prev }))`, `prev` = the previous entry's hash (64 zeros
for the first) - FlashyOS's `ProvenanceEntry` shape, so their `verifyExport` algorithm checks our chain
unmodified. `verifyAuditChain` recomputes every hash, checks every `prev`, checks seqs are contiguous and
times never go backwards, and - given a signed head - that the page ends exactly there under a trusted key.
One altered character anywhere is a refusal naming the entry.

### Wire-compatible, not dependent

This plane does not call FlashyOS's, and they cannot call ours. Compatibility is at the level of formats:
the same `OperationRecord` / `SpendEnvelope` / `SpendAuthorization` shapes, the same checks in the same
order, the same codes - verified against vendored fixtures under `test/fixtures/flashyos-wdk` (unmodified,
NOTICE included), the same discipline ADR-0010 set for `@bsh/mesh`.

## Marked extensions (ours, not FlashyOS's)

- `active` flag on envelopes (they revoke through a separate route).
- `payee:<kind>` destination classes, matched against the ledger's payee kinds - lets an envelope permit "any
  artist payout" without listing every artist's address.
- `humanApprovalAtOrAbove` per envelope, typically derived from an `aao/0.1` charter role
  (`envelopeForRole`).
- `btc:` chain family: bech32/bech32m destination validation (`@bsh/mesh`), amount capped at the 21M BTC
  supply in sats.
- Ed25519-signed audit heads (FlashyOS's own head is unsigned by design).

## Develop

```bash
pnpm --filter @bsh/plane test        # every check and code, ordering, budget races, expiry/rollback,
                                      # authorization signature/nonce/expiry, approval signatures, audit
                                      # tamper detection, HTTP scopes, ajv contract validation, btc vectors
pnpm --filter @bsh/plane typecheck
```
