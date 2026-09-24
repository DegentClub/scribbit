# scribbit: the platform repo

This repository holds the **shared platform** of Blockspace Holdings and the **scribb.it** product (write). The
other two products, **degent.club** (own, `DegentClub/degent`) and **block.space** (measure, `DegentClub/blockspace`),
live in their own repositories and consume this one as a git submodule pinned to a commit at `deps/scribbit`
(ADR-0004). Read this page first. It is deliberately short; each product and package has its own
`CLAUDE.md` / `README.md` with local detail.

## Map

| Path | What lives there |
|---|---|
| `platform/` | Shared libraries every product may use (`@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/events`, `@bsh/edge`, …). **Changing them changes the product repos at their next pin bump** |
| `products/scribbit/apps/` | Deployable scribb.it front ends and CLIs |
| `products/scribbit/services/` | Deployable scribb.it back-end services |
| `products/scribbit/packages/` | Libraries private to scribb.it |
| `contracts/` | Platform- and scribbit-owned OpenAPI / AsyncAPI / JSON Schema. Shared event topics are owned here. **The only allowed coupling between products** |
| `tools/` | Repo tooling: catalog generator, boundary linter (also run, from the submodule, by the product repos) |
| `catalog/catalog.json` | GENERATED index of every component (`pnpm catalog`). Query this before grepping |
| `docs/adr/` | Architecture decisions. Numbered globally across the three repos, never edited after acceptance (supersede instead) |
| `schemas/component.schema.json` | The manifest schema every component must satisfy. Canonical copy; product repos carry a copy |

Product slugs are fixed and used identically everywhere (folders, `product:` fields, tags):
`platform`, `blockspace`, `scribbit`, `degent`, `tooling`. Only `platform`, `scribbit` and `tooling` have code here.

## Rules

1. **Every workspace package has a `component.yaml`** that validates against
   `schemas/component.schema.json`. CI fails otherwise (`pnpm validate`).
2. **Imports follow declared dependencies.** A component may import another `@bsh/*` package only
   if it is listed in its `depends_on`. `platform/*` never imports `products/*`. Enforced by `pnpm lint:boundaries`.
3. **Cross-product traffic goes through `contracts/`.** Change the contract first, then the code. A contract lives
   with the component that provides it; the shared topics in `contracts/asyncapi/platform-events.yaml` (mirrored
   by `platform/events/src/platform-topics.ts`) are canonical and owned by the platform. Never read a product
   repo's contract from a platform test; the product asserts compatibility on its side.
4. **Same verbs everywhere:** `pnpm --filter <pkg> test | typecheck | build | dev`.
   `pnpm check` runs everything CI runs.
5. **No secrets in the repo.** Manifests list secret *paths*; values come from the secret store.
6. **Money paths are non-custodial by default.** Libraries never hold a user's private key. The signing model is
   decided in ADR-0002 (lives in `DegentClub/degent`; `docs/adr/0002-degent-mint-architecture.md` here is a pointer).
7. **Tests are the spec.** New behaviour ships with tests; fee/size maths ships with property-style tests that
   compare predictions against real signed transactions.
8. **Platform changes are consumed by pin bumps.** After changing `platform/*` or `tools/*`, the product repos need
   `git -C deps/scribbit fetch && git -C deps/scribbit checkout <commit> && pnpm install && pnpm check`; keep
   breaking changes rare and say so in the commit body.

## Common tasks

```bash
pnpm install                 # once
pnpm check                   # validate manifests + boundaries + typecheck + tests (what CI runs)
pnpm catalog                 # regenerate catalog/catalog.json
pnpm readiness               # open-source readiness gate (LICENSE, community files, package READMEs); part of check
pnpm --filter @bsh/catalog-tool run codeowners --org DegentClub   # regenerate .github/CODEOWNERS
pnpm --filter @bsh/scribbit-cli dev      # the scribbit developer CLI
```

## Adding a component

Copy `templates/library` (or `service`, `app`), rename, fill in `component.yaml`, run `pnpm check`.
