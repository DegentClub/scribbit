# @bsh/scribbit-counters

The **Bitcoin Counters** mint engine for scribb.it: a framework-free TypeScript library that turns a file into a
numbered Counter through Counterparty Core's taproot commit/reveal. No React, nothing fetched at import time
(`fetch` is injected), `Uint8Array` / `bigint` only. The same code runs in the browser and on a server.

```bash
pnpm --filter @bsh/scribbit-counters test
pnpm --filter @bsh/scribbit-counters typecheck
```

## Quickstart

From another package in this repository: add `"@bsh/scribbit-counters": "workspace:*"` to `dependencies` and `scribbit-counters` to `depends_on` in your `component.yaml`. (Not yet published to npm.)

```ts
import { classifyAssetName, createCpClient, encodeContent, estimateMint } from '@bsh/scribbit-counters';

const body = new TextEncoder().encode('hello, counters');
const asset = 'PRINTSHOP';

console.log(classifyAssetName(asset)); // 'named' (burns 0.5 XCP); 'A1234…' numeric, 'PARENT.child' subasset
const content = encodeContent(body, 'text/plain'); // { description, mime_type, kind } as compose expects

// Exact reveal weight, fee and commit value before calling Counterparty Core.
const est = estimateMint({ bytes: body.length, feeRate: 3, kind: 'counter', assetName: asset, mimeType: content.mime_type });
console.log(est.revealVsize, est.commitValue, est.xcpBurn, est.standardRelay); // 116 348 50000000n true (vB, sats, raw XCP burn, public relay)

// The mint itself goes through Counterparty Core v2 behind the product's allowlisted proxy (@bsh/scribbit-mint-api):
const cp = createCpClient({ baseUrl: 'https://mint.example/api/cp' }); // cp.compose(...), cp.getAsset(asset), cp.broadcast(...)
```

Runs as is with `tsx` (Node 22); the comments show its output. The full commit/reveal sequence (compose, `buildCommitPsbt`, `buildRevealPsbt`, sign, broadcast) is in
"Order of operations" below.

## What a counter is

A **counter** is a file committed to Bitcoin as a **Counterparty asset description carried in a v11 taproot
envelope**. Counters are numbered gap-free from #0 (XDUALS, block 902,005). A transaction counts
(build reference v3 §3–4) when **all** of the following hold:

1. It is a valid Counterparty **issuance** (creation, reissuance, subasset) or a **fairminter deploy**. Fairmints
   themselves never count.
2. Its `description` is **non-empty**. That is the content, stored by Counterparty consensus.
3. It is a Counterparty taproot **reveal**:
   - an output `OP_RETURN PUSH8 "CNTRPRTY"` (script `6a08434e545250525459`) that holds **only** the literal marker;
   - input 0 has a **3-item script-path witness** (signature, tapscript, control block).

Classic OP_RETURN descriptions never count, because they are ARC4-encrypted and cannot show the literal marker.
That is why every compose here uses `encoding=taproot`. Both envelope styles count:

- Core's native envelope;
- the ord-compatible wrapper (`inscription=true`), which ord indexers also number. `detectOrdEnvelope` tells them
  apart, because Core silently falls back to native when it cannot wrap.

### The three mint kinds

| `MintKind` | Compose | Parameters |
|---|---|---|
| `counter` | `compose/issuance` | `asset`, `quantity`, `divisible`, `lock` + the common set |
| `reinscription` | `compose/issuance` on an asset you own | `quantity=0`, the asset's **own** `divisible`, `lock=false` (see `supplyParams`) |
| `fairminter` | `compose/fairminter` | `fairminterComposeParams(p, asset)`; the file is the description (XCP-69 = `xcp69Params`) |

Every kind also sends the common set from `commonComposeParams`:

- `description` and `mime_type`, from `encodeContent`: text is sent as UTF-8, binary as hex, following Core's
  `classify_mime_type`;
- `encoding=taproot`, `inscription=<ord wrapper?>`, `sat_per_vbyte`, `verbose=true`,
  `exclude_utxos_with_balances=true`.

Named assets burn 0.5 XCP (`issuanceBurnXcp`). Numeric `A<n>` names and subassets are free. Core never picks a name
for you, so `randomNumericAsset` draws one.

## The re-key model

Core builds the envelope around a **random key**:

- the key's x-only pubkey sits at the end of the leaf (`… OP_ENDIF <key> OP_CHECKSIG`);
- the same key is the commit's taproot **internal key**;
- Core signs the reveal with it, then discards it.

Nobody can re-sign that reveal, so a stranded commit is lost.

