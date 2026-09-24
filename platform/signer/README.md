# @bsh/signer

A remote, **policy-constrained signing service** so product services never hold signing keys in-process.
A consumer (blockspace-certify, the degent parent signer, a scribbit batch relay) sends a PSBT or a
digest; the signer checks what it is being asked to sign, applies policy, signs behind a `KeyProvider`
port, and writes an audit record. The port is the path to an HSM: nothing above it ever sees a key.

```
consumer service ──RemoteSignerClient──► @bsh/signer (Hono + @bsh/edge)
                                            │  inspect PSBT / digest
                                            │  Policy.inspect()  → allow | deny (audited)
                                            │  KeyProvider.sign(keyId, msg32)   ← File | Env | HSM
                                            └  verify signature → audit → respond
```

## Library

| Export | What |
|---|---|
| `Signer({ keys, audit, allowedPurposes, taprootPolicies?, digestPolicies?, allowedSighashTypes?, network? })` | `signTaprootKeyPath(req, ctx)`, `signSchnorrDigest(req, ctx)`, `publicKey(keyId)`, `keyIds()` |
| `Policy<TReq>` | `{ name, inspect(request) → { allow: true } \| { allow: false, reason } }` (sync or async). Built-ins: `allOf`, `allowAll`, `denyAll`, `allowedSighashTypes`, `maxInputValue`, `maxFee`, `outputAllowlist`, `purposeAllowlist`, `principalAllowlist` |
| `TaprootKeyPathInspection` | What a taproot policy sees: `keyId, inputIndex, sighashType, input{txid,vout,amount,script}, inputs[], outputs[{amount,script,address?}], version, lockTime, fee, principal` |
| `SchnorrDigestInspection` | `keyId, purpose, digest32, principal` |
| `KeyProvider` | `publicKey(keyId) → x-only 32 bytes`, `sign(keyId, msg32, { tweak?: 'bip341', merkleRoot? }) → 64-byte BIP340`, `keyIds()` |
| `InMemoryKeyProvider`, `FileKeyProvider.fromFile(path)`, `EnvKeyProvider.fromEnv(env, keyIds)` | Software providers (noble-curves). File: **dev only**, refuses anything but mode 0600/0400 owned by the process user. Env: `SIGNER_KEY_<ID>`, scrubbed after load |
| `HsmKeyProvider` (interface) | `init()`, `login({ pin } \| { attestation })`, `sign`, `close()`, `mechanism`, `tweakedInHardware` — see "HSM path" |
| `AuditLog`, `InMemoryAuditLog`, `JsonLinesAuditLog`, `MultiAuditLog`, `AuditRecord` | Structured decisions: allow / deny / error, with facts and never key material |
| `inspectTaprootKeyPath(psbtBase64, inputIndex, xOnlyKey, network)`, `attachKeyPathSignature` | The PSBT checks + BIP341 sighash, usable standalone |
| `createSignerApp({ signer, keys, keyEnv, auditLog, rateLimit, trustedProxies })` | The Hono service |
| `RemoteSignerClient({ baseUrl, apiKey, fetch?, timeoutMs?, retries? })` | Consumer client: `signTaprootKeyPath`, `signSchnorrDigest`, `publicKey`, `health` |
| `SignerError(code)` / `RemoteSignerError(code, status)` | `invalid_request`, `psbt_invalid`, `unknown_key`, `input_mismatch`, `already_signed`, `policy_denied`, `key_provider_error`, `signature_invalid`; client adds `network_error`, `bad_response` |

```ts
import { Signer, InMemoryAuditLog, EnvKeyProvider, maxFee, outputAllowlist } from '@bsh/signer';

const signer = new Signer({
  keys: EnvKeyProvider.fromEnv(process.env, ['scribbit-parent']),
  audit: new InMemoryAuditLog(),
  allowedPurposes: ['blockspace.certify'],
  taprootPolicies: [maxFee(50_000n), outputAllowlist([collectionAddress, treasuryAddress])],
  network: 'signet',
});
const { psbtBase64, signature, txid } = await signer.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'scribbit-parent', finalize: true });
```

### What `signTaprootKeyPath` checks before it signs

1. The PSBT parses (btc-signer, which itself refuses inconsistent taproot commitments).
2. Every input carries `witnessUtxo` or `nonWitnessUtxo` — BIP341 commits to all prevouts, so the
   signer cannot compute a sighash otherwise, and will not trust one the caller computed.
3. Input `inputIndex` pays exactly `p2tr(xOnly(keyId))`: the key-path-only output of the key's
   **untweaked** public key. A matching script with a different `tapInternalKey`, any `tapMerkleRoot`
   or `tapLeafScript` (script-path material) is rejected with `input_mismatch` — the signer only ever
   makes key-path signatures.
4. The input is not already signed (`already_signed`).
5. `sighashType` comes from the PSBT input (`0x00` = DEFAULT when absent) and must be allowed by
   policy (`allowedSighashTypes`, default DEFAULT + ALL; ANYONECANPAY variants are opt-in per deployment).
6. The BIP341 digest is computed by `Transaction.preimageWitnessV1`; the tests re-derive it from the
   BIP text independently and cross-check that btc-signer's own `signIdx` output verifies against it.
7. Policies see the normalised view (prevouts, outputs with addresses, fee). First denial wins.
8. The provider signs with the **tweaked** key; the result is verified against the output key before
   it is attached (a provider that ignores the tweak yields `signature_invalid`, not a broken PSBT).

