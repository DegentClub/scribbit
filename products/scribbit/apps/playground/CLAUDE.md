# @bsh/scribbit-playground - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **app**. Imports only `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/scribbit-mint` (deep imports of its
  `src/lib`, `src/components`, `src/services`) and `@bsh/scribbit-playground-kit`.
- Signet only. Never add a network switch; never let the throwaway key produce a non-`tb1p` address.
- Explanation text lives in `@bsh/scribbit-playground-kit` (shared with the MCP server); do not inline copy here.
- `src/data/wallet-signet.json` is generated (`pnpm sync:wallets`); never edit it or hard-code a wallet status.
- Every step has component tests for its error states (`test/steps.test.tsx`); after UI changes run `build` then
  `e2e` and look at `docs/screenshots/`.
