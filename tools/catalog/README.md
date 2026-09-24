# @bsh/catalog-tool

Makes the monorepo machine-readable: validates `component.yaml` manifests, enforces import
boundaries, and generates `catalog/catalog.json`, `catalog/CATALOG.md` and `.github/CODEOWNERS`.
Design: [ADR-0003](../../docs/adr/0003-machine-readable-catalog.md).

```bash
pnpm validate                  # = tsx src/cli.ts validate
pnpm lint:boundaries           # = tsx src/cli.ts boundaries
pnpm catalog [--check]         # write / verify catalog/catalog.json + CATALOG.md
pnpm --filter @bsh/catalog-tool run codeowners [--check] [--org <github-org>]
pnpm readiness [--min-readme-lines <n>]   # open-source readiness gate (see below)
# every command: --json (one JSON object on stdout), --root <dir> (default: nearest pnpm-workspace.yaml)
```

Exit codes: `0` clean, `1` findings, `2` usage/internal error. Human output is one line per finding,
`severity[rule] file:line: message  (component)`, then a summary line. JSON output:

```json
{ "command": "boundaries", "ok": false, "counts": { "errors": 1, "warnings": 0 },
  "stats": { "packages": 6, "files": 49, "imports": 110 },
  "diagnostics": [{ "severity": "error", "rule": "cross-product-import", "file": "products/scribbit/apps/console/src/index.ts",
                    "line": 1, "component": "scribbit-console", "message": "..." }] }
```

## Quickstart

From the root of any repository that uses it (this one, or a product repository through `deps/scribbit`):

```bash
pnpm install
pnpm validate                        # manifests: schema, package.json, referenced files
pnpm lint:boundaries                 # imports follow depends_on
pnpm catalog --check                 # catalog/catalog.json is current
pnpm readiness                       # open-source readiness (see below)
pnpm --filter @bsh/catalog-tool run validate -- --json | jq '.diagnostics[] | "\(.rule) \(.file)"'
```

Exit code `0` means clean, `1` means findings, `2` means a usage error.

## Rule ids

Stable; CI annotations and agents match on them.

| Command | Rule | Meaning |
|---|---|---|
| validate | `manifest-missing` | Workspace package has no `component.yaml` |
| validate | `manifest-yaml-invalid` | YAML syntax error |
| validate | `manifest-schema` | Violates `schemas/component.schema.json` (line points at the offending key) |
| validate | `package-name-mismatch` | `package` differs from package.json `name` |
| validate | `product-path-mismatch` | `product` disagrees with the folder (`platform/`, `products/<slug>/`, `tools/`) |
| validate | `depends-on-unknown` / `depends-on-self` | `depends_on` names no workspace package / itself |
| validate | `depends-on-not-in-package-json` | `depends_on` entry missing from package.json deps |
| validate | `package-json-dep-undeclared` | package.json has an `@bsh/*` dep that `depends_on` omits |
| validate | `contract-missing` | `provides`/`consumes` file under `contracts/` does not exist |
| validate | `path-missing` | `env_schema` / `runbook` / `docs` file does not exist |
| validate | `command-script-missing` | `commands.<verb>` points at a script package.json lacks |
| validate | `name-duplicate` / `package-duplicate` | Names must be unique |
| boundaries | `undeclared-import` | `@bsh/*` import (static, type, dynamic, re-export, require, `import()` type) not in `depends_on` |
| boundaries | `unknown-workspace-import` | `@bsh/*` import of a package that does not exist |
| boundaries | `cross-product-import` | One product imports another product's code |
| boundaries | `platform-imports-product` | `platform/*` imports `products/*` |
| boundaries | `relative-escape` | Relative/absolute import resolves outside the package root |
| boundaries | `depends-on-cross-product` / `depends-on-platform-to-product` | Same policies, declared in the manifest |
| catalog | `catalog-stale` | `--check`: committed catalog differs from the manifests (ignores `generatedAt`) |
| codeowners | `codeowners-stale` | `--check`: `.github/CODEOWNERS` differs from component owners |
| readiness | `root-file-missing` | Repository root lacks `LICENSE`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `GOVERNANCE.md` or `TRADEMARKS.md` |
| readiness | `license-header` | `LICENSE` is not the Apache License 2.0 text (first lines `Apache License` / `Version 2.0, January 2004`) |
| readiness | `issue-templates-missing` | `.github/ISSUE_TEMPLATE/` has no issue form (`*.yml` other than `config.yml`) |
| readiness | `issue-template-config-missing` | Warning: no `.github/ISSUE_TEMPLATE/config.yml` (security reports must be routed to advisories) |
| readiness | `security-workflow-missing` | Missing `.github/workflows/{security,codeql,dependency-review,dco,scorecard}.yml` or `.github/dependabot.yml` |
| readiness | `package-license-missing` / `package-license-mismatch` | Package `package.json` has no `license`, or not the repository's (`Apache-2.0`) |
| readiness | `readme-missing` / `readme-quickstart-missing` | Package has no `README.md`, or it has no `Quickstart` heading (headings inside code fences do not count) |
| readiness | `readme-too-short` | Package `README.md` has fewer than `--min-readme-lines` non-blank lines (default 20) |
| readiness | `lifecycle-missing` | Package has no `component.yaml`, or it has no `lifecycle` |

