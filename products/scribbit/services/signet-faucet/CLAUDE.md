# @bsh/scribbit-signet-faucet - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **service**. Imports only `@bsh/edge` and `@bsh/scribbit-playground-kit` (see `depends_on`).
- Contract first: `contracts/openapi/scribbit-signet-faucet.yaml`, then `src/app.ts`, then `test/contract.test.ts`.
  New error codes go into the contract's `Error` enum and `src/metrics.ts#DRIP_RESULTS`.
- Signet only. Never add a mainnet path, never weaken `checkSignetAddress` or `assertSignet`.
- The PoW rule lives in the kit; do not reimplement it here.
- Tests are offline: the fake wallet and a fake bitcoind `fetch` (see `test/wallet.test.ts`); RFC 5737 IPs,
  `*.internal.example` hosts.
- Verify with `pnpm --filter @bsh/scribbit-signet-faucet test` and `typecheck`, then `pnpm validate && pnpm lint:boundaries`.
