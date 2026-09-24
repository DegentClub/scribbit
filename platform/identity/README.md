# @bsh/identity

**Blockspace ID** primitives: one account across every product, signed in with a Bitcoin wallet.
Pure TypeScript (`Uint8Array`, no `Buffer`, no network), so the same code runs in browsers,
services and tests. Built on `@noble/curves` 2, `@noble/hashes` 2 and `@scure/btc-signer` 2.

| Module | What it gives you |
|---|---|
| SIWB (`createChallenge`, `issueChallenge`, `verifySignIn`, `parseSiwbMessage`) | EIP-4361-style "Sign in with Bitcoin" challenge text, strict parser, full verification |
| BIP-322 (`verifyBip322Simple`, `signBip322Simple`, `bip322Sighash*`) | BIP-322 *simple* signatures for P2TR (key path) and P2WPKH |
| Legacy (`verifyLegacyMessage`, `signLegacyMessage`) | Bitcoin Core `signmessage` / BIP-137 (P2PKH, P2WPKH, P2SH-P2WPKH) |
| Nonces (`NonceStore`, `InMemoryNonceStore`) | Server-issued, single-use, expiring nonces (replay protection) |
| Sessions (`issueSession`, `verifySession`, `SessionKeyRing`) | Compact JWS, EdDSA/Ed25519, `iss/aud/exp/iat/jti`, `kid` rotation, JWKS |
| Model (`BlockspaceIdentity`, `LinkedWallet`, `linkWallet`) | Account-linking types |

## Quickstart

Inside this workspace, or a product repository that pins `deps/scribbit`: add `"@bsh/identity": "workspace:*"` to `dependencies` and `identity` to `depends_on` in your `component.yaml`. (Not yet published to npm.)
The example also uses `@scure/btc-signer` and `@noble/curves` to stand in for the user's wallet.

```ts
import { getAddress } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { InMemoryNonceStore, SessionKeyRing, generateSigningKey, issueChallenge, signBip322Simple, verifySignIn } from '@bsh/identity';

// A throwaway wallet key, standing in for the user's wallet (which does the signing in real life).
const priv = schnorr.utils.randomSecretKey();
const address = getAddress('tr', priv)!; // bc1p...

// Server: issue a single-use challenge bound to domain + address.
const nonces = new InMemoryNonceStore(); // production: a Redis/Postgres NonceStore
const { message } = await issueChallenge(nonces, { domain: 'id.example.com', address, network: 'mainnet', ttlSeconds: 300 });

// Wallet: BIP-322 simple signature over the exact challenge text.
const signature = signBip322Simple(priv, 'p2tr', message);

// Server: verify (domain, nonce, expiry, signature), then issue a session token.
const r = await verifySignIn({ message, signature, address }, { domain: 'id.example.com', nonces, network: 'mainnet' });
if (!r.ok) throw new Error(r.error);
const keys = new SessionKeyRing(generateSigningKey('k1')); // production: the key comes from the secret store
const token = keys.issue({ sub: r.address, accounts: [r.address], product: 'console', scopes: ['profile'] });
console.log(r.ok, keys.verify(token, { audience: 'console' }).sub === address); // true true

// A replayed signature is refused: the nonce was consumed.
console.log((await verifySignIn({ message, signature, address }, { domain: 'id.example.com', nonces, network: 'mainnet' })).ok); // false
```

Runs as is with `tsx` (Node 22); the comments show its output.

## Sign-in flow

```ts
import { InMemoryNonceStore, issueChallenge, verifySignIn, SessionKeyRing } from '@bsh/identity';

const nonces = new InMemoryNonceStore();              // production: Redis/Postgres adapter
const keys = new SessionKeyRing(activeKeyFromSecretStore);

// 1. GET /siwb/challenge?address=bc1p...
const { message } = await issueChallenge(nonces, {
  domain: 'id.example.com', address, network: 'mainnet', ttlSeconds: 300,
});
// 2. wallet.signMessage(message)  (BIP-322 simple, or legacy for P2PKH/P2WPKH wallets)
// 3. POST /siwb/verify {message, signature, address}
const r = await verifySignIn({ message, signature, address }, { domain: 'id.example.com', nonces, network: 'mainnet' });
if (!r.ok) return c.json({ error: { code: r.error } }, 401);  // log r.detail, don't show it
// 4. Issue a session for a product (aud = product)
const token = keys.issue({ sub: r.address, accounts: [r.address], product: 'console', scopes: ['profile'] });
// 5. Anywhere else: keys.verify(token, { audience: 'console' })  or  verifySession(token, jwksKeys, {...})
```

