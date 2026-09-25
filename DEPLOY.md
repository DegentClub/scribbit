# Deploying scribbit (platform services)

Production images for scribbit/platform's deployable Hono services:
`@bsh/scribbit-mcp`, `@bsh/scribbit-mint-api`, `@bsh/ledger`, `@bsh/signer`,
`@bsh/plane`, `@bsh/scribbit-fee-oracle`. These are the shared platform tier
that `degent`'s and `blockspace`'s services call over HTTP with a scoped
`@bsh/edge` API key (mint → signer, mint/studio → ledger, mcp → plane/ledger).

For fleet integration (NixOS hosts, DNS, CT layout), see
`/home/user/degent/docs/fleet-handoff.md`, which covers the whole estate
including these platform services.

## Prerequisites

- Docker with BuildKit.
- Build context for every `deploy/docker/*.Dockerfile` is **the repository
  root** (this repo doesn't vendor a submodule of itself -- `platform/*` and
  `products/scribbit/*` are native to this workspace).

## Building images

```bash
docker build -f deploy/docker/mcp.Dockerfile        -t scribbit-mcp:latest        .
docker build -f deploy/docker/mint-api.Dockerfile   -t scribbit-mint-api:latest   .
docker build -f deploy/docker/ledger.Dockerfile     -t scribbit-ledger:latest     .
docker build -f deploy/docker/signer.Dockerfile     -t scribbit-signer:latest     .
docker build -f deploy/docker/plane.Dockerfile      -t scribbit-plane:latest      .
docker build -f deploy/docker/fee-oracle.Dockerfile -t scribbit-fee-oracle:latest .
```

Same shape as degent's Dockerfiles: `deps` (`pnpm install --frozen-lockfile`
against the whole workspace) → `build` (`pnpm --filter <pkg> build`: `tsc
--noEmit` then an `esbuild` bundle of `src/main.ts`) → `runtime`
(`node:22-slim`, the bundle only, non-root `node` user, a `HEALTHCHECK`
against that service's health path). None of these six services has a native
dependency, so unlike degent's `atelier` none needs a separate `pnpm deploy`
step for `node_modules`.

**package.json changes**: each of the six got one additive `"build"` script;
`"start"` (`tsx src/main.ts`) was left as-is. Confirmed for every service:

```bash
pnpm --filter @bsh/scribbit-mcp build         # dist/main.js, 1.8mb
pnpm --filter @bsh/scribbit-mint-api build    # dist/main.js, 153kb
pnpm --filter @bsh/ledger build               # dist/main.js, 452kb
pnpm --filter @bsh/signer build                # dist/main.js, 439kb
pnpm --filter @bsh/plane build                 # dist/main.js, 226kb
pnpm --filter @bsh/scribbit-fee-oracle build   # dist/main.js, 132kb
```

All six typecheck and bundle with 0 esbuild warnings.

### Validation actually run in this environment

`docker build` was run end to end for **`@bsh/scribbit-fee-oracle`** (the
smallest of the six by bundle size and dependency count): built, ran on
`0.0.0.0:8080` as the non-root `node` user, and `GET /healthz` returned
`{"status":"ok","networks":["regtest"],...}` once given a fee source
(`FEE_NETWORK=regtest`, `STATIC_FEE_RATE` -- the service correctly refuses to
start with none configured, and refuses `STATIC_FEE_RATE` outside
regtest/dev). Image size: 326MB uncompressed / 79.8MB compressed.

The other five (`mcp`, `mint-api`, `ledger`, `signer`, `plane`) were not
individually `docker build`-validated in this session -- only their `pnpm
--filter ... build` script was confirmed (above). They share the exact same
Dockerfile shape as `fee-oracle` and degent's already-validated `mint`, just
with a different entry bundle and port.

Same environment caveat as degent's `DEPLOY.md`: this sandbox blocks outbound
network from inside a container build step (even proxied), so the `deps`
stage's `pnpm install --frozen-lockfile` could not be exercised inside a
container here; the build/runtime/healthcheck logic was validated against a
host-installed `node_modules` instead. Any CI runner with normal internet
egress builds these Dockerfiles as written, no special flags needed.

## Secrets

No secret values live in this repo. Real values come from the fleet's SOPS
store (see `/home/user/infrastructure` CLAUDE.md, "Secrets (SOPS)"):

| Service | Secret | SOPS path |
|---|---|---|
| signer | API key hashes (`SIGNER_API_KEYS_JSON`) | `services/signer/api-keys` |
| signer | key material (env or file provider; `SIGNER_KEY_<ID>` / `SIGNER_KEY_FILE`) | `btc-nodes/signer/keys/*` (per key id) |
| ledger | API key hashes | `services/ledger/api-keys` |
| ledger | xpub (account-level extended **public** key) | `services/ledger/xpub` |
| ledger | BTCPay API key / webhook secret | `services/ledger/btcpay/api-key`, `services/ledger/btcpay/webhook-secret` |
| ledger | card processor secret key / webhook secret | `services/ledger/card/secret-key`, `services/ledger/card/webhook-secret` |
| plane | authorization private key (Ed25519 PEM) | `services/plane/authz-private-key` |
| plane | API key hashes | `services/plane/api-keys` |
| plane | ledger API key | `services/plane/ledger-api-key` |
| mcp / mint-api | counterparty / esplora upstream keys, if any (`config.ts`) | `services/scribbit-mcp/*`, `services/scribbit-mint-api/*` |

`signer` never exposes private key material over HTTP; it only ever returns
signatures, and its bind address must stay off the public interface
(`SIGNER_KEY_PROVIDER=env` scrubs the key from `process.env` after load, and
`SIGNER_ALLOWED_PURPOSES` / `SIGNER_OUTPUT_ALLOWLIST` / `SIGNER_POLICY` gate
what it will sign). Never colocate `signer` in the same container/CT as a
public-facing service (see `docs/fleet-handoff.md`).

## Health endpoints

| Service | Path |
|---|---|
| mcp | `GET /healthz` |
| mint-api | `GET /healthz` |
| ledger | `GET /v1/health` |
| signer | `GET /v1/health` |
| plane | `GET /v1/health` |
| fee-oracle | `GET /healthz` |

## Local full-stack signet compose

There's no `deploy/compose.signet.yml` in this repo (degent's
`deploy/compose.signet.yml` is the primary signet staging entry point and
treats `signer`/`ledger` as external fleet services via `SIGNER_URL` /
`LEDGER_URL`). To run the platform tier locally alongside degent's compose
instead of pointing at the fleet, build these images and add them to a
`docker network` degent's compose can join, or extend
`/home/user/degent/deploy/compose.signet.yml` with `ledger`/`signer` services
built from `-f /home/user/scribbit/deploy/docker/{ledger,signer}.Dockerfile`
against this repo's root as build context. Not wired by default to keep each
repo's compose file self-contained and independently buildable.
