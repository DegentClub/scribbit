# @bsh/scribbit-fee-oracle

Multi-source Bitcoin fee oracle for scribb.it. It polls several fee sources, rejects outliers, takes the
median per confirmation target, floors the result at the min relay rate, and caches it for a TTL. It also
prices the **block lane**: non-standard, block-sized reveals (up to 3,990,000 WU) relayed through Libre
Relay or Slipstream. You can use it as a library (the `scribbit` CLI does) or run it as a small Hono server
that implements [`contracts/openapi/scribbit-fees.yaml`](../../../../contracts/openapi/scribbit-fees.yaml).

It does not broadcast, sign or store anything. Its only state is an in-memory cache.

```bash
pnpm --filter @bsh/scribbit-fee-oracle test
pnpm --filter @bsh/scribbit-fee-oracle typecheck
FEE_NETWORK=signet MEMPOOL_URLS=https://mempool.space/signet pnpm --filter @bsh/scribbit-fee-oracle dev   # :8080
```

## Quickstart

From another package in this repository: add `"@bsh/scribbit-fee-oracle": "workspace:*"` to `dependencies` and `scribbit-fee-oracle` to `depends_on` in your `component.yaml`. (Not yet published to npm.)

```ts
import { createFeeOracle, mempoolRecommendedSource, staticSource } from '@bsh/scribbit-fee-oracle';

// Offline: two fixed readings (targets in blocks -> sat/vB). The median wins, outliers are dropped.
const oracle = createFeeOracle({
  network: 'signet',
  sources: [
    staticSource({ targets: { 1: 6, 3: 4, 6: 2 }, minRelay: 1 }, 'a'),
    staticSource({ targets: { 1: 7, 3: 5, 6: 2 }, minRelay: 1 }, 'b'),
  ],
});
const fees = await oracle.getFees();
console.log(fees.standard, fees.stale); // { slow: 2, normal: 4.5, fast: 6.5 } false

// Live: swap in real sources (every adapter takes an injectable fetch).
const live = createFeeOracle({ network: 'signet', sources: [mempoolRecommendedSource({ baseUrl: 'https://mempool.space/signet' })] });
// await live.getFees() now polls mempool.space; the server (`pnpm ... dev`) serves the same over HTTP.
```

Runs as is with `tsx` (Node 22); the comments show its output. As a server: `FEE_NETWORK=signet MEMPOOL_URLS=https://mempool.space/signet pnpm --filter @bsh/scribbit-fee-oracle dev`
(port 8080).

## Library

```ts
import { createFeeOracle, mempoolRecommendedSource, mempoolBlocksSource, esploraSource,
         bitcoindSource, blockLaneSource } from '@bsh/scribbit-fee-oracle';

const oracle = createFeeOracle({
  network: 'mainnet',
  sources: [
    mempoolRecommendedSource({ baseUrl: 'http://10.40.0.103:8999' }),       // self-hosted mempool backend
    mempoolRecommendedSource({ baseUrl: 'https://mempool.space' }),
    mempoolBlocksSource({ baseUrl: 'https://mempool.space' }),
    esploraSource({ baseUrl: 'https://blockstream.info/api' }),
    bitcoindSource({ url: 'http://10.40.0.200:8332', auth: { user, password } }),
    blockLaneSource({ url: 'http://10.40.0.227:8332', auth: { user, password } }), // Libre Relay node
  ],
  config: { minRelayFeeRate: 1, lane: { premium: 1.1, maxFeeRate: 500 } },
});
const fees = await oracle.getFees();   // FeesResponse
oracle.health();                       // SourcesHealthResponse (as of the last poll)
```

Every source adapter takes an injectable `fetch`, so tests and browsers can supply their own. To call a
remote fee server, use `feeClient({ url, network })`. It returns the same `FeeProvider` interface.

### Response shape

`FeesResponse` is a strict superset of the degent.club mint `FeesResponse`. It is replicated here rather
than imported, because products may not import each other:

```jsonc
{ "network": "mainnet", "minFeeRate": 1,
  "standard": { "slow": 1.5, "normal": 4, "fast": 6.2 },
  "block": { "min": 1, "recommended": 5.1 },
  "fetchedAt": "2026-09-23T12:00:00.000Z",
  "stale": false,                    // additive
  "sources": ["mempool:mempool.space"] }   // additive
```

