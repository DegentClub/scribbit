# @bsh/scribbit-playground-kit - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **library**, pure (no I/O, no keys). Public API in `src/index.ts` only.
- The PoW message format and `POW_ALGORITHM` are a wire contract with `contracts/openapi/scribbit-signet-faucet.yaml`:
  changing either is a breaking change for every browser that has the app open (bump `/v1` → `/v2`).
- Text changes are product copy: keep protocol facts exact (the tests assert them) and never mention prices.
- Verify with `pnpm --filter @bsh/scribbit-playground-kit test` and `typecheck`.
