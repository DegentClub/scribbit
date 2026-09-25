# signer — runbook

Service: `@bsh/signer` (platform/signer). Contract: `contracts/openapi/signer.yaml`. Env: `env.schema.json`.
Owner: team-platform. Default port 3060, loopback bind.

## Start / verify

```bash
pnpm --filter @bsh/signer start                                   # reads env; exits 2 with a one-line reason on bad config
curl -s localhost:3060/v1/health                                  # {"status":"ok","service":"signer","network":"signet","keys":2}
curl -s -H "Authorization: Bearer $KEY" localhost:3060/v1/keys/<id>/pubkey
```

Startup log line `signer listening` lists key ids, purposes, allowed sighash types and the number of API
keys. A key id missing there means its `SIGNER_KEY_<ID>` variable was not injected.

## Secrets

| Path | What | Rotation |
|---|---|---|
| `services/signer/keys/<id>` | 32-byte hex private key, injected as `SIGNER_KEY_<ID>` | Generate the new key, add it under a NEW key id, move consumers' outputs/policies to it, retire the old id. Never reuse an id for a different key: the audit log is keyed by id |
| `services/signer/api-key-hashes` | JSON array of `@bsh/edge` records (SHA-256 hashes + scopes) | Mint with `generateApiKey('live')` from `@bsh/edge`, add the record with `scopes: ["sign:<keyId>"]`, ship the key to the consumer once, remove the old record. Revoke = set `revokedAt` |

The process scrubs `SIGNER_KEY_*` from its environment after loading; `/proc/<pid>/environ` will still
show them to root until then, so keep startup short and the host locked down.

## Alerts and what to do

| Symptom | Likely cause | Action |
|---|---|---|
| Consumers get `401 invalid_api_key` | Key revoked/expired, or `SIGNER_API_KEY_ENV` mismatch (test key on live) | Check the record in `services/signer/api-key-hashes`; check the startup log's `apiKeys` count |
| `403 insufficient_scope` | Consumer key lacks `sign:<keyId>` | Add the scope to the record; restart |
| `403 policy_denied` spike | A consumer builds PSBTs the policy forbids (new output address, fee spike) or an attacker probes | `GET /v1/audit?decision=deny` (scope `audit:read`) shows policy + reason + principal. Do NOT loosen policy to make an alert go away; fix the consumer or rotate its key |
| `422 input_mismatch` | Consumer targets the wrong input, a script-path output, or the wrong key id | Audit record has the input script; compare with `/v1/keys/<id>/pubkey` → `tweakedPublicKey` (script `5120<tweaked>`) |
| `500 key_provider_error` / `signature_invalid` | Provider failed or returned a bad signature (HSM session lost, wrong tweak handling) | Restart; for HSM providers check `login()` state. `signature_invalid` on a software provider is a bug — page platform |
| `429` | Per-key bucket (`SIGNER_RATE_LIMIT_KEY_PER_MIN`) exhausted | Legitimate burst → raise the limit for that deployment; otherwise a runaway consumer |
| Process exits 2 at start | Config error (printed) | Common: file provider on mainnet without override, key file mode not 0600, plaintext `key` in an API key record |

## degent parent co-signing

The degent mint's remote policy signer (`DegentClub/degent`, `products/degent/services/mint`, its RUNBOOK.md
§7 points here) uses this signer to co-sign the collection **parent** input of every reveal. The
`parentReturn` taproot policy (`platform/signer/README.md` "degent parent co-signing" has the full mechanics)
pins the reveal to exactly 2 inputs / 2 outputs, output 0 returning the parent's own value to its own script,
output 1 at or above P2TR dust, a fee within cap, and `SIGHASH_DEFAULT` on the parent input only — enforced by
the signer itself, so a compromised or misconfigured mint host cannot move the parent anywhere else even with
a valid API key.

**Run a dedicated signer instance for this key** (env policies apply to every key an instance serves):

