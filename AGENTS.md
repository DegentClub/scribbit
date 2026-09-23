# AGENTS.md

Instructions for any coding agent (Claude, Codex, Cursor, Copilot, ...) working in this repository.

1. **Read [`CLAUDE.md`](./CLAUDE.md).** It is the canonical agent guide (map, rules, common tasks), not Claude-specific.
2. **Query [`catalog/catalog.json`](./catalog/catalog.json) before grepping.** It lists every component with its
   path, owner, dependencies, dependents, contracts, scripts and docs. Example:
   `jq '.components[] | select(.product=="platform") | {name, path, dependents}' catalog/catalog.json`.
   Platform packages here are consumed by `DegentClub/degent` and `DegentClub/blockspace` through a pinned
   submodule (ADR-0004): check `.dependents` before changing an exported surface.
3. **Follow the rules.** Every package has a `component.yaml`; import only what `depends_on` declares; products
   talk through `contracts/` only; no secrets in the repo. Before finishing, run `pnpm check`, and `pnpm catalog`
   if you changed a manifest.
4. Then read the local `CLAUDE.md` / `README.md` of the component you are changing, and any ADR it links.
