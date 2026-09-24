# @bsh/scribbit-mint: scribb.it, write to Bitcoin

The retail mint. One app, two pages, **PSBTs only**: the user's wallet signs every transaction, the page builds
and checks them, the site never holds a key, nothing is custodial.

| Route | What |
|---|---|
| `/ordinals` | Inscribe any file or text as an Ordinals inscription (one file or a sequential batch) |
| `/counters` | Mint a Bitcoin Counter: a new counter, a reinscription, or a fairminter deploy (XCP-69 preset or custom) |

```bash
pnpm --filter @bsh/scribbit-mint dev          # http://localhost:5173/ordinals?demo=1
pnpm --filter @bsh/scribbit-mint test         # vitest + testing-library (jsdom): 64 tests
pnpm --filter @bsh/scribbit-mint typecheck
pnpm --filter @bsh/scribbit-mint build        # → dist/
pnpm --filter @bsh/scribbit-mint screenshots  # after build: headless Chromium, demo mode, 1280/400 px, light + dark
```

Screenshots from the real-browser run: [`docs/screenshots/`](./docs/screenshots/).

## /ordinals flow

```
connect ─► content ─► quote ─► commit ─► reveal ─► done
wallet-kit  file/text  exact      funding PSBT      reveal PSBT        inscription id
taproot     MIME sniff weight,    from payment      (leaf = wallet     ordinals.com /
ordinals +  SHA-256    lane,      UTXOs; wallet     key per its        explore.block.space
segwit/tr   size,      fee rate,  signs, does NOT   capabilities);     "verify bytes":
payment     parent,    postage,   broadcast; app    wallet signs;      hash vs on-chain
            metadata   total      checks txid,      finalizeWallet-    content
                                  saves pending,    SignedReveal
                                  broadcasts        verifies; broadcast
```

1. **Quote** (`flows/ordinals/effects.ts#quoteItem`): the leaf key is chosen by `lib/walletRouting.ts`, the
   commit address comes from `@bsh/inscription.commitAddress`, the weight from `estimateRevealWeight` (exact:
   the tests assert it equals the weight of the transaction the wallet actually signed), the fee and commit
   value from `quoteReveal`, the lane from `laneFor` (≤ 400,000 WU standard; above that a warning that it needs
   a non-standard relay).
2. **Commit**: `lib/funding.ts` builds the funding PSBT (commit output at vout 0, largest-first coins, change,
   small coins skipped when the payment address may hold inscriptions) and computes its txid from the unsigned
   transaction; `buildUnsignedRevealPsbt` is built against that txid. The wallet signs with `broadcast: false`;
   `assertTxidUnchanged` refuses a signed transaction whose txid changed (it would orphan the reveal); the
   pending record is saved to `localStorage`; then the app broadcasts via the mint API.
3. **Reveal**: the wallet signs one tapscript input; `finalizeWalletSignedReveal` Schnorr-verifies the leaf
   signature before assembling the transaction; broadcast via the wallet (`pushTx`) or Esplora.
4. **Resume / rescue**: a pending commit is offered on load ("Resume: sign the reveal"); "Stuck commit?
   Re-sign the reveal" rebuilds `[commit] → [child]` with `buildUnsignedRescuePsbt`. The leaf names the
   wallet's key, so there is no recovery key to keep.
5. **Batch**: several files are minted one after another; there is only ever one pending mint.

**Which key / options per wallet** (`planRevealSigning`, tested for all seven). Capabilities and
`taprootOutputKey` come from the connected wallet (`@bsh/wallet-kit` `CAPABILITIES`); the app only decides the
leaf key where the kit reports `tweakedLeafKey: 'unknown'`:

| Wallet | Leaf key | Reveal input | Sighash | Broadcast | Kit status |
|---|---|---|---|---|---|
| XCP Wallet | taproot output key | default signer, `inscription` context | ALL 0x01 (refuses 0x00) | wallet | VERIFIED |
| Horizon | taproot output key | default signer | DEFAULT | Esplora (cannot relay) | VERIFIED |
| UniSat | taproot output key (kit: tweaked) | default signer | DEFAULT | wallet | ASSUMED |
| Xverse | internal key (kit: untweaked) | `disableTweak` | DEFAULT | wallet | ASSUMED |
| OKX, Leather, Magic Eden | internal key (kit: unknown → app fallback) | `disableTweak` (OKX: `disableTweakSigner`) | DEFAULT | wallet | ASSUMED |
| `tapscript: false` | refused before anything is funded | | | | |

Every ASSUMED wallet shows "unverified on this wallet: test on signet first" in the picker, on the connected
wallet and in the counters pre-flight (as a warning, not a blocker).

## /counters flow

Modelled on counters.fun's `/mint`, on `@bsh/scribbit-counters`:

- **Kinds**: counter | reinscription (picker of your assets; quantity 0, the asset's own divisibility, no new
  lock) | fairminter (XCP-69 preset scheduled from the tip with `xcp69Schedule`, or custom parameters starting
  from XCP-69, checked with `fairminterProblems`).
