# @bsh/mesh - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **library**. Manifest: `component.yaml` (the catalog entry in `catalog/catalog.json` is generated from it).
- Import only packages listed in `depends_on`; `pnpm lint:boundaries` fails otherwise.
- Keep the public API in `src/index.ts`; everything else is private.
- **Source of truth is the FlashyOS reference material, not memory.** Every validator here mirrors a
  vendored FlashyLabs checker rule for rule (see the header comment of each module for which file).
  Do not "improve" a rule without marking it as a scribbit extension in the README.
- Intra-package imports use the `.ts` extension (`import x from './y.ts'`) so `bin/mesh.mjs` can run the
  sources under Node 22's native type stripping with no build step and no `tsx`. Keep it that way:
  no enums, no parameter properties, no namespaces (type stripping cannot erase those).
- Verify with `pnpm --filter @bsh/mesh test` and `typecheck` before finishing, then `pnpm mesh:check`
  at the repo root (it validates `flashy/`, this repository's own published files).
