# ADR-0004: Three repositories under DegentClub, platform pinned as a submodule

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** platform team
- **Supersedes (partially):** ADR-0001 section 1 ("one pnpm workspace holds the shared platform and all product code")
- **Components:** repository layout, `@bsh/catalog-tool`, `schemas/component.schema.json`, `.github/workflows/ci.yml`

## Context

ADR-0001 put the platform and all three products in one repository. Ownership, access control and release cadence
of the products have since diverged: degent.club moves real bitcoin and has its own reviewers, block.space is at the
prototype stage, and scribb.it is where the shared platform is developed. One repository meant one set of
collaborators, one CI pipeline and one blast radius for all of it.

Everything the monorepo bought us — manifests, the catalog, boundaries, generated CODEOWNERS, one set of verbs — was
designed to be declared, not inferred (ADR-0001 §4, ADR-0003). It can therefore survive a split as long as every
repository keeps the same conventions and the catalog can still see across the boundary.

## Decision

### 1. Three repositories, one history

| Repository | Contents |
|---|---|
| `DegentClub/scribbit` (this one, "the platform repo") | `platform/*`, `tools/*`, `products/scribbit/**`, the platform-owned contracts (`contracts/asyncapi/platform-events.yaml`, `contracts/openapi/scribbit-fees.yaml`), `schemas/`, `templates/`, all ADRs |
| `DegentClub/degent` | `products/degent/**`, `contracts/openapi/degent-mint.yaml`, `contracts/asyncapi/degent-mint.yaml`, ADR-0002, plus this repository as a git submodule at `deps/scribbit` |
| `DegentClub/blockspace` | `products/blockspace/**`, `contracts/openapi/blockspace-collections.yaml`, plus this repository as a git submodule at `deps/scribbit` |

All three were created from the monorepo's git history (clone, then one split commit); nothing was rewritten, so
`git log --follow` still works for every file in every repository.

### 2. The platform is consumed as a pinned submodule, not a published package

Product repositories vendor the platform at `deps/scribbit` (branch `claude/wizardly-hypatia-5l6s56` for now, `main`
once it exists) and add `deps/scribbit/platform/*` and `deps/scribbit/tools/*` to their `pnpm-workspace.yaml`. Hence:

- `workspace:*` dependencies on `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/events`, `@bsh/edge` resolve from the
  submodule; there is no publish step and no version drift between products beyond the pinned commit.
- `@bsh/catalog-tool` also comes from the submodule, so `pnpm validate | lint:boundaries | catalog` are the same
  binary and the same rules in every repository.
- Bumping the platform is an explicit, reviewable commit:
  `git -C deps/scribbit fetch && git -C deps/scribbit checkout <commit> && pnpm install && pnpm check`.
- CI checks out with `submodules: recursive`; `pnpm test` in a product repo also runs the platform's tests at the
  pinned commit, which is the cheapest possible integration test.

### 3. External components in the catalog

The catalog tool treats a package under a **nested workspace root** (a directory between the repo root and the
package that has its own `pnpm-workspace.yaml`, i.e. `deps/scribbit`) as **external**:

- `validate` resolves its manifest-relative paths against the nested root and reports findings under an
  `external` group; outer manifests may reference platform contracts as `deps/<name>/contracts/...` (schema
  `consumes` pattern extended accordingly).
- `boundaries` checks the outer repository's `@bsh/*` imports against `depends_on` with external packages as valid
  targets, but never scans the external packages' own files — their repository lints them.
- `catalog` lists external components with `external: { repo, commit, root }` (remote URL from `.gitmodules`,
  commit from `git ls-tree HEAD deps/scribbit`) and rewrites their paths relative to the outer repository, so a
  machine can follow `repo@commit:catalog/catalog.json` to the platform catalog and join on component `name`.
- `codeowners` skips external components and the contracts they provide.

### 4. Contract ownership

**A contract lives with the component that provides it.** `degent-mint.yaml` (OpenAPI and AsyncAPI) moved with
`degent-mint`; `blockspace-collections.yaml` moved with `blockspace-certify`; `scribbit-fees.yaml` and
`platform-events.yaml` stay here. **Shared topics are owned by the platform:** the schema of every channel in
`contracts/asyncapi/platform-events.yaml` (mirrored by `platform/events/src/platform-topics.ts`) is canonical, and
a producer's own contract must stay compatible with it (same required fields, same enums). That compatibility is
asserted in the *producer's* repository against `deps/scribbit/contracts/asyncapi/platform-events.yaml`, never by
the platform reading a product's contract.

### 5. Same conventions everywhere

Every repository keeps: `component.yaml` per package validated against `schemas/component.schema.json` (copied into
product repositories; the platform's copy is the source), a committed `catalog/`, generated `.github/CODEOWNERS`
(`--org DegentClub`), the same `ci.yml` (minus the build step where no web app exists), `CLAUDE.md` / `AGENTS.md`,
and the same root `package.json` scripts.

## Alternatives considered

- **Publish `@bsh/*` to a registry and depend on versions.** Cleaner in theory, but needs a registry, a release
  process and semver discipline we do not yet have; the pinned submodule gives the same reproducibility with one
  commit hash and no infrastructure. Revisit when a third-party consumer of the platform appears.
- **Git subtree instead of submodule.** Copies history into the product repo and makes "which platform commit is
  this?" a guess. The submodule pointer is exactly the fact the catalog wants to record.
- **Keep the monorepo and use CODEOWNERS/branch protection for access.** Does not solve differing release cadence or
  the one-CI-pipeline blast radius, and GitHub permissions are per repository.

## Consequences

- A platform fix now reaches a product in two commits (platform, then the pin bump) instead of one. That is the
  intended review point.
- Product repositories cannot break the platform's tests, but a platform change can break a product's; the pin bump
  is where that surfaces, in the product's CI.
- ADR numbering stays global across the three repositories (this file reserves 0004); a product-specific decision
  lives in its product's repository with a one-line pointer here when platform code cites it (ADR-0002).
- `schemas/component.schema.json` exists in three places; the platform's is canonical and product copies are
  refreshed on pin bumps (a future catalog-tool check can enforce equality).
