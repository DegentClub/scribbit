# contracts/

Machine-readable interfaces between components. **This directory is the only allowed coupling between products**:
a product may call another product's service or react to its events, but never import its code.

```
contracts/openapi/<name>.yaml     HTTP APIs (OpenAPI 3.1)
contracts/asyncapi/<name>.yaml    events and channels (AsyncAPI 3)
contracts/schemas/<name>.json     shared JSON Schemas referenced by the above
```

File names are kebab-case and usually equal the providing component's name (`scribbit-fees.yaml`). A contract lives
in the repository of the component that provides it; product repositories reference platform contracts as
`deps/scribbit/contracts/...` (ADR-0004).

## Rules

1. **Contract first.** Change the contract in its own commit (or at least first in the PR), then the code.
   Reviewers read the contract diff before the code diff.
2. **Declared on both sides.** The providing component lists the file in `provides:`, every consumer in
   `consumes:` (optionally with a `#/json/pointer` fragment). `pnpm validate` fails if a referenced file does not
   exist; `catalog/catalog.json` lists each contract's providers and consumers.
3. **Owned by providers.** `.github/CODEOWNERS` routes each contract to its providers' teams (generated).
4. **Events** are named `<product>.<aggregate>.<event>` (e.g. `degent.mint.order.paid`); consumers of platform or
   infra event streams declare `events:<channel>` in `consumes:`.

## Versioning

- Each contract carries `info.version` (SemVer). Additive, backward-compatible changes bump minor; fixes to
  descriptions or examples bump patch.
- A **breaking change** (removing or renaming an operation, field, channel or enum value; making an optional
  request field required; narrowing a type; changing an event's meaning) requires a **new major version**, served
  side by side: a new path prefix (`/v2/...`) for HTTP, a new channel suffix (`.v2`) for events.
- The old major stays until the catalog shows no consumers of it, then is removed with a deprecation note.

## Breaking-change policy (oasdiff)

CI runs [`oasdiff`](https://github.com/oasdiff/oasdiff) on every changed OpenAPI file against `origin/main`:

```bash
oasdiff breaking <(git show origin/main:contracts/openapi/x.yaml) contracts/openapi/x.yaml --fail-on ERR
```

- `ERR` findings fail the PR unless the major version was bumped and a migration note is in the PR description.
- `WARN` findings must be acknowledged in the PR's "Contract changes" section.
- AsyncAPI files are reviewed by the providing team with the same criteria until an equivalent diff tool is wired in.
