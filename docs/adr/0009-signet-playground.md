# ADR-0009: Signet Playground: throwaway browser keys on signet only, proof of work over captcha, a five-minute target

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** scribb.it team
- **Components:** `@bsh/scribbit-playground` (app), `@bsh/scribbit-signet-faucet` (service), `@bsh/scribbit-playground-kit` (library), `@bsh/scribbit-mcp` (`playground_explain_step`)
- **Supersedes / Related:** ADR-0002 (non-custodial signing model), ADR-0004 (repo split); contract `contracts/openapi/scribbit-signet-faucet.yaml`; wallet conformance matrix (DegentClub/specs `conformance/wallets.yaml`)

## Context

The estate's mission is to educate people about blockspace. The first rung of the learning ladder, "Try", has a
concrete target: a stranger with no wallet and no bitcoin makes their first inscription and understands what
happened. Every obstacle on mainnet (buy bitcoin, install an extension, fund it, pay real fees, risk a mistake) is
fatal to that. We need a place where the whole commit/reveal flow is real but mistakes cost nothing.

Facts that constrain the design:

- Test networks: testnet4 coins are scarce and sometimes traded; regtest is private to one machine; **signet**
  is public, its blocks are signed by designated keys at a steady ~10-minute target, and its coins are
  plentiful and valueless.
- `tb1` addresses are shared by testnet and signet, so an address alone cannot prove "signet"; `bc1` is certainly
  mainnet.
- None of the seven wallets `@bsh/wallet-kit` supports is verified on signet in the conformance matrix as of its
  2026-09-24 snapshot (all are `assumed`, `unknown` or `unsupported`), so "install a wallet" is also the least
  reliable path.
- A signet block every ~10 minutes means a five-minute flow must work with unconfirmed transactions.

## Decision

1. **Signet, and only signet.** The playground has no network switch. Every address it derives is `tb1p`; the
   faucet refuses mainnet (`bc1`, base58 `1…`/`3…`) with its own error code `mainnet_address_refused` and regtest
   with `wrong_network`, and its bitcoind adapter refuses to start unless `getblockchaininfo.chain == "signet"`.
   A TEST NETWORK banner and a coloured viewport frame are on every screen.
2. **A throwaway key in the browser is allowed on signet only.** The default path generates a key with
   `@noble/curves` in the page and keeps it in `sessionStorage` (gone when the tab closes); it never leaves the
   device, and the page signs locally with `@scure/btc-signer`. The backup is optional and is a testnet-version
   WIF in a `tr()` descriptor, which mainnet software rejects. This is an explicit, scoped exception to
   "libraries never hold a user's key" (root rule 6): it lives in an app, not a library, only produces signet
   addresses, and holds nothing of value. Real wallets remain available through wallet-kit, each labelled with
   its signet status read from the conformance matrix snapshot (never hard-coded).
3. **Proof of work instead of a third-party captcha.** The faucet issues a single-use, expiring nonce; the
   browser searches for `solution` with `SHA-256("scribbit-faucet-pow/v1:" + nonce + ":" + address + ":" +
   solution)` having ≥ `difficulty` leading zero bits (default 20, ~10^6 hashes, a few seconds in a Web Worker).
   The address is in the message, so work is not transferable; the first drip attempt consumes the nonce.
   Behind it: per-address (1/day) and per-IP (3/day) token buckets and a daily global sats budget (UTC), all
   refunded when the wallet fails. The rule lives in `@bsh/scribbit-playground-kit`, shared by the app and the
   service. The faucet is off by default (`FAUCET_WALLET=off`).
4. **A five-minute target, measured.** The page shows elapsed time against 5:00 from the first click to the
   reveal; the flow spends the faucet's unconfirmed output and broadcasts the reveal right behind the commit.
   Tests assert the scripted demo path completes all five steps inside the goal (jsdom and a real Chromium run),
   and that a slow run is not told it met the goal.
5. **Learn, not just click.** Each step has a plain-language panel and a "what just happened on chain" card;
   the certificate ends with a three-question explain-check. The words live in the kit, so the MCP server's
   `playground_explain_step` serves the identical text to agents.
6. **Analytics privacy.** Off by default. When configured, the only request is one POST of
   `{ event, version, passed, score, total }` with `credentials: omit` and no referrer. No address, txid,
   timestamp or identifier is ever sent; demo mode never sends. The faucet keeps no log of addresses or IPs beyond
   its in-memory buckets; its metrics carry result codes only.
7. **No faucet MCP tool.** Agents must not spend the shared, per-IP-limited faucet budget on a person's behalf;
   the person does the proof of work in their own browser.

## Alternatives considered

- **Testnet4.** Coins are scarcer and have been traded; faucets are drained. Revisit only if signet
  infrastructure disappears.
- **Regtest in the browser / a private signet.** Fully controllable, but nothing is public: the learner could
  not look their inscription up on a real explorer, which is half the lesson.
- **hCaptcha / reCAPTCHA / Turnstile.** Third-party scripts, tracking and accessibility problems on a page
  whose promise is "nothing leaves your browser". Proof of work is a speed bump, not identity; the daily budget
  caps the loss. Revisit if abuse outruns difficulty tuning.
- **Require a real wallet.** Fails the five-minute target and relies on wallets none of which is verified on
  signet today.
- **Server-held keys (custodial demo).** Violates the estate's non-custodial rule even on test coins and would
  teach the wrong model.

## Consequences

- Easier: a zero-cost, zero-install first inscription, reusable in docs, talks and the MCP server; the mint's
  PSBT code gets exercised by strangers on signet.
- Harder: someone must operate and refill a signet wallet and watch the faucet metrics; one faucet process only
  (in-memory state). A determined abuser with many IPs can still collect drips up to the daily budget.
- Must do: bump `src/data/wallet-signet.json` when the conformance matrix changes (`pnpm sync:wallets`; a test
  compares it with a local DegentClub/specs checkout); exercise the ASSUMED wallets' signet signing and record
  the results in the matrix; decide who hosts the faucet and its CORS origin before enabling it.