`signSchnorrDigest` signs the raw digest with the untweaked key, only for `purpose`s on the allowlist. The
signer never hashes for the caller: each purpose owns its domain-separated preimage (`blockspace.certify`
= tagged hash of the certification payload, defined by that service's contract), so a digest for one purpose
can never be a valid message for another.

## Service

```bash
pnpm --filter @bsh/signer dev          # env in env.schema.json; contract in contracts/openapi/signer.yaml
curl -s localhost:3060/v1/health
curl -s -H "Authorization: Bearer bsh_live_…" localhost:3060/v1/keys/scribbit-parent/pubkey
```

| Route | Scope | Notes |
|---|---|---|
| `POST /v1/sign/taproot-keypath` | `sign:<keyId>` | body `{ psbtBase64, inputIndex, keyId, finalize? }` |
| `POST /v1/sign/digest` | `sign:<keyId>` | body `{ keyId, digest32, purpose }` |
| `GET /v1/keys/:id/pubkey` | `keys:read` or `sign:<id>` | x-only + tweaked (P2TR output) key |
| `GET /v1/health` | none | |
| `GET /v1/audit?keyId&decision&principal&limit` | `audit:read` | in-memory ring; JSONL to stdout is the durable copy |

Edge stack: request ids, uniform JSON errors, security headers, per-IP and per-API-key token buckets
(`/v1/sign/*`), 256 KiB body limit, API keys with per-key scopes, optional `trustProxy`. Policy denials are
`403 policy_denied` and are audited with the policy name; scope failures are `403 insufficient_scope` and
never reach the signer.

### Transport: put mTLS in front

API keys identify the *application* (for scopes and audit); they are not the network perimeter. Deploy the
signer on a private network (fleet-internal VLAN / tailnet) and terminate **mutual TLS** in the ingress
(Caddy `client_auth` with the fleet CA, or a service mesh) so only enrolled consumer identities can open a
connection at all. `HOST` defaults to loopback. `RemoteSignerClient` takes an injected `fetch`, so a consumer
passes one bound to its client certificate (`undici.Agent({ connect: { cert, key, ca } })`).

### Client semantics

`RemoteSignerClient` has a per-attempt timeout (default 10 s) and retries **only network-level failures**
(connection refused/reset, DNS, timeout) — a response of any status is final. A `403 policy_denied` is a
decision, and a 5xx may already have produced an audit record; retrying either blindly would be a bug. Check
`RemoteSignerError.isDenial` and surface the reason to an operator instead.

## Threat model

**What the signer can do.** Produce key-path signatures for inputs that pay a key it holds, for the
hash types and outputs its policies allow; produce attestation signatures for allowlisted purposes. Every
one of those actions is attributable (API key id, request id, timestamp, what was signed).

**What it cannot do, by construction.**

- *Sign something it did not inspect.* It never accepts a caller-supplied sighash for the taproot path,
  never signs script paths, never signs an input whose script it did not derive itself.
- *Move funds a policy forbids.* `maxInputValue`, `maxFee`, `outputAllowlist` and custom policies run before
  the key is touched; a denial cannot be retried into an allow.
- *Cross purposes.* A digest signed for `blockspace.certify` cannot be replayed as a transaction sighash: the
  taproot path uses the tweaked key and its own BIP341 tagged hash; the digest path uses the untweaked key
  and only purposes on the allowlist. Purposes must be domain-separated by their owners.
- *Leak keys through the API or logs.* No route returns key material; audit records carry digests, txids,
  addresses and amounts only. Config refuses plaintext API keys and world-readable key files.

**What it does not protect against.** A compromised consumer with a valid `sign:<keyId>` key can request
any signature that policy allows — policies are the blast-radius control, so make them tight per key (a
parent-inscription key gets `outputAllowlist` of the collection address; a certify key gets purposes only).
A compromised signer host with software providers exposes the keys — that is what the HSM path removes.
The service does not rate-limit by amount over time (a `maxSpendPerWindow` policy backed by the audit log is
the obvious next step) and does not verify that a PSBT's prevouts exist on chain (a policy can query an
indexer; the sighash is still correct either way, and a fabricated prevout yields an unbroadcastable tx).

## HSM path

`KeyProvider` is the whole surface: swap `EnvKeyProvider` for an `HsmKeyProvider` and nothing else changes.
The interface is PKCS#11-shaped (`init` → `login` → `sign` → `close`) and documents the two constraints
that decide the vendor:

1. **BIP340 Schnorr in hardware.** Generic PKCS#11 offers ECDSA only. Options: modules with a Schnorr
   mechanism (Securosys `CKM_SCHNORR`, Thales Luna BIP340 extension, Fortanix DSM, AWS CloudHSM custom
   mechanism), a measured enclave (Nitro/SEV) running noble-curves behind this interface, or MuSig2/FROST
   with the HSM holding a share.
2. **The taproot tweak.** An HSM cannot add a scalar to a stored key. Either generate the key already tweaked
   in hardware (`tweakedInHardware` set; `publicKey()` still returns the untweaked x-only key from metadata so
   script derivation works), or use a module with a tweak-on-sign mechanism. Never export a key to tweak it in
   software.

Until then, `EnvKeyProvider` fed from the secret store on a locked-down host is the production shape; the
file provider exists for local development and refuses mainnet without an explicit override.

## Develop

```bash
pnpm --filter @bsh/signer test        # policy, sighash (independent BIP341 impl + btc-signer cross-check), PSBT rejections, API auth/scopes, audit, client retries
pnpm --filter @bsh/signer typecheck
```
