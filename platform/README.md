# platform/

Shared libraries any product may depend on. Each is a workspace package `@bsh/<name>` with its own
`component.yaml` (`product: platform`).

| Component | Package | What it does |
|---|---|---|
| [`inscription`](inscription) | `@bsh/inscription` | Ordinals envelope, commit/reveal construction with `SIGHASH_SINGLE\|ANYONECANPAY`, exact weight and fee maths, FIFO sat-assignment simulator (where an inscription lands, or whether it burns to fee) |
| [`wallet-kit`](wallet-kit) | `@bsh/wallet-kit` | One browser wallet interface for UniSat, Xverse, Leather, OKX and Magic Eden |

Authoritative list: `jq '.products.platform' catalog/catalog.json`.

## Rules

- **Platform never imports products.** `pnpm lint:boundaries` rejects any `@bsh/<product>-*` import here
  (`platform-imports-product`). If product code is needed by two products, move it into platform.
- **Product-neutral APIs.** No degent/scribbit/blockspace names, URLs or business rules in platform code.
- **Stable, tested surfaces.** Everything exported from `src/index.ts` is used by several products; breaking changes
  update every dependent in the same PR (`jq '.components[] | select(.name=="inscription") | .dependents' catalog/catalog.json`).
- **Maths is proven, not asserted.** Weight and fee predictions are tested against real signed transactions.

## Adding a platform library

`cp -r templates/library platform/<name>`, set `extends` in `tsconfig.json` to `../../tsconfig.base.json`, fill in
`component.yaml` with `product: platform`, then `pnpm install && pnpm check && pnpm catalog`.