This library keeps Core's message bytes and swaps **only the key**:

- `reKeyEnvelope(envelope, leafKey32)` replaces the trailing 32-byte key with a key this mint holds
  (`newRevealKey()` → `xOnlyPubkey`).
- `commitEnvelope(leaf, network)` commits under the BIP-341 **NUMS** internal key, as a single leaf. Nobody can
  key-path spend the commit; only the reveal opens it.
- A 32-byte key for a 32-byte key leaves the **script length unchanged**. So the reveal's size and the commit value
  Core computed stay valid. The tests assert this, and that `commitEnvelope(reKeyed)` differs from Core's commit
  only by the key.
- One byte is **not** in Core's arithmetic: Core prices a 64-byte `SIGHASH_DEFAULT` signature, while this engine
  signs `SIGHASH_ALL` (65 bytes) so that a wallet-signed reveal is a drop-in. `commitTopUp(compose, feeRate)` returns
  the satoshis that cover it (usually 0–2). It reads Core's *own* leaf, so a caller cannot make it return the whole
  commit value by mistake.

Because the reveal key is ours, a reveal that fails to broadcast can be rebuilt and re-signed at any time.

## Order of operations

The order is the one counters.fun uses in `mint.ts`. **The commit is broadcast before the reveal is signed.** The
compose's reveal spends the commit's txid, and a browser wallet asked to sign an input whose parent it cannot find
blocks and drops the request. So the reveal is signed only once the commit exists. The engine keeps this order even
when it signs the reveal itself, so a wallet can take that step instead.

```
idle → composing → signing-commit → broadcasting-commit → signing-reveal
     → [awaiting-commit]  (Slipstream only: MARA prices from the chain, so the commit must be MINED)
     → broadcasting-reveal → done | failed        (failed → signing-reveal on resume)
```

1. **composing**:
   - `estimateMint` prices the mint first;
   - `routeFor(revealVsize)` picks the route (for Slipstream, check `meetsFloor` *before* composing, because the
     commit cannot be resized later);
   - `cp.compose(...)`, then check `detectOrdEnvelope` against the style you asked for.
2. **signing-commit**:
   - `key = newRevealKey()`;
   - `buildCommitPsbt({ compose, leafKey32: xOnlyPubkey(key), utxos, changeAddress, feeRate, topUpSats: commitTopUp(compose, feeRate) })`;
   - the wallet signs `inputsToSign`;
   - `finalize`.
3. Build the reveal with `buildRevealPsbt({ compose, leafKey32, commitOutpoint: { txid, vout: commitVout }, commitValue, destinationAddress })`.
   `unsignedRevealTxid` is exact before signing. **Save a `PendingMint` now** (`savePendingMint(localStorage, …)`),
   before any money moves.
4. **broadcasting-commit**: `cp.broadcast(commitHex)`.
5. **signing-reveal**: `signRevealLocally(revealPsbt, key)`, then `finalize`.
6. **broadcasting-reveal**: `cp.broadcast` (and `cp.knowsTransaction` to confirm it landed), or
   `slipstream.handOffReveal` above 400k WU. Then `clearPendingMint`.

On reload, `loadPendingMint(store)` gives back the reveal PSBT and key. Resume at step 5.

`MintPlan` (`{ stage, …facts }`), `MINT_TRANSITIONS` and `canTransition` describe the state machine. The app runs it.

## API

