# plane — runbook

Service: `@bsh/plane` (`platform/plane`). Contract: `contracts/openapi/plane.yaml`. Env: `env.schema.json`.
Owner: team-platform. Default port 3070, loopback bind. ADR-0014.

## Start / verify

```bash
pnpm --filter @bsh/plane start                                        # reads env; exits 2 with a one-line reason on bad config
curl -s localhost:3070/v1/health                                      # {"status":"ok","version":"0.1.0","chains":[...],"ledger":false,"time":"..."}
curl -s localhost:3070/.well-known/flashyos-plane.json                # the plane document; validate with @bsh/mesh's validatePlaneDocument
```

Startup log line `plane: listening on …` names the chains, the number of API keys and approvers, and
whether a ledger is configured. `PLANE_DB_PATH` unset means the in-memory store: fine for a smoke test,
never for a real deployment (every reservation, decision, authorization and the audit log are lost on
restart — see "Data" below).

## Secrets

| Path | What | Rotation |
|---|---|---|
| `services/plane/authz-private-key` | Ed25519 PKCS#8 PEM (`mesh keygen`); signs every `SpendAuthorization` and audit head | Generate the new key, deploy it as `PLANE_AUTHZ_PRIVATE_KEY`, move the OLD key's public half into `PLANE_AUTHZ_RETIRED_PUBLIC_KEYS` in the SAME deploy (rotation is an overlap: anything the old key signed keeps verifying against the plane document) |
| `services/plane/api-keys` | JSON array of `{ id, hash, env, scopes, org, name, revokedAt?, expiresAt?, quota? }` | Mint with `generateApiKey('live')` from `@bsh/edge`; `wallet:propose` + `wallet:settle` on one key is refused at startup (`SCOPE_CONFLICT`), as is `wallet:delegate` with either — do not try to work around this, it is the separation of duties the plane exists to enforce |
| `services/plane/ledger-api-key` | A ledger key (scope `ledger`) for the product whose settlements this plane reports | Standard ledger key rotation (see `platform/ledger/RUNBOOK.md`) |

`PLANE_APPROVERS_JSON` holds only public keys and is not secret, but without it nobody can `PUT` an envelope
or resolve a decision over HTTP — provision it before the first agent needs an envelope.

## Symptoms and actions

| Symptom | Likely cause | Action |
|---|---|---|
| Every proposal is `DENY NO_ENVELOPE` | The agent has no envelope for that chain, or `putEnvelope` was called for the wrong `agentName`/chain | `GET /v1/orgs/:org/wallet/envelopes/:agent`; set one with `PUT` (needs `wallet:delegate` + `X-Approval`) |
| A known-good agent suddenly gets `DENY ENVELOPE_INACTIVE` | Someone set `active: false` on its envelope (check the audit log, `kind: "envelope"`) | Confirm it was intended; if not, `PUT` a corrected envelope (a new version — the old one is never deleted) |
| `DENY DAILY_CAP` before the org expects it | `dailyMax` reached by RESERVED + COMMITTED reservations, including ones for proposals a person never got to approve | `GET /v1/orgs/:org/wallet/decisions` for today; PENDING decisions hold a reservation until resolved or expired — resolve or wait |
| Escalations pile up unresolved | No approver configured, or nobody is watching `GET /v1/orgs/:org/wallet/decisions` for `PENDING` | Confirm `PLANE_APPROVERS_JSON`; PENDING decisions auto-expire after `PLANE_DECISION_TTL_HOURS` (default 24h) and release their reservation — expiry is not a bypass, it is "propose again" |
| `403 approval_required` / `approval_invalid` on a `PUT`/`resolve` call | Missing or malformed `X-Approval`, wrong approver key, clock skew > 300 s, or the approval was already used (single-use) | Check the approver's clock; re-sign — a used approval cannot be replayed by design |
| `409 SCOPE_CONFLICT` at startup | A configured key holds `wallet:propose` + `wallet:settle`, or `wallet:delegate` with either | Split into two keys. This refusal is intentional; do not merge the scopes back |
| Settlements report `anomaly: "EXPIRED_BEFORE_SETTLE"` | The signer/settler took longer than `PLANE_AUTHORIZATION_TTL_SECONDS` (default 300s, capped at 300) to broadcast and confirm | The commit still applies (the chain confirmed), but investigate the slow path — a signer that is regularly this slow will start losing legitimate authorizations to expiry sweeps |
| `GET /v1/orgs/:org/wallet/decisions` reports `HASH_MISMATCH` / `CHAIN_BROKEN` from `verifyAuditChain` | The store's audit rows were edited outside the service (never do this) or genuine corruption | Treat as a security incident: freeze the org's keys, preserve the store file, escalate — the chain is designed so this is never silent |
| `429` | Per-IP (`PLANE_RATE_LIMIT_PER_MINUTE`) or per-key (half that) bucket exhausted | Legitimate burst → raise the limit for that deployment; otherwise a runaway or compromised caller |
| Ledger observation not recorded on settle | `PLANE_LEDGER_URL`/`PLANE_LEDGER_API_KEY` not set, or the ledger rejected it | `settle`'s response carries `ledger: { recorded, applied?, error? }` — the settlement itself always succeeds independent of the ledger call |
| Process exits 2 at start | Config error (printed) | Common: no signing key, no API keys, an unknown scope, a key of the wrong `PLANE_KEY_ENV`, `PLANE_LEDGER_API_KEY` without `PLANE_LEDGER_URL` or vice versa |