| Variable | Value | Why |
|---|---|---|
| `SIGNER_NETWORK` | same as the mint's `NETWORK` | the mint's startup preflight refuses a mismatch |
| `SIGNER_KEY_PROVIDER` / `SIGNER_KEY_IDS` | `env` / `<keyId>` (e.g. `degent-parent`) | the untweaked key; `p2tr(key)` is `COLLECTION_ADDRESS` |
| `SIGNER_POLICY` | `parent-return` | selects `parentReturn` instead of the default policy set |
| `SIGNER_PARENT_RETURN_KEY_ID` | same `<keyId>` | the only key id this policy allows; any other is `key_not_covered` |
| `SIGNER_MAX_FEE_SATS` | the mint's `SIGNER_MAX_FEE_SATS` (RUNBOOK §7 there has the formula, e.g. `508725000`) | also `parentReturn`'s fee cap — the fee is paid by the user's commit input, never the parent |
| `SIGNER_ALLOWED_SIGHASH` | `0x00` | the parent is always signed SIGHASH_DEFAULT; `parentReturn` enforces this on its own too (defense in depth) even if this were left broader |
| `SIGNER_MAX_INPUT_SATS` | `PARENT_VALUE_SATS` (e.g. `10000`) | the key may only ever spend a UTXO of the parent's exact size |
| `SIGNER_OUTPUT_ALLOWLIST` | **unset** | refused together with `SIGNER_POLICY=parent-return` at config load (output 1 pays each minter and would never match) |
| `SIGNER_ALLOWED_PURPOSES` | empty | no digest signing with the parent key |
| `SIGNER_PARENT_RETURN_*` | defaults are correct for degent (`inputIndex=0`, `maxInputs=maxOutputs=2`, `minPostageSats=330`, `returnScript`=the key's own script) | override only for a deliberately different shape; see `env.schema.json` |

**Symptoms**

| Log / audit | Meaning | Action |
|---|---|---|
| `403 policy_denied` from `/v1/sign/taproot-keypath`, mint logs `policy signer refused` with `stage: remote` | `parentReturn` refused a reveal the mint's own `evaluateParentPolicy` accepted: a policy MISMATCH between the two, or an attempted parent-drain from a compromised mint host | `GET /v1/audit?decision=deny&keyId=<keyId>` — `denialCode` names the exact deviation (`parent_return_script_mismatch`, `parent_return_value_mismatch`, `too_many_outputs`, `postage_below_dust`, `fee_above_cap`, `input_index_not_allowed`, …). Compare against the mint's `PolicyConfig` / `COLLECTION_ADDRESS` / `PARENT_VALUE_SATS`; do NOT loosen `parentReturn` to make it pass — fix the mint config or treat as a compromise (see "Incident: suspected key compromise" above) |
| Every reveal denied right after a parent rotation | `returnScript` defaults to the key's own script; if `SIGNER_KEY_IDS` was rotated to a new key without updating the mint's `COLLECTION_ADDRESS` to match, output 0 will never match | Follow the mint's parent-rotation runbook (its RUNBOOK.md §2) in lock-step with this key's rotation |
| `denialCode: key_not_covered` | Wrong `keyId` in the request, or this instance is (misconfigured to be) shared with another key | Check the mint's `SIGNER_KEY_ID` matches `SIGNER_PARENT_RETURN_KEY_ID` exactly |

## Audit

Every decision is a JSON line on stdout (`msg: "signer.audit"`) and in the in-memory ring served by
`GET /v1/audit`. Ship stdout to the log pipeline; the ring is lost on restart. Records never contain key
material, PSBT bodies or signatures. To reconstruct what was signed: `details.digest` (BIP341 sighash),
`details.txid` (when finalized), `details.outputs`, `details.fee`, `principal`, `requestId`. Denials from a
policy that supplies one also carry `denialCode` (a stable machine code, e.g. `fee_above_cap`) — filter or
alert on it instead of parsing `reason` text; it is an open set (`contracts/openapi/signer.yaml`
`x-extensible-enum`), so tolerate codes not yet in that list.

## Incident: suspected key compromise

1. Revoke every API key with `sign:<keyId>` (set `revokedAt`) and restart — this stops new signatures now.
2. Sweep funds controlled by the key's P2TR output to a fresh key (build the PSBT, sign it through the
   signer with a temporary `outputAllowlist` of the new address only, then remove the old key id).
3. Pull the audit log for the key id and reconcile every `allow` against chain/indexer state.
4. Rotate under a new key id; never re-add the old one.

## Local development

```bash
cat > /tmp/signer-keys.json <<'EOF'
{ "keys": [ { "id": "dev", "privateKeyHex": "<64 hex>" } ] }
EOF
chmod 600 /tmp/signer-keys.json
SIGNER_NETWORK=signet SIGNER_KEY_PROVIDER=file SIGNER_KEY_FILE=/tmp/signer-keys.json \
SIGNER_ALLOWED_PURPOSES=blockspace.certify SIGNER_API_KEY_ENV=test \
SIGNER_API_KEYS_JSON='[{"id":"local","hash":"<sha256 of bsh_test_…>","env":"test","scopes":["sign:dev","keys:read","audit:read"]}]' \
pnpm --filter @bsh/signer dev
```
