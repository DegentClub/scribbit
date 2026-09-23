# scribbit: the platform repo

The shared platform of Blockspace Holdings and the **scribb.it** product, in one pnpm workspace. The other two
products live in their own repositories and consume this one as a pinned git submodule at `deps/scribbit`
([ADR-0004](docs/adr/0004-repo-split.md)):

| Repository | Slug | Verb | What it is |
|---|---|---|---|
| **DegentClub/scribbit** (this repo) | `platform`, `scribbit`, `tooling` | write | Shared libraries (`@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/events`, `@bsh/edge`, `@bsh/identity`, `@bsh/notify`), the catalog tool, and [scribb.it](products/scribbit/README.md): inscription engine, fee oracle, CLI |
| [DegentClub/degent](https://github.com/DegentClub/degent) | `degent` | own | degent.club: the Decentralized Gentlemen Club collection and its automated, non-custodial mint |
| [DegentClub/blockspace](https://github.com/DegentClub/blockspace) | `blockspace` | measure | block.space: block-space explorer, fee Meter, portfolio, data API, certification |

Humans start here; agents start at [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md). Infrastructure (the Nix
fleet), chain nodes, data pipelines and forks live in separate repositories; see
[ADR-0001](docs/adr/0001-monorepo-structure.md).

## Quickstart

```bash
corepack enable                 # pnpm version comes from package.json "packageManager"
pnpm install
pnpm check                      # validate manifests + boundaries + typecheck + tests (what CI runs)
pnpm --filter @bsh/scribbit-cli dev    # the scribbit developer CLI
```

Every package answers to the same verbs: `pnpm --filter <pkg> test | typecheck | build | dev`.
New component: copy a skeleton from [`templates/`](templates/README.md).

## Layout

```
platform/<name>/                   shared libraries (@bsh/<name>), used by every product repo
products/scribbit/apps/<name>/     scribb.it front ends and CLIs
products/scribbit/services/<name>/ scribb.it back ends
products/scribbit/packages/<name>/ scribb.it-private libraries
contracts/{openapi,asyncapi,schemas}/  platform- and scribbit-owned contracts (shared topics live here)
tools/catalog/                     manifest validator, boundary linter, catalog generator (also used by product repos)
catalog/                           GENERATED catalog.json + CATALOG.md
templates/                         copyable component skeletons (not workspace packages)
docs/adr/                          architecture decision records (global numbering across the three repos)
schemas/component.schema.json      the component manifest schema (canonical copy; product repos carry a copy)
```

## How the product repos use this one

`DegentClub/degent` and `DegentClub/blockspace` add this repository as a submodule at `deps/scribbit` and list
`deps/scribbit/platform/*` and `deps/scribbit/tools/*` in their `pnpm-workspace.yaml`, so `workspace:*` dependencies
on `@bsh/*` platform packages and the catalog tool resolve from the pinned commit. The catalog tool treats those
packages as **external** components (`external: { repo, commit, root }` in their `catalog.json`), so a machine can
follow the link back to this repository's catalog. To bump a product to a newer platform commit:

```bash
git -C deps/scribbit fetch && git -C deps/scribbit checkout <commit> && pnpm install && pnpm check
```

**Contract ownership:** a contract lives with the component that provides it. Shared event topics
(`contracts/asyncapi/platform-events.yaml`, mirrored by `platform/events/src/platform-topics.ts`) are owned by the
platform; a product's own contract for a shared topic must stay compatible and asserts that in the product repo.

## The machine-readability model

The repository is built so CI, AI agents and the infra Fleet API can understand it **without reading code**.
Four layers, each checked in CI:

1. **Manifests.** Every workspace package has a `component.yaml` next to its `package.json`: name, kind, product,
   owner, lifecycle, `depends_on`, contracts it `provides`/`consumes`, stores, secret *paths*, SLO, runbook.
   Schema: [`schemas/component.schema.json`](schemas/component.schema.json). `pnpm validate` checks each manifest
   against the schema, against its `package.json`, and that every file it points at exists.
2. **Catalog.** `pnpm catalog` compiles all manifests into [`catalog/catalog.json`](catalog/catalog.json)
   (components with dependents, products, contracts with providers/consumers, a dependency edge list) and a human
   table in [`catalog/CATALOG.md`](catalog/CATALOG.md). It is committed; `pnpm catalog --check` fails CI when stale.
   `.github/CODEOWNERS` is generated from the same owners.
3. **Boundaries.** `pnpm lint:boundaries` parses every import. A component may import only the `@bsh/*` packages in
   its `depends_on`; products never import each other; `platform/` never imports `products/`; relative imports
   never leave the package. Findings are `file:line` with a stable rule id.
4. **Contracts.** Products talk to each other only through versioned OpenAPI / AsyncAPI / JSON Schema files in
   [`contracts/`](contracts/README.md). Contract first, then code; breaking changes are gated by `oasdiff`.

Design and rationale: [ADR-0001](docs/adr/0001-monorepo-structure.md) (structure),
[ADR-0003](docs/adr/0003-machine-readable-catalog.md) (manifests, catalog, and the join with the infra Fleet API)
and [ADR-0004](docs/adr/0004-repo-split.md) (the three-repository split and external components).
All decisions: [`docs/adr/`](docs/adr/README.md).