- **Name**: empty draws a free numeric name client-side (`randomNumericAsset`); named assets burn 0.5 XCP.
- **Pre-flight table** (`flows/counters/effects.ts#preflight`, pure, 21 table-tested cases): wallet (taproot,
  tapscript), name shape, existence/ownership via the Counterparty proxy, XCP burn vs balance, sale
  parameters, reveal weight vs the 400,000 WU relay cap (Slipstream route offered when over; `routeFitForWeight`
  refuses what nothing can carry), BTC at the address. The mint button says why it is disabled.
- **Mint**: compose through the proxy → `revealWeightOf` (exact) → envelope re-keyed to the wallet's leaf key
  → `buildCommitPsbt` with the SIGHASH_ALL top-up (Core's inputs and change reused) → wallet signs with the
  `inscription` context (XCP Wallet requires it; Horizon signs a plain PSBT) → txid unchanged? → reveal PSBT →
  **pending saved** → commit broadcast (wallet, else the node, else Esplora) → wallet signs the reveal →
  broadcast → the node is asked whether it knows the txid.
- **Resume**: "Sign the reveal again" from the saved pending mint; refused for a different account.
- **Receipt**: counters.gallery, counters.fun and the explorer links for both txids.

Decision: the leaf names the wallet's key and the wallet signs both commit and reveal; no secret key is ever
stored. (`@bsh/scribbit-counters` also supports counters.fun's mint-generated `newRevealKey` model; not used here.)

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_MINT_API_URL` | `''` (same origin) | `@bsh/scribbit-mint-api` base; `/api/fees`, `/api/esplora/*`, `/api/cp/*` are appended |
| `VITE_MINT_API_URL_<NETWORK>` | | Per-network API base (one API process serves one network) |
| `VITE_NETWORK` | `mainnet` | `mainnet` \| `testnet` (testnet4) \| `signet` \| `regtest` |
| `VITE_NETWORKS` | `VITE_NETWORK` | Networks the header switch offers (`?network=` selects among them) |
| `VITE_EXPLORER_URL` | explore.block.space (mainnet), mempool.space/{testnet4,signet} | Tx links: `/tx/<txid>` |
| `VITE_ORD_URL` | ordinals.com / testnet4. / signet.ordinals.com | `/inscription/<id>`, `/content/<id>` (verify bytes) |
| `VITE_COUNTERS_GALLERY_URL`, `VITE_COUNTERS_FUN_URL` | counters.gallery, counters.fun | Receipt links |
| `VITE_SLIPSTREAM_URL` | slipstream.mara.com | Link for over-cap reveals |
| `VITE_POLL_MS` | 5000 (800 in demo) | Commit status / content polling |

## Demo mode (`?demo=1`)

A striped **DEMO** ribbon is always visible; the network switch offers mainnet/testnet4/signet. Every port with
money or a server behind it is faked (`src/services/fakes.ts`), and the fakes are honest where it matters:

- the fake wallets (all seven, deterministic keys) **really sign** with `@scure/btc-signer`, tweaked or
  untweaked per `disableTweak`, and XCP Wallet refuses a commit without the inscription context, so the txid
  check and `finalizeWalletSignedReveal`'s signature verification execute for real;
- the fake chain derives txids from the bytes it is given, serves "on-chain content" by parsing the envelope
  back out of the broadcast reveal (so "verify bytes" is a real comparison);
- the fake Counterparty node composes a real commit/reveal pair around a random key, which the engine re-keys.

The maths ports are **not** faked: demo mode runs `@bsh/inscription` and `@bsh/scribbit-counters` exactly as live.

## Sibling packages (all integrated)

- `@bsh/wallet-kit`: all seven adapters including `xcpAdapter` / `horizonAdapter`; `capabilities`,
  `taprootOutputKey`, `disableTweak` and the `inscription` context are used as shipped (`services/real/wallet.ts`).
  Demo fakes use the kit's own `CAPABILITIES` table.
- `@bsh/inscription`: `buildUnsignedRevealPsbt` (sighash `'all'` for XCP Wallet), `finalizeWalletSignedReveal`,
  `buildUnsignedRescuePsbt` (`services/real/inscription.ts`).
- `@bsh/scribbit-counters`: CP client over the mint API proxy and the engine (`services/real/counters.ts`).
- Still to do before mainnet: exercise the five ASSUMED wallets' reveal signing against real extensions on signet.

## Design

"The print shop": warm paper (light) and the ink room (dark) via `prefers-color-scheme`; Fraunces for display,
Inter for UI, IBM Plex Mono for bytes, sats and txids; hard ink rules and offset shadows like a proof on a press
bed; Bitcoin orange only as a signal (network dot, the "on chain" stamp). Responsive to 400 px without
horizontal scroll (asserted by the screenshot run), keyboard focus rings, skip link, focus moved to the heading
on step change, status/alert live regions.