## Data

- `PLANE_DB_PATH` (SQLite, WAL, `node:sqlite`). Back up with `sqlite3 <path> ".backup <dest>"`. Migrations
  (`src/store/sqlite.ts`, `PLANE_MIGRATIONS`) apply on start and are append-only.
- Tables: `envelopes` (versioned, never overwritten), `budgets` + `reservations` (the two-phase daily-cap
  accounting), `decisions`, `authorizations`, `idempotency`, `destinations` (first-payment memory for the
  default grader), `audit` (the hash chain), `nonces` (approval and authorization single-use).
- Single writer by design (one `BEGIN IMMEDIATE` transaction per compare-and-set) — this is what makes the
  budget check race-free. A deployment that needs multiple plane replicas needs a different `PlaneStore`
  adapter first (see ADR-0014, Consequences); do not run two writers against one SQLite file.
- Never edit a row directly. Every state change is validated in code (compare-and-set on version or status)
  and, where relevant, produces an audit entry — a hand edit breaks the audit chain's `hash`/`prev` and will
  be caught (loudly) by `verifyAuditChain`.

## Incident: suspected compromised agent key

1. Revoke the key (`revokedAt` in `services/plane/api-keys`) and redeploy — this stops new proposals now.
2. Pull `GET /v1/orgs/:org/wallet/decisions` for the agent's `agentName` and reconcile every `ALLOW` against
   what actually settled (the signer/settler's own logs, or the ledger if configured).
3. If a `SpendAuthorization` was issued but not yet settled, its 300 s window expires it on its own; no
   action needed beyond confirming the sweep ran (`plane: sweep failed` in logs would mean it did not).
4. Tighten or zero the agent's envelope (`PUT`, needs an approval) before minting a replacement key, so a
   fresh key does not inherit a wide-open envelope.
5. If the plane's own signing key is suspected (not the agent's API key), that is a full key-compromise
   incident: rotate `PLANE_AUTHZ_PRIVATE_KEY` immediately (old public half to
   `PLANE_AUTHZ_RETIRED_PUBLIC_KEYS` so past authorizations still verify for audit purposes, but a signer
   should refuse to accept NEW authorizations under the retired key — that check lives on the signer side).

## Local development

```bash
node platform/mesh/bin/mesh.mjs keygen --out /tmp/plane-dev    # writes ed25519.key.pem / ed25519.pub.pem
PLANE_KEY_ENV=test PLANE_CHAINS=btc:signet \
PLANE_AUTHZ_PRIVATE_KEY="$(cat /tmp/plane-dev/ed25519.key.pem)" \
PLANE_API_KEYS_JSON='[{"id":"local-agent","hash":"<sha256 of bsh_test_…>","env":"test","scopes":["wallet:propose"],"org":"scribbit","name":"dev-agent"}]' \
PLANE_APPROVERS_JSON='[{"org":"scribbit","name":"dev","publicKey":"<contents of an approver'"'"'s ed25519.pub.pem>"}]' \
pnpm --filter @bsh/plane dev
```