| Export | Purpose |
|---|---|
| `createCpClient({ baseUrl, fetch? })` | Counterparty v2 through the mint-api proxy. It provides:<br>• `compose`: form-encoded POST;<br>• `getAsset`: `null` on 404;<br>• `getBalance`;<br>• `getOwnedAssets`: paged, descriptions dropped;<br>• `getTip`;<br>• `broadcast`: `signedhex` form;<br>• `knowsTransaction`.<br>Parsing is lossless for u64 values. |
| `commonComposeParams`, `supplyParams` | Compose parameters per kind (see above) |
| `ComposeResult` | Core v11 verbose compose response; each field used is documented in `src/compose.ts` |
| `classifyAssetName`, `issuanceBurnXcp`, `randomNumericAsset` | `'named' \| 'numeric' \| 'subasset' \| 'invalid'`; raw XCP burn (0.5 XCP = 50,000,000); a numeric name in (26¹², 2⁶⁴) |
| `encodeContent`, `classifyMimeType`, `guessContentType` | `{ description, mime_type, kind }` as compose expects; invalid UTF-8 under a text type is refused |
| `reKeyEnvelope`, `newRevealKey`, `revealKeyFromHex`, `xOnlyPubkey` | Key swap and reveal keys |
| `commitEnvelope`, `detectOrdEnvelope`, `NUMS_INTERNAL_KEY` | NUMS single-leaf commit (`address`, `script`, `controlBlock`, `tapLeafHash`); ord-wrapper detection |
| `buildCommitPsbt` | Commit PSBT, in one of two modes:<br>• with `utxos`: funded from those coins, largest first, change to `changeAddress`;<br>• with `utxos: []`: Core's inputs and change are reused, and the top-up comes out of change. |
| `buildRevealPsbt` | Script-path reveal with `witnessUtxo`, `tapLeafScript`, the NUMS `tapInternalKey`, and Core's outputs verbatim. The ord postage goes to `destinationAddress`. |
| `buildPlainPsbt`, `finalize`, `unsignedRevealTxid`, `signRevealLocally` | Plain compose → PSBT; finalize (`hex`, `txid`, `weight`, `vsize`); predicted txid; local script-path signing |
| `estimateMint`, `STANDARD_WITNESS_LIMIT_WU` | Pre-compose **exact** reveal weight and vsize, fee, commit value, XCP burn, and `standardRelay` (400,000 WU) |
| `commitTopUp`, `revealWeightOf` | Post-compose top-up for the SIGHASH_ALL byte; exact reveal weight from Core's reveal |
| `fairminterProblems`, `fairminterComposeParams` | Deploy validation in Core's order; compose parameters |
| `XCP69`, `xcp69Params`, `xcp69Schedule`, `xcp69ComposeParams`, `isXcp69Conformant` | xcp.fun's XCP-69 preset |
| `savePendingMint`, `loadPendingMint`, `clearPendingMint`, `memoryKV` | Resumable mint over `KV = { getItem, setItem, removeItem }` |
| `routeFor(vsize)`, `routeFitForWeight`, `meetsFloor`, `classify`, `parseRates`, `createSlipstreamClient` | `'public'` up to 100k vB, `'slipstream'` above (throws `OversizedRevealError` past 3.991M WU); MARA verdicts; client for the product's own `/api/slipstream` + `/api/reveal` proxy |

## Why `estimateMint` is exact

`estimateMint` rebuilds Core's envelope byte for byte:

- the CBOR message `[asset_id, quantity, divisible, lock, reset, mime_type, content]` (fairminter: the
  `fairminter_v2` field list);
- 520-byte chunks with minimal pushes;
- the ord wrapper's tags 7/1/5/0.

It then does the reveal arithmetic: one script-path input, `CNTRPRTY`, plus a 546-sat P2TR output for the ord
wrapper. `test/envelope.test.ts` rebuilds the two **real** Core envelopes captured by counters.fun byte-for-byte.
`test/estimate.test.ts` checks the predicted weight against reveals that were signed and finalized for real. It
covers:

- bodies of 0 to 99,000 bytes, across the push-size boundaries (75/76, 255/256, 520/521, 1040/1041);
- both envelope styles;
- reinscriptions and an XCP-69 fairminter.

It also checks Core's commit value and the top-up.

Two caveats:

- The exact weight assumes the asset name you pass. A subasset's id is drawn by Core, so its weight is an upper
  bound.
- After compose, `revealWeightOf(compose)` is authoritative.

## Provenance and licence

Ported from **counters.fun**, a sibling project of the same owner, so the code is reused, not third-party:

- `packages/counters/src/{assetnames,fees,fairminter,xcp69,numeric,slipstream}.ts`;
- `apps/web/src/lib/{inscribe/{envelope,psbt,mint,content},cp,pending-mint,slipstream}.ts`.

The protocol source of truth is the `counters` repository (`README.md`, `docs/build-reference-v3.md`). The
envelope, reveal and fee constructions mirror Counterparty Core's `lib/api/composer.py`.

What changed in the port:

- PSBTs are base64 rather than hex.
- The reveal is always signed with a key this mint holds. Wallet-key leaves still work: pass the wallet's taproot
  output key as `leafKey32` and let the wallet sign the reveal.
- The commit can be funded from caller UTXOs.
- `estimateMint` computes the weight exactly instead of from measured frame sizes.
- Everything framework- and `localStorage`-specific is behind `fetch` and `KV` ports.

## Interfaces

- Depends on: no `@bsh/*` packages (`@scure/btc-signer`, `@scure/base`, `@noble/curves`, `@noble/hashes`).
- Contracts: none (the library exposes a TypeScript API). It consumes Counterparty Core v2 through the product's
  proxy.
