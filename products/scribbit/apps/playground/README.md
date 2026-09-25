# @bsh/scribbit-playground: the Signet Playground

The "Try" rung of the learning ladder: **a stranger inscribes their first file on signet in under five minutes,
for free, and learns what they did.** Five guided steps, each with a short "In plain words" panel and a "What just
happened on chain" card, inside a persistent **TEST NETWORK** frame, with a timer toward the five-minute goal.
Decision record: [ADR-0009](../../../../docs/adr/0009-signet-playground.md).

| Step | What the visitor does | What the page does |
|---|---|---|
| 1 Get a test wallet | Makes a throwaway key, or connects a real wallet switched to signet | Throwaway: `@noble/curves` key in **sessionStorage only**, `tb1p` address, optional `tr(<testnet WIF>)` backup. Real wallets via `@bsh/wallet-kit`, each labelled with its signet status from the wallet conformance matrix |
| 2 Get free test coins | Clicks once | Fetches a challenge from [`@bsh/scribbit-signet-faucet`](../../services/signet-faucet/README.md), solves the SHA-256 proof of work in a **Web Worker** with a progress bar, asks for the drip, waits until the coin is listed |
| 3 Pick a small file | A sample or a file ≤ 50 KB | Exact quote from `@bsh/inscription` (the mint's `InscriptionOps`): weight, vsize, lane, fee rate, reveal fee, postage, and the funding PSBT so the total is exact too |
| 4 Commit and reveal | Signs twice | The mint's funding/reveal construction, txid check, `finalizeWalletSignedReveal`; broadcast through the broadcaster port (Esplora-compatible signet API) |
| 5 Certificate | Answers three questions | Inscription id, signet explorer, signet ord and X-Ray links, elapsed time; quiz pass/fail optionally POSTed anonymously (off by default) |

## Quickstart

```bash
pnpm install
pnpm --filter @bsh/scribbit-playground dev        # open http://localhost:5173/?demo=1  (fully offline)
```

`?demo=1` (or building with `VITE_DEMO_DEFAULT=1`) replaces the faucet, the chain and the wallets with fakes;
the proof of work, the transaction maths and every signature are real. Against real signet:

```bash
FAUCET_WALLET=fake pnpm --filter @bsh/scribbit-signet-faucet dev &      # or a real one: see its README
VITE_FAUCET_URL=http://localhost:3070 pnpm --filter @bsh/scribbit-playground dev
```

(The fake faucet invents txids, so on real signet use a faucet backed by `FAUCET_WALLET=bitcoind`, or any public
signet faucet: without `VITE_FAUCET_URL` the page tells the visitor to use one and to "Check my balance".)

```bash
pnpm --filter @bsh/scribbit-playground test        # 43 tests (jsdom + node): every step and its error states, the timing assertion
pnpm --filter @bsh/scribbit-playground typecheck
pnpm --filter @bsh/scribbit-playground build       # → dist/ (also emits public/playground.json and sitemap.xml)
pnpm --filter @bsh/scribbit-playground e2e         # after build: headless Chromium, demo flow at 390/1280, light/dark
pnpm --filter @bsh/scribbit-playground sync:wallets  # refresh src/data/wallet-signet.json from DegentClub/specs
```

Screenshots from the real-browser run: [`docs/screenshots/`](./docs/screenshots/).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_DEMO_DEFAULT` | unset | `1`: demo mode unless `?demo=0`; also drops the Google Fonts links (no third-party requests). Used by GitHub Pages |
| `VITE_FAUCET_URL` | unset | `@bsh/scribbit-signet-faucet` base. Unset: no faucet; the page explains how to fund the address elsewhere |
| `VITE_ESPLORA_URL` | `https://mempool.space/signet/api` | Esplora-compatible signet API: UTXOs, `/fee-estimates`, broadcast (the broadcaster port) |
| `VITE_EXPLORER_URL` | `https://mempool.space/signet` | Tx and address links |
| `VITE_ORD_URL` | `https://signet.ordinals.com` | `/inscription/<id>` |
| `VITE_XRAY_URL` | `https://block.space/xray` | X-Ray link: `<base>/<reveal txid>` |
| `VITE_ANALYTICS_URL` | unset (off) | Optional endpoint for the anonymous quiz result (see "Privacy") |
| `VITE_MAX_FILE_BYTES` | `51200` | File limit |
| `VITE_FEE_RATE` | unset | Fixed sat/vB; unset = Esplora `/fee-estimates` (3-block target) |
| `VITE_MIN_FEE_RATE` | `1` | Floor for the estimate |
| `VITE_SITE_URL` | `https://degentclub.github.io/scribbit/playground/` | Canonical URL (OpenGraph, JSON-LD, sitemap) |

Only `http(s)` URLs are accepted from env. Build with `vite build --base /some/path/` to host under a prefix
(the default build uses relative URLs and works anywhere).

## Machine-readable surface

- `playground.json` (generated at build from `@bsh/scribbit-playground-kit`): steps, glossary, quiz, endpoints,
  wallet signet statuses. The page renders the same document at `?format=json`.
- `llms.txt`, `sitemap.xml`, `robots.txt`; JSON-LD (`WebApplication` + `LearningResource`, `timeRequired: PT5M`)
  and OpenGraph in `index.html`; stable anchors `#step-<id>` and `#term-<id>`.
- The faucet is an API: [`contracts/openapi/scribbit-signet-faucet.yaml`](../../../../contracts/openapi/scribbit-signet-faucet.yaml).
- For agents: the scribb.it MCP server's `playground_explain_step` (same text) and `quote_inscription`. No faucet
  tool, on purpose (see the MCP README).

## Safety, honesty, privacy

- **Signet only.** The throwaway key can only produce `tb1p` addresses; a stored key not tagged `signet` is
  ignored; the backup is a testnet WIF that mainnet software rejects. The faucet refuses `bc1` addresses. The
  TEST NETWORK banner and frame are on every screen (asserted by the e2e run).
- **Keys never leave the browser.** No server sees a key; real wallets sign in their own window.
- **Wallet statuses are read, not claimed.** `src/data/wallet-signet.json` is generated from
  `DegentClub/specs` `conformance/wallets.yaml` with its `asOf` date; the UI computes every count from it. As of
  that snapshot no wallet is verified on signet; the page says "assumed, not yet verified" accordingly, and
  offers no connect button for wallets whose signet support is `unsupported`.
- **Unconfirmed is said out loud.** The flow spends the faucet's unconfirmed output and broadcasts the reveal
  right behind the commit; the certificate says the ord page appears after the next signet block.
- **Privacy.** Analytics is off by default. When `VITE_ANALYTICS_URL` is set, the only request is one POST of
  `{ event: "playground.quiz", version, passed, score, total }` with `credentials: omit` and no referrer: no
  address, no txid, no identifier. Demo mode never sends it.
- **Five minutes is a goal, not a promise.** Faucet latency and the signet API decide the real time; the timer
  shows the truth and the certificate does not claim the goal when it was missed (tested).

## Reuse

From `@bsh/scribbit-mint` (declared in `depends_on`): funding PSBT construction and the txid check
(`lib/funding`), per-wallet leaf-key planning (`lib/walletRouting`), error wording (`lib/errors`), formatting,
MIME sniffing, the `CostTable`/`Kv`/`Alert` components, the real `InscriptionOps` and wallet-kit adapter, the fake
wallets, and the stylesheet. The playground adds the throwaway signer, the faucet and Esplora ports, the PoW
worker and the guided flow.
