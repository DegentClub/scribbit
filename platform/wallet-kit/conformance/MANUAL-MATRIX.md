# Wallet conformance — manual matrix (real extensions, signet)

The Playwright run (`pnpm --filter @bsh/wallet-kit conformance`) proves the adapters against **fake**
providers in a real browser. This checklist is the other half: the same harness against the **real**
extensions, on **signet**, before any wallet row in the README moves from ASSUMED to VERIFIED. Fill in the
results table at the bottom and commit it with the extension versions.

## Setup (once per machine)

1. Chrome/Chromium profile dedicated to testing (extensions leak state between sites; do not use your daily
   profile). Install the extensions from the `installUrl` in each adapter; note the version from
   `chrome://extensions`.
2. Every wallet on **signet** with a funded signet account (faucet: <https://signetfaucet.com>, or
   `fleet signet fund <addr> <sats>` on the private signet — then point the wallet at the private signet's
   Esplora if the wallet allows a custom endpoint; otherwise use public signet).
3. Build and serve the harness:

   ```bash
   pnpm --filter @bsh/wallet-kit conformance:serve      # http://127.0.0.1:4173/harness.html?network=signet
   ```

4. For the PSBT steps you need a PSBT that spends **your** payment address (the fixture spends a fake outpoint,
   which real wallets reject or refuse to display). Build one with the CLI or btc-signer: one input =
   a UTXO of the wallet's payment address, `sighashType: 0x81`, one output back to the ordinals address, and
   paste the base64 into the harness "PSBT override" box. Broadcasting it is safe (it pays yourself) but
   leave the broadcast toggles off unless the row asks for it.

## Per wallet

Run each row, tick the box, and put the outcome in the table. "Prompt text" is what the extension shows —
record it when it is wrong or missing (e.g. a sighash 0x81 warning). If a step fails, keep the harness
`detail` text and the `window.__fakeWalletCalls`-style console output (`localStorage.debug = 'wallet-kit'`
is not a thing; copy the results table).

| # | Step | What to check | UniSat | Xverse | Leather | OKX | Magic Eden |
|---|---|---|---|---|---|---|---|
| 1 | Install + detect | Extension injects; harness "Detected now" lists the wallet after page load (and after a refresh if it injects late) | ☐ | ☐ | ☐ | ☐ | ☐ (mainnet only) |
| 2 | Connect on signet | Prompt appears; kit reports `connected on signet`; wallet NOT already on signet → prompt to switch (UniSat) or `UNSUPPORTED_NETWORK` with a clear message (Xverse/Leather/OKX) | ☐ | ☐ | ☐ | ☐ | n/a |
| 3 | Ordinals + payment addresses | `addresses` step: ordinals = `p2tr` (tb1p…), payment = `p2wpkh` (tb1q…) for Xverse/Leather/ME; single account for UniSat/OKX; public keys 32/33-byte hex | ☐ | ☐ | ☐ | ☐ | ☐ |
| 4 | BIP-322 signMessage | Prompt shows the message; returns a base64 signature; verify it with `bip322-js` or the wallet's own verifier against the payment address | ☐ | ☐ | ☐ | ☐ | ☐ |
| 5 | ECDSA signMessage | `signMessageType: 'ecdsa'` in the console: `await __walletKitHarness.run('<id>', { signMessageType: 'ecdsa' })`; Leather must fail with `UNSUPPORTED_METHOD` | ☐ | ☐ | ☐ (expects UNSUPPORTED_METHOD) | ☐ | ☐ |
| 6 | Sign PSBT with a 0x81 input | Paste your PSBT; wallet signs input 0 with `SIGHASH_ALL\|ANYONECANPAY`; result decodes (`bitcoin-cli decodepsbt` / <https://bip174.org>) with a 65-byte signature ending `81`; note whether the wallet warned about the sighash | ☐ | ☐ | ☐ | ☐ | ☐ |
| 7 | Sign PSBT — reject | Decline the prompt; harness shows `USER_REJECTED` (not `WALLET_ERROR`) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 8 | Broadcast | Console: `run('<id>', { psbtBase64, pushTx: true })` for UniSat/OKX (`pushTx`) — the fixture raw tx must be replaced by your own signed tx; for Xverse/Leather/ME use `signPsbt(..., { broadcast: true })` from the console and check the txid on a signet explorer | ☐ | ☐ | ☐ | ☐ | ☐ |
| 9 | Account switch | With a session open (`await __walletKitHarness.kit.connect('<id>')`), switch account in the extension: harness events show `accountsChanged` then `disconnect:accountsChanged`; `kit.current` is `null` | ☐ | ☐ | ☐ (no events expected: document it) | ☐ | ☐ |
| 10 | Network switch | Same, switching the extension to mainnet/testnet: `accountsChanged` for UniSat/Xverse/OKX; Leather: next `connect` on signet fails `UNSUPPORTED_NETWORK` | ☐ | ☐ | ☐ | ☐ | n/a |
| 11 | Disconnect | `disconnect` step passes; reconnect prompts again (or silently reconnects: note which) | ☐ | ☐ | ☐ | ☐ | ☐ |

Console helpers on the harness page:

```js
const h = window.__walletKitHarness;
await h.run('xverse', { network: 'signet', psbtBase64: '<your psbt>' });
h.results;                              // the table, as data
h.events;                               // kit events with timestamps
const w = await h.kit.connect('unisat'); // keep a session for steps 9–11
```

## Results

Copy this block per run. One row per wallet; `pass` / `fail(<code>)` / `n/a` per step number.

| Date | Tester | Wallet | Extension version | Browser | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | Notes (prompt text, sighash warning, surprises) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | UniSat | | | | | | | | | | | | | | |
| | | Xverse | | | | | | | | | | | | | | |
| | | Leather | | | | | | | | | | | | | | |
| | | OKX | | | | | | | | | | | | | | |
| | | Magic Eden | | | | | | | | | | | | | | |

When a wallet passes 1–11, update the README "Verified vs assumed" rows it covers from ASSUMED to
VERIFIED with `manual matrix <date>, v<version>` as the source. When it fails, file the adapter fix with the
harness `detail` text and add a fake-provider case in `conformance/fakes/providers.ts` that reproduces the
real behaviour, so the Playwright run guards the fix.