## Sources

| Factory | Upstream | Contributes |
|---|---|---|
| `mempoolRecommendedSource` | `GET {base}/api/v1/fees/recommended` | targets 1/3/6/144 = fastest/halfHour/hour/economy; `minRelay` = minimumFee |
| `mempoolBlocksSource` | `GET {base}/api/v1/fees/mempool-blocks` | target N = median fee of projected block N; 144 = lowest fee in the last block; `block.recommended` = `totalFees / blockVSize` of block 1 when it is full (the displacement rate) |
| `esploraSource` | `GET {base}/fee-estimates` | exact key per target, else the nearest shorter target (the conservative choice) |
| `bitcoindSource` | JSON-RPC `estimatesmartfee` ×4 + `getmempoolinfo` | targets (BTC/kvB × 1e5); `minRelay` = max(mempoolminfee, minrelaytxfee) |
| `blockLaneSource` | Libre Relay JSON-RPC `getmempoolinfo` + `estimatesmartfee` | `block.min` = the node's relay floor; `block.recommended` = its estimate |
| `staticSource` | none | a fixed reading (regtest, dev, deliberate fallbacks) |

## Aggregation (`aggregate()`, pure)

1. For each target (1, 3, 6, 144), `minRelay`, `block.min` and `block.recommended`, collect the values from
   sources that succeeded.
2. **Outliers.** When there are 3 or more values, drop any value further from the median than
   `max(madK × 1.4826 × MAD, minRelSpread × median)` (defaults: 3 and 25 %). With only 2 values it is
   impossible to tell which one is wrong, so both are kept. Health reports rejected values per source.
3. **Median** of the values that remain. A missing target takes the value of the nearest shorter target;
   if there is none, the nearest longer one.
4. `minFeeRate = max(configured min relay (default 1), median observed floor)`. Every tier is at least
   `minFeeRate`, and `slow ≤ normal ≤ fast` is enforced. Tiers map to targets fast=1, normal=3, slow=144
   (configurable).
5. **Block lane** (`LanePolicy`): `min = max(minFeeRate, lane.minFeeRate, observed block.min)`.
   `recommended = median block.recommended` (or, if no source reports one, the `lane.recommendedTarget`
   rate) × `lane.premium`, capped at `lane.maxFeeRate`, and never below `min`.
6. All output rates are rounded **up** to 0.1 sat/vB.

`aggregate()` returns `null` when no source reported any standard target. The oracle then serves the last
aggregate with `stale: true` for up to `maxStaleMs` past its TTL. After that it throws
`FeesUnavailableError`, which the server turns into a 503.

## Cache and health

- TTL cache (default 30 s). Concurrent callers share a single in-flight fan-out.
- Each source has its own timeout (default 5 s), and its `AbortSignal` is aborted when the timeout fires.
- `health()` reports, per source: `ok`, `stale` (no success within `staleAfterMs`, default 5 min),
  last attempt and last success times, `lastError` (with credentials redacted), latency, consecutive
  failures, outliers and the last reading. Overall `status` is `ok`, `degraded` or `down`.

## Server

`createFeeServer({ oracles })` from `@bsh/scribbit-fee-oracle/server`. The library entry point never loads Hono.

| Route | |
|---|---|
| `GET /v1/fees[?network=]` | `FeesResponse`. Sent with `Cache-Control: public, max-age=10`, or `no-store` when `stale` is true. Errors: 400 unknown network, 404 network not served, 503 `fees_unavailable` |
| `GET /v1/fees/sources[?network=]` | `SourcesHealthResponse`. Polls at most once per TTL |
| `GET /healthz` | liveness |

Configuration comes from the environment and is documented in [`env.schema.json`](./env.schema.json).
One process serves one network. RPC passwords come from the secret store
(`services/scribbit-fee-oracle/*-rpc-password`).

## Tests

`test/aggregate.test.ts` covers the median, outlier, floor, monotonicity and block-lane rules, plus a
500-case property test of the invariants. `sources.test.ts` covers every adapter against recorded-shape
fixtures, including RPC auth and error bodies. `oracle.test.ts` covers the TTL, in-flight sharing, stale
serving, timeouts and health. `server.test.ts` validates every response against the OpenAPI schemas with
Ajv, round-trips `feeClient`, and checks env parsing.