Imports are parsed with the TypeScript compiler API, so comments, strings and JSX text never produce
false positives. `node_modules`, `dist`, `build`, `coverage` and dot-directories are skipped.

## Open-source readiness (`readiness`)

The gate that keeps a repository publishable (board decision: code Apache-2.0 with a NOTICE, docs CC BY 4.0, DCO
contributions). It checks the repository root and every package the repository owns; external packages (a
submodule at `deps/scribbit`) are skipped here because their own repository runs the same gate.

- Root: `LICENSE` whose header is the Apache License 2.0, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `GOVERNANCE.md`, `TRADEMARKS.md`; at least one issue form in
  `.github/ISSUE_TEMPLATE/` (plus `config.yml`); the security automation (`security.yml` gitleaks, `codeql.yml`,
  `dependency-review.yml`, `dco.yml`, `scorecard.yml`, `dependabot.yml`).
- Every package: `"license": "Apache-2.0"` in `package.json`; a `README.md` with a `Quickstart` heading and at least
  20 non-blank lines (`--min-readme-lines`); a `lifecycle` in `component.yaml`.

It is part of `pnpm check` and CI here. DegentClub/degent and DegentClub/blockspace run it from `deps/scribbit`
(`pnpm --filter @bsh/catalog-tool run readiness`); their CI step warns instead of failing until their pin includes
this command. Implementation: `src/readiness.ts`; fixture: `test/fixtures/readiness/` (repo-level files are written
by the test, so the fixture itself never looks like a publishable repository).

## External packages (nested workspace roots)

A workspace glob may reach into a directory that has its own `pnpm-workspace.yaml` (the platform vendored as a
git submodule at `deps/scribbit`, with `deps/scribbit/platform/*` in the outer `pnpm-workspace.yaml`). Packages
found there are **external** (ADR-0004): known workspace packages, but owned by another repository.

| Command | Behaviour for external packages |
|---|---|
| validate | Manifest-relative paths (`provides`/`consumes`, `env_schema`, `runbook`, `docs`) resolve against the NESTED root; findings carry `"group": "external"`; `stats.external` counts them. Outer manifests may `consumes: deps/<name>/contracts/...` |
| boundaries | Outer imports of `@bsh/*` are checked against `depends_on` with external packages as valid targets; external sources are never scanned |
| catalog | Listed with `external: { repo, commit, root }` (remote URL from `.gitmodules`, commit from the index, `git ls-files -s <root>`, i.e. HEAD or a staged pin bump); their `path`, `files`, `provides`, `consumes` are rewritten relative to the outer repo (`deps/scribbit/contracts/...`) so the outer catalog joins with the platform catalog at `<repo>@<commit>:catalog/catalog.json` |
| codeowners | Skipped, together with the contracts they provide |

## Layout

`src/workspace.ts` (glob expansion, loading, nested-root detection) · `validate.ts` · `boundaries.ts` · `catalog.ts` ·
`codeowners.ts` · `readiness.ts` · `cli.ts`. Tests use fixture mini-repos in `test/fixtures/<case>/`, copied to a temp
dir with the real schema by `test/helpers.ts`; add a fixture per new rule.
