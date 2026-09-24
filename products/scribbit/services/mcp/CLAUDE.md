# @bsh/scribbit-mcp - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **service**. Manifest: `component.yaml` (the catalog entry in `catalog/catalog.json` is generated from it).
- Import only `@bsh/inscription`, `@bsh/scribbit-fee-oracle`, `@bsh/edge`, `@bsh/scribbit-playground-kit` (see `depends_on`); `pnpm lint:boundaries` fails otherwise.
- The HTTP surface is fixed by `contracts/openapi/scribbit-mcp.yaml`; change the contract first, then `src/app.ts`,
  then `test/contract.test.ts`. MCP message shapes belong to the MCP spec / SDK, not to the contract.
- Tools are pure functions in `src/tools.ts`; `src/mcp.ts` only registers them with zod schemas. Keep it that way:
  every tool must stay testable over `InMemoryTransport` with no network (`test/helpers.ts`).
- Never return or log a PSBT, an API key or its hash. Errors are `ToolError` with a stable code (`src/errors.ts`);
  add new codes to the `ToolError` enum in the contract too.
- Numbers must match `@bsh/inscription` exactly; tests assert against the library directly (including the README size
  table), so a drift in the library shows up here.
- Verify with `pnpm --filter @bsh/scribbit-mcp test` and `typecheck`, then `pnpm validate && pnpm lint:boundaries`.
- `server.json` is the MCP Registry listing. Adding or renaming a tool, resource or prompt, or bumping the version,
  means updating it too (`test/registry.test.ts` fails otherwise); see README "Listing" before submitting it.
