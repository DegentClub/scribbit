# @bsh/scribbit-mint-api

The edge for the scribb.it retail mint (`@bsh/scribbit-mint`). Hono + `@bsh/edge`, no storage, no keys:
a fee snapshot, an Esplora proxy (UTXOs, one transaction, broadcast) and an **allowlisted** Counterparty v2
proxy for the counters page. Contract: [`contracts/openapi/scribbit-mint-api.yaml`](../../../../contracts/openapi/scribbit-mint-api.yaml).

```bash
pnpm --filter @bsh/scribbit-mint-api test        # vitest: every route against the contract (Ajv), fake upstreams
pnpm --filter @bsh/scribbit-mint-api typecheck
MINT_NETWORK=signet CORS_ORIGINS=http://localhost:5173 CP_API_URL=https://cp.example/v2 pnpm --filter @bsh/scribbit-mint-api dev   # :3060
```

## Quickstart

Run it:

```bash
pnpm install
MINT_NETWORK=signet CORS_ORIGINS=http://localhost:5173 pnpm --filter @bsh/scribbit-mint-api dev   # :3060
curl -s localhost:3060/healthz
```

Or embed it (every upstream call goes through the injectable `fetch`):

```ts
import { createFeeOracle, staticSource } from '@bsh/scribbit-fee-oracle';
import { createApp } from '@bsh/scribbit-mint-api';

// A fake Esplora upstream; production passes nothing and the global fetch reaches the real one.
const upstream = async (url: string) =>
  url.endsWith('/utxo')
    ? Response.json([{ txid: 'ab'.repeat(32), vout: 0, value: 10_000, status: { confirmed: true, block_height: 1 } }])
    : new Response('not found', { status: 404 });

const app = createApp({
  network: 'signet',
  esploraUrl: 'https://mempool.space/signet/api',
  cpUrl: 'https://cp.example/v2',
  fees: createFeeOracle({ network: 'signet', sources: [staticSource({ targets: { 1: 3, 3: 2, 6: 1 }, minRelay: 1 })] }),
  fetch: upstream,
  corsOrigins: ['http://localhost:5173'],
});

const addr = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
console.log((await app.request(`/api/esplora/address/${addr}/utxo`)).status);  // 200: payment UTXOs
console.log((await (await app.request('/api/fees')).json()).standard);          // fee snapshot
console.log((await app.request('/api/cp/assets/XCP/issuances')).status);       // 403 cp_not_allowed: allowlist only
```

Runs as is with `tsx` (Node 22); the comments show its output.

## Routes

| Route | What | Errors |
|---|---|---|
| `GET /api/fees` | `FeesResponse` (`@bsh/scribbit-fee-oracle`; `FEE_URL` = scribbit fee server or a mempool base; default public mempool.space) | 503 `fees_unavailable` |
| `GET /api/esplora/address/{addr}/utxo` | payment UTXOs, `status` normalised | 400, 502, 504 |
| `GET /api/esplora/tx/{txid}` | one transaction (is the commit in the mempool / confirmed?) | 400, 404, 502 |
| `POST /api/esplora/tx` | broadcast (hex body) → `{ txid }` | 400 `broadcast_rejected` with the node's reason, 413 |
| `ANY /api/cp/{path}` | Counterparty proxy, allowlist below; upstream status + body pass through | 403 `cp_not_allowed`, 415, 413, 503 `cp_unavailable` |
| `GET /`, `GET /healthz` | discovery, liveness | |

**Counterparty allowlist** (`src/cp-allowlist.ts`, mirrors counters.fun's `app/api/cp/[...path]/route.ts`
cut to the mint's needs): reads `assets/{name}`, `addresses/{addr}/balances[/{asset}]`,
`addresses/{addr}/assets[/owned]`, `blocks/last`, `bitcoin/transactions/{txid}`; composes
`addresses/{addr}/compose/issuance|fairminter` (form-encoded so a file-sized `description` fits; size-limited,
8 MiB default = 4 MiB of hex); `POST bitcoin/transactions` (relay of a signed hex, validated before it leaves).
Everything else is 403 before any upstream call. Signing never passes through here.

**Edge**: request ids, uniform `{ error: { code, message, requestId } }`, security headers, exact-origin CORS
allowlist (`CORS_ORIGINS`), per-IP token bucket on every route plus a tighter one on POSTs, route-specific body
limits, bounded upstream timeouts (502 / 504).

## Configuration

See [`env.schema.json`](./env.schema.json) and [`RUNBOOK.md`](./RUNBOOK.md). One process serves one network
(`MINT_NETWORK`); the front end's `VITE_NETWORK` must match. No secrets.

## Library use

`createApp({ network, esploraUrl, cpUrl?, fees?, fetch?, corsOrigins?, ... })` returns the Hono app; every
upstream call goes through the injectable `fetch`, which is how the tests run with fake Esplora and
Counterparty upstreams and validate every response against the contract.
