# @bsh/scribbit-mcp - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **service**. Manifest: `component.yaml` (the catalog entry in `catalog/catalog.json` is generated from it).
- Import only `@bsh/inscription`, `@bsh/scribbit-fee-oracle`, `@bsh/edge` (see `depends_on`); `pnpm lint:boundaries` fails otherwise.
- The HTTP surface is fixed by `contracts/openapi/scribbit-mcp.yaml`; change the contract first, then `src/app.ts`,
  then `test/contract.test.ts`. MCP message shapes belong to the MCP spec / SDK, not to the contract.
- Tools are pure functions in `src/tools.ts` (calculators) and `src/orders.ts` (ledger client tools); `src/mcp.ts`
  declares them ONCE in the `TOOLS` registry (name, scopes, zod schema, handler). `GET /`, the agent card and
  `/.well-known/mcp.json` read that registry - never hand-write a tool list anywhere. Keep every tool testable over
  `InMemoryTransport` with no network (`test/helpers.ts`; the ledger is `test/fake-ledger.ts`, contract-validated).
- Scopes live in `src/scopes.ts`. Every tool declares the scopes that may call it; `mcp:order` and `mcp:settle` are
  refused together at key load (config, mint-key) and at the door (403). Do not weaken that split.
- The ledger is reached only through `src/ledger-client.ts` (types mirror `contracts/openapi/ledger.yaml`; no
  `@bsh/ledger` import - it is a separate service). The server stays non-custodial: never accept, build, sign or
  broadcast a PSBT, never take a key.
- Never return or log a PSBT, an API key (ours or the ledger's) or its hash. Errors are `ToolError` with a stable code (`src/errors.ts`);
  add new codes to the `ToolError` enum in the contract too.
- Numbers must match `@bsh/inscription` exactly; tests assert against the library directly (including the README size
  table), so a drift in the library shows up here.
- Verify with `pnpm --filter @bsh/scribbit-mcp test` and `typecheck`, then `pnpm validate && pnpm lint:boundaries`.
