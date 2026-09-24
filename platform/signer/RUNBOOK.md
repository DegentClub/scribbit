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

## Audit

Every decision is a JSON line on stdout (`msg: "signer.audit"`) and in the in-memory ring served by
`GET /v1/audit`. Ship stdout to the log pipeline; the ring is lost on restart. Records never contain key
material, PSBT bodies or signatures. To reconstruct what was signed: `details.digest` (BIP341 sighash),
`details.txid` (when finalized), `details.outputs`, `details.fee`, `principal`, `requestId`.

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
