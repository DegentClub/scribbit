# ADR-0003: Machine-readable component catalog

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** platform team
- **Components:** `@bsh/catalog-tool`, `schemas/component.schema.json`, `catalog/catalog.json`, `.github/CODEOWNERS`
- **Related:** ADR-0001 (monorepo structure); `infra` ADR-098 (Fleet API / fleet MCP)

## Context

ADR-0001 commits us to a monorepo that machines (CI, AI agents, the infra Fleet API) can understand without reading
code. Three questions come up constantly and today need code archaeology:

1. *What exists?* Components, their kind, owner, lifecycle, where they live, how to run them.
2. *What depends on what?* Package edges, contract providers and consumers, event channels.
3. *Where does it run and how do I reach it?* Answered in the `infra` repository by the Fleet API
   (`fleet-mcp.internal.example`, tools `fleet_services` / `fleet_get`), generated from the Nix fleet manifest.

The first two belong to this repository; the third belongs to `infra`. They should join on a stable key instead
of each re-deriving the other.

## Decision

### 1. One manifest per component

Every workspace package has `component.yaml` beside `package.json`, validated by
`schemas/component.schema.json` (JSON Schema 2020-12):

| Field | Purpose |
|---|---|
| `name` | Kebab-case, unique across the estate. **The join key** with the fleet catalog |
| `package` | npm name, must equal `package.json` `name` |
| `kind` | `library`, `service`, `app`, `indexer`, `job`, `tool` |
| `product` | `platform`, `blockspace`, `scribbit`, `degent`, `tooling`; must match the folder |
| `owner` | `team-*`; generates CODEOWNERS |
| `summary`, `lifecycle` | One sentence for agents; `experimental` to `deprecated` |
| `depends_on` | `@bsh/*` packages this component may import; mirrors `package.json` both ways |
| `provides` / `consumes` | Contract files under `contracts/` (optional `#fragment`), or `events:<channel>` |
| `stores`, `secrets` | `postgres:<db>` etc.; secret **paths** (SOPS/Infisical), never values |
| `env_schema`, `runbook`, `docs` | Component-relative files that must exist |
| `slo`, `commands` | Availability / p95 target; standard verbs mapped to package scripts |

### 2. Generated, committed catalog

`pnpm catalog` compiles all manifests into `catalog/catalog.json`:

```jsonc
{
  "version": 1,
  "generatedAt": "…",              // the only volatile field; kept when nothing else changed
  "schema": "schemas/component.schema.json",
  "components": [ { /* manifest fields */, "path", "version", "scripts", "files", "dependents" } ],
  "products":   { "<slug>": { "path", "components", "owners", "kinds" } },
  "contracts":  [ { "path", "kind", "exists", "providers", "consumers" } ],
  "edges":      [ { "from", "to", "type": "depends_on|provides|consumes" } ]
}
```

Arrays are sorted and keys ordered, so the file diffs cleanly and `pnpm catalog --check` (ignoring
`generatedAt`) can fail CI when a manifest changed without regenerating. `catalog/CATALOG.md` is the human table;
`.github/CODEOWNERS` is generated from the same data. The catalog is committed, not built on demand, so agents and
external services can read it with a single file fetch and no toolchain.

### 3. Enforcement

`@bsh/catalog-tool` runs in CI: `validate` (schema plus cross-checks with `package.json` and the filesystem),
`boundaries` (imports match `depends_on`; product and platform isolation; no relative escapes), `catalog --check`,
`codeowners --check`. Every finding has a stable rule id and `file:line`, human or `--json`.

### 4. Joining the infra Fleet API (planned)

The Fleet API already answers "where does it run" from `nix/fleet/`. The join, in order:

1. **Key.** A deployable component's `name` equals its fleet service name (e.g. `degent-mint`). Where they
   differ today, a future optional manifest field `deploy: { fleet_service: <name> }` (schema change, own ADR)
   declares the mapping; `validate` will reject unknown fleet names once step 3 lands.
2. **Publish.** CI on `main` publishes `catalog.json` as a build artifact at a stable URL (versioned by commit).
3. **Ingest.** The Fleet API fetches it and exposes `/api/components/<name>` merged with `/api/services/<name>`:
   code facts from here (owner, contracts, runbook, SLO, secret paths) plus runtime facts from `infra` (host,
   ports, health, logs). The fleet MCP gains the same data through `fleet_get`, with no new tools.
4. **Close the loop.** The Nix modules that deploy a component can read its `env_schema` and `secrets` paths
   from the catalog, so the SOPS paths declared here and provisioned there cannot drift.

Neither side imports the other's code; the contract is the `catalog.json` shape (`version` bumps on breaking change).

## Alternatives considered

- **Infer everything from `package.json` and imports.** No ownership, contracts, SLOs or secrets; the linter would
  have nothing to check against.
- **Backstage `catalog-info.yaml`.** Good ecosystem, but its entity model is broader and looser than we need and
  pulls in a portal to be useful. Our schema is a small subset; exporting Backstage entities from `catalog.json`
  is a straightforward generator if we ever adopt it.
- **Generate the catalog in CI only (not committed).** Saves diff noise but makes agents run the toolchain before
  they can answer "what exists". Rejected.

## Consequences

- One more file per component, checked on every PR. Templates carry a filled-in example.
- Agents start from `catalog/catalog.json` and navigate by path instead of grepping.
- Manifest edits need `pnpm catalog` in the same commit; CI says so explicitly.
- Contract files must exist before a manifest references them, which enforces contract-first.
- The Fleet API join requires a small schema addition and an infra-side ingest, tracked separately.