### Message format

```
id.example.com wants you to sign in with your Bitcoin account:
bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3

Sign in with your Bitcoin wallet. This request will not trigger a transaction or cost any fees.

URI: https://id.example.com
Version: 1
Network: mainnet
Nonce: 5f2a9c0e41d7b3a86e1f0c2d9b4a7e63
Issued At: 2026-09-23T12:00:00.000Z
Expiration Time: 2026-09-23T12:05:00.000Z
[Not Before: …]
[Request ID: …]
[Resources:
- https://…]
```

`parseSiwbMessage` re-serialises the parsed fields and rejects anything that is not byte-identical
(CRLF, trailing whitespace, reordered or extra lines, non-canonical timestamps).

## `verifySignIn` checks (in order)

1. Grammar / canonical form → `malformed_message`
2. `domain` is one of the server's domains (exact) → `domain_mismatch`
3. Claimed `address` equals the message's address → `address_mismatch`
4. Optional expected network; address decodes on the message's network → `network_mismatch` / `invalid_address`
5. `issuedAt` / `notBefore` (±`clockSkewSeconds`, default 60) and `expirationTime` (no leeway) → `not_yet_valid` / `expired`
6. Signature: 65-byte header 27..42 → legacy; otherwise BIP-322 simple witness → `invalid_signature`
7. Nonce consumed atomically, bound to domain + address → `nonce_unknown` / `nonce_replayed`

The nonce is consumed **after** the signature verifies, so an observer who sees a challenge cannot
burn it. `verifySignIn` never throws on hostile input.

## BIP-322 implementation notes

- `to_spend` / `to_sign` are serialised byte-by-byte (`bip322VirtualTxids`), message hash is
  `tagged_hash("BIP0322-signed-message", m)`.
- P2TR: exactly one witness element (key path); 64-byte sig = `SIGHASH_DEFAULT`, 65-byte must end in
  `0x01` (`SIGHASH_ALL`). BIP341 sighash with `spend_type = 0`; Schnorr-verified against the
  **output (tweaked) key** in the scriptPubKey. Annex and script-path spends are rejected.
- P2WPKH: witness `[DER sig || 0x01, 33-byte compressed pubkey]`, `hash160(pubkey)` must equal the
  program, BIP143 digest, low-S enforced (standard policy).
- Only the *simple* format is supported (not *full* / proof-of-funds). P2WSH / P2SH-multisig
  addresses are rejected up front.
- Legacy: a P2TR address never accepts a legacy ECDSA signature (the internal key does not prove
  control of the tweaked output key).

Tests use the BIP-322 published vectors (message hashes, `to_spend`/`to_sign` txids, P2WPKH
signatures for `""` and `"Hello World"`, the P2TR `"Hello World"` signature) and cross-check both
sighash digests against `@scure/btc-signer`'s `preimageWitnessV0` / `preimageWitnessV1`.

## Sessions

- Header `{"alg":"EdDSA","typ":"JWT","kid":…}`; claims `iss, aud, sub, accounts, product, scopes, iat, exp, jti` (+ optional `nbf`).
- `verifySession` pins `alg = EdDSA` (rejects `none`, HS*), rejects `crit`, selects the key strictly
  by `kid`, uses strict RFC 8032 verification (`zip215: false`), checks `exp`/`nbf`/`iat` (leeway
  30 s), issuer, audience and `requiredScopes`. Errors are `SessionError` with a stable `code`.
- Rotation: `SessionKeyRing.rotate(next, { retireAt })` signs with the new key while the old one
  keeps verifying (optionally only tokens issued before `retireAt`); `revoke(kid)` drops it.
  `jwks()` publishes public keys (RFC 8037 OKP JWKs). Verified against the RFC 8037 A.4 vector.
- Tokens are bearer credentials: ship them in `Authorization` or an `HttpOnly; Secure; SameSite`
  cookie, keep TTLs short, and use `jti` for revocation lists if a product needs them.

## Security notes

- Services never hold user keys (monorepo rule 6). `signBip322Simple` / `signLegacyMessage` exist
  for tests, regtest tooling and CLIs only.
- Secret key material for sessions comes from the secret store (path, not value, in manifests).
- `InMemoryNonceStore` is single-process. A production adapter must make `consume` atomic and
  bind it to domain + address (Redis Lua / `UPDATE … WHERE used_at IS NULL RETURNING`).
- Challenge TTL is capped at 1 hour; use minutes.

```bash
pnpm --filter @bsh/identity test
pnpm --filter @bsh/identity typecheck
```
