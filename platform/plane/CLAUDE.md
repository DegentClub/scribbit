# @bsh/plane - agent notes

Read the root `CLAUDE.md` first, then ADR-0014. Local rules:

- Kind: **service**. Manifest: `component.yaml`. Contract: `contracts/openapi/plane.yaml` - change it first.
- Import only packages listed in `depends_on` (`@bsh/edge`, `@bsh/mesh`); `pnpm lint:boundaries` fails otherwise.
- **Source of truth is FlashyOS's published wallet material** (`flashyos-wdk` `docs/wallet/spec.md`,
  `openapi.wallet.json`, `schema/*.json`; vendored schemas under `test/fixtures/flashyos-wdk`). Field names, codes
  and the order of the five checks are theirs; anything else is marked "ours" in the code and the README.
- `decide()` is the policy. The order of its checks is load-bearing and tested; do not reorder.
- Money is `bigint` inside, decimal strings on the wire. Never `Number` an amount.
- Intra-package imports use the `.ts` extension, like `@bsh/mesh`.
- Verify with `pnpm --filter @bsh/plane test` and `typecheck`.
