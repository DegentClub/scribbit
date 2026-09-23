# @bsh/inscription

Pure TypeScript library for building **ordinals inscriptions** with a commit/reveal flow whose
reveal is signed by the browser with `SIGHASH_ALL | SIGHASH_ANYONECANPAY` (0x81, default since
ADR-0005; `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` 0x83 remains available for one release), so a
service can later attach a collection **parent** without ever holding a key that moves user funds
([ADR-0002](../../docs/adr/0002-degent-mint-architecture.md)). The same code runs in the browser
and in the mint service: no network, no `Buffer`, only `Uint8Array` / `bigint`.

Built on `@scure/btc-signer` 2.x (PSBT + finalization) and `@noble/curves` / `@noble/hashes` 2.x.
The public contract is [SPEC.md](./SPEC.md).

## Flow

```
browser                                   service                         policy signer
───────                                   ───────                         ─────────────
K_e = random key
commitAddress(K_e.pub, content, net) ───► recompute + compare
quoteReveal(estimateRevealWeight(...))
buildHalfSignedReveal(...)  ────────────► verifyHalfSignedReveal(...)  (store)
  (0x81: [commit] → [parent return, child])
user funds commit output; keeps K_e in
the recovery bundle
                                          attachParent(...)  ───────────► signParentInput(...)
                                          finalizeReveal(...) → broadcast in lane
(timeout) buildResignedRescue(K_e, ...) → broadcast [commit] → [child] without parent
          (0x83 legacy: buildRescueReveal replays the half-signed PSBT instead)
```

## Security model

**Two sighash modes.** The browser signs the commit input with `SIGHASH_ANYONECANPAY` so the
service can add the parent input later; the output flag decides what else the signature covers:

| Mode | Hash type | Half-signed layout | Signature commits to | Rescue path |
|---|---|---|---|---|
| `'all_anyonecanpay'` (**default**, ADR-0005) | 0x81 | `[commit] → [parent return, child]` (or `[commit] → [child]` with `withParent: false`) | commit input + **every** output | `buildResignedRescue` (re-sign with K_e) |
| `'single_anyonecanpay'` (legacy, ADR-0002, one release) | 0x83 | `[commit] → [child]` | commit input + the output at its own index | `buildRescueReveal` (replay the half-signed PSBT) |

In both modes a BIP341 signature with `SIGHASH_ANYONECANPAY` does not commit to `input_index` or
to any other input, so the service inserting the parent input at index 0 (commit → index 1) does
not change the digest. What both cover: nVersion (2), nLockTime (0), the commit outpoint, amount,
scriptPubKey and nSequence (`0xfffffffd`), the inscription tapleaf, and the child output.

**0x81 (default): the browser pre-commits the parent return.** `buildHalfSignedReveal` takes
`parentReturnAddress` (the collection address) and `parentValue` (the parent's constant postage),
both known before signing, and builds `[commit] → [parent return, child]`. Because ALL covers
`sha_outputs`, nobody holding the PSBT can add an output, change output 0, swap outputs or drop
the parent return: the 0x83 fee-skimming and inscription re-targeting vectors below are closed by
construction. `attachParent` only inserts the parent input and asserts that the signed output 0
already equals the parent return address/value it was asked for. `verifyHalfSignedReveal` checks
`expectedParentReturnAddress` / `expectedParentValue` against output 0 and recomputes the 0x81
digest over both outputs from the order's expected values.

**0x81 rescue: K_e lives in the user's recovery bundle.** The half-signed 0x81 PSBT cannot be
broadcast without the parent (output 0 would be unfunded by the commit alone), so self-rescue is a
*fresh* transaction: `buildResignedRescue` takes the ephemeral key K_e plus the same order
parameters and fully signs `[commit] → [child]` with SIGHASH_DEFAULT (script-path spend of the
same tapleaf; child gets `postage`, the rest of `commitValue` is fee, no change output). The
browser must therefore keep K_e (and `content`, `commitOutpoint`, `commitValue`, recipient and
postage) in the user's recovery bundle — nothing in it moves any funds other than the commit
output the user funded. Both transactions spend the same commit outpoint, so whichever confirms
first wins and the other is invalid; the rescue carries no on-chain parent provenance. Pass
`feeRate` to have the rescue refuse an underfunded commit and report the `overpay` above that rate
(the commit was funded for the heavier parent layout, so some overpay is normal).

**0x83 (legacy): one signature, two layouts.** `buildHalfSignedReveal({ sighash:
'single_anyonecanpay' })` produces `[commit] → [child]` (commit and child both at index 0).
`attachParent` inserts the parent input and the parent return output at index 0, shifting commit
and child *together* to index 1. Neither the signed input's data nor the output at its index
changed, so the same 65-byte signature validates in both layouts, and the half-signed PSBT *is*
the rescue transaction (`buildRescueReveal` just finalizes it). The test suite computes the BIP341
digest independently (btc-signer's `preimageWitnessV1` and this package's `revealCommitSighash`)
in both layouts for both modes, asserts they are byte-identical, and Schnorr-verifies the signature.

**Known limitation of 0x83 (why it is no longer the default).** Anything the 0x83 signature does
not commit to can be chosen by whoever holds the half-signed PSBT:

- *Fee skimming.* Extra outputs at index ≥ 2 can take part of `commitValue − postage`.
- *Inscription re-targeting.* Someone can put their **own** input at index 0 with a value that
  differs from their output 0, which moves the offset of the new inscription's sat out of the child
  output (into an output they control, or into fees). The child output still receives its postage,
  but not the inscription.

Holders are the browser, the service and (after a rescue broadcast) mempool observers, who can
RBF-replace the rescue transaction if they pay a higher absolute fee. If you still use 0x83, keep
the half-signed PSBT confidential until broadcast and broadcast promptly. With 0x81 these vectors
are gone: the only degrees of freedom left to a PSBT holder are the parent input's outpoint and
value, and `signParentInput` refuses a parent input whose value differs from output 0.

**What the service can and cannot do (both modes).** It cannot change the recipient, postage,
commit amount, content, nVersion, nLockTime or nSequence (all signed). `verifyHalfSignedReveal`
re-derives every signed field from the *order's* expected values (it trusts nothing in the PSBT
except the signature), checks the hash type matches `expectedSighash` (default 0x81) and verifies
the Schnorr signature, so a service never stores a reveal that would not inscribe exactly the
previewed bytes to exactly the quoted address.

**Parent return value is exact.** ord puts a new inscription on the first sat of the input that
carries the envelope, i.e. at offset `parentValue` in the parent layout. For that sat to be the
first sat of output 1 (the child), output 0 must carry exactly `parentValue`. In 0x81 the browser
signs it that way; in 0x83 `attachParent` builds it that way; `signParentInput` refuses anything
else in both modes. (ADR-0002 §3 says "≥"; a larger return would move the child inscription into
the parent return output.)

**Migration (0x83 → 0x81).**

- Browser: pass `parentReturnAddress` + `parentValue` to `buildHalfSignedReveal` when the order
  has a parent (`withParent` defaults to `content.parentId !== undefined`); store K_e in the user's
  recovery bundle. To keep the old behaviour for one release, pass `sighash: 'single_anyonecanpay'`.
- Service: pass `expectedParentReturnAddress` + `expectedParentValue` to `verifyHalfSignedReveal`
  (and `expectedSighash: 'single_anyonecanpay'` while still accepting legacy reveals).
  `attachParent`, `signParentInput` and `finalizeReveal` are unchanged.
- Rescue tooling: `buildRescueReveal` keeps working for 0x83 PSBTs and for 0x81 PSBTs built with
  `withParent: false`; it throws for a 0x81 PSBT that pre-committed a parent return, pointing at
  `buildResignedRescue`. Weight and fee maths are identical in both modes (the tests assert it).

## API

| Export | Purpose |
|---|---|
| `LIMITS` | Policy/consensus constants (400k standard, 3.99M block lane, 520-byte push, dust, default postage) |
| `buildInscriptionScript(pub, content)` | ord envelope tapscript, byte-for-byte as ord emits it |
| `inscriptionScriptLength(content)` * | Length of that script without allocating it |
| `encodeParentId(id)` | `txid` reversed + LE index, trailing zeros trimmed |
| `commitAddress(pub, content, network)` | P2TR(NUMS, single leaf): address, scriptPubKey, leaf, control block, leaf hash |
| `addressToScript(address, network)` * | scriptPubKey for an address (throws on wrong network) |
| `estimateRevealWeight(args)` | **Exact** weight of the signed reveal, both layouts, both sighash modes |
| `estimateResignedRescueWeight(args)` * | **Exact** weight of `buildResignedRescue` (rescue layout − 1 WU: no hash-type byte) |
| `vsizeFromWeight(w)` / `laneFor(w)` | `ceil(w/4)` / `'standard' \| 'block' \| null` |
| `quoteReveal({revealWeight, feeRate, postage})` | `revealFee = ceil(vsize × feeRate)` in exact decimal; `commitValue = fee + postage` |
| `buildHalfSignedReveal(args)` | Browser: commit input signed 0x81 (default: `[commit] → [parent return, child]`) or 0x83 (`sighash: 'single_anyonecanpay'`, `[commit] → [child]`) |
| `verifyHalfSignedReveal(args)` | Service: full structural + content + signature check for `expectedSighash` (default 0x81, incl. parent return output), with a reason on failure |
| `attachParent(args)` | Service: `[parent, commit] → [parent return, child]`; inserts the return output only for 0x83, asserts it for 0x81 |
| `signParentInput(psbt, key)` | Policy signer: key-path SIGHASH_DEFAULT on input 0 (BIP86-style tweaked key) |
| `finalizeReveal(psbt)` | Raw hex, txid, weight, vsize; throws if any input is unsigned |
| `buildRescueReveal(args)` | 0x83 rescue: finalize the half-signed PSBT as-is (hex, txid, weight, vsize*) |
| `buildResignedRescue(args)` * | 0x81 rescue: re-sign `[commit] → [child]` with K_e, SIGHASH_DEFAULT (hex, txid, weight, vsize, fee, overpay?) |
| `revealCommitSighash(args)` * | Independent BIP341 script-path digest of the commit input for 0x83, 0x81 or SIGHASH_DEFAULT |
| `sha256Hex`, `inscriptionIdFromReveal` | Utilities |
| `NUMS_INTERNAL_KEY`*, `REVEAL_TX_VERSION`*, `REVEAL_LOCKTIME`*, `REVEAL_SEQUENCE`*, `SIGHASH_ALL_ANYONECANPAY`*, `SIGHASH_SINGLE_ANYONECANPAY`*, `DEFAULT_REVEAL_SIGHASH_MODE`*, `revealSighashType`*, `TAPSCRIPT_LEAF_VERSION`*, `networkParams`* | Constants / helpers (`RevealSighashMode` = `'all_anyonecanpay' \| 'single_anyonecanpay'`) |

`*` = addition beyond the original SPEC (listed in SPEC.md under "Additions").

## Example

```ts
import { schnorr } from '@noble/curves/secp256k1.js';
import * as ins from '@bsh/inscription';

// Browser
const kE = schnorr.utils.randomSecretKey();
const content = { contentType: 'image/webp', body, parentId: COLLECTION_PARENT_ID };
const commit = ins.commitAddress(schnorr.getPublicKey(kE), content, 'mainnet');
const weight = ins.estimateRevealWeight({
  content, withParent: true,
  recipientScript: ins.addressToScript(userOrdinalsAddress, 'mainnet'),
});
const lane = ins.laneFor(weight);                     // 'standard' | 'block' | null
const quote = ins.quoteReveal({ revealWeight: weight, feeRate: 2.5, postage: ins.LIMITS.DEFAULT_POSTAGE });
// ... wallet funds commit.address with quote.commitValue; the funding txid is known before signing
const half = ins.buildHalfSignedReveal({
  network: 'mainnet', revealPrivkey: kE, content,
  commitOutpoint: { txid: fundingTxid, vout: 0 }, commitValue: quote.commitValue,
  recipientAddress: userOrdinalsAddress, postage: ins.LIMITS.DEFAULT_POSTAGE,
  // default sighash 'all_anyonecanpay' (0x81): the parent return output is signed up front
  parentReturnAddress: COLLECTION_ADDRESS, parentValue: COLLECTION_PARENT_POSTAGE,
});
// ... the user's recovery bundle keeps kE + content + commit outpoint/value + recipient + postage

// Service
const v = ins.verifyHalfSignedReveal({ network: 'mainnet', psbtBase64: half.psbtBase64, revealPubkey, content,
  expectedCommitOutpoint, expectedCommitValue, expectedRecipientAddress, expectedPostage,
  expectedParentReturnAddress: COLLECTION_ADDRESS, expectedParentValue: COLLECTION_PARENT_POSTAGE });
if (!v.ok) throw new Error(v.reason);
const { psbtBase64 } = ins.attachParent({ network: 'mainnet', halfSignedPsbtBase64: half.psbtBase64,
  parentOutpoint, parentValue, parentScript, parentReturnAddress });
const signed = ins.signParentInput(psbtBase64, collectionKey);   // behind the PolicySigner port
const { hex, txid, weight: w } = ins.finalizeReveal(signed.psbtBase64);
const inscriptionId = ins.inscriptionIdFromReveal(txid);          // "<txid>i0"

// Rescue (no parent): re-sign with kE from the recovery bundle
const rescue = ins.buildResignedRescue({
  network: 'mainnet', revealPrivkey: kE, content,
  commitOutpoint: { txid: fundingTxid, vout: 0 }, commitValue: quote.commitValue,
  recipientAddress: userOrdinalsAddress, postage: ins.LIMITS.DEFAULT_POSTAGE, feeRate: 2,
});

// Legacy 0x83 (one release): `sighash: 'single_anyonecanpay'` on build, `expectedSighash` on verify,
// and the half-signed PSBT is the rescue: ins.buildRescueReveal({ network, halfSignedPsbtBase64 }).
```

## Sizes and lanes (real numbers)

Computed by `estimateRevealWeight` (which the tests prove equals the signed transaction) for
`contentType = "image/webp"`, a parent id with index 0, P2TR recipient and P2TR parent return.
Fee shown at 2 sat/vB. Weights are identical for 0x81 and 0x83 (both carry a 65-byte commit
signature). The rescue layout inscribes the same envelope (parent tag included) and is exactly
402 WU lighter (`buildRescueReveal`); the re-signed rescue (`buildResignedRescue`, SIGHASH_DEFAULT,
64-byte signature) is 1 WU lighter still.

| Body bytes | Weight with parent (WU) | vsize | Lane | Fee @ 2 sat/vB | Weight, rescue layout | Lane |
|---:|---:|---:|---|---:|---:|---|
| 1 | 974 | 244 | standard | 488 | 572 | standard |
| 1,000 | 1,980 | 495 | standard | 990 | 1,578 | standard |
| 205,000 | 207,160 | 51,790 | standard | 103,580 | 206,758 | standard |
| 390,000 | 393,226 | 98,307 | standard | 196,614 | 392,824 | standard |
| 400,000 | 403,285 | 100,822 | block | 201,644 | 402,883 | block |
| 1,000,000 | 1,006,746 | 251,687 | block | 503,374 | 1,006,344 | block |
| 3,900,000 | 3,923,476 | 980,869 | block | 1,961,738 (≈0.0196 BTC) | 3,923,074 | block |
| 3,960,000 | 3,983,823 | 995,956 | block | 1,991,912 | 3,983,421 | block |

Largest body per lane (same assumptions): **standard 396,735 bytes** with parent (397,134
for the rescue layout); **block 3,966,141 bytes** with parent (3,966,542 rescue). Beyond that `laneFor` returns
`null`.

The parent costs exactly `4 × (41 + 43) + 66 = 402` WU: one 41-byte input, one 43-byte P2TR
output, and a 1-item witness holding a 64-byte key-path signature.

## Why the weight estimate is exact (and how the tests prove it)

`estimateRevealWeight` is arithmetic over the serialization, with no upper-bound fudge:

- non-witness bytes × 4: version, CompactSize input/output counts, 41 bytes per input (outpoint +
  empty scriptSig + nSequence), outputs as `8 + CompactSize(len) + len`, locktime;
- witness bytes × 1: marker+flag (2), commit stack `CompactSize(3) | 1+65 sig | CompactSize(L)+L
  leaf | 1+33 control block`, and for the parent a `1 | 1+64` key-path stack;
- `L` is computed by the same code that builds the envelope (minimal push per ≤520-byte chunk:
  direct / PUSHDATA1 / PUSHDATA2).

Schnorr signatures are fixed-size (64 bytes, +1 for a non-default sighash), so there is no ECDSA
style ±1 variance. `test/weight.test.ts` builds, signs (browser key and parent key) and finalizes
real transactions for bodies of 1, 100, 520, 521, 10k, 200k, 390k, 400k, 1M and 3.9M bytes, in
**both** layouts and **both** sighash modes (and asserts 0x81 and 0x83 weigh the same). It then
asserts `estimateRevealWeight(...)` / `estimateResignedRescueWeight(...)` equal three independent
measurements: the weight from `finalizeReveal` / `buildRescueReveal` / `buildResignedRescue`, the
weight recomputed from the raw hex (`3 × stripped + total`), and btc-signer's
`Transaction.fromRaw(hex).weight`.

## Tests

`pnpm --filter @bsh/inscription test` (vitest, about 6 s) and `pnpm --filter @bsh/inscription typecheck`.

| File | Covers |
|---|---|
| `envelope.test.ts` | Opcode-level decode of the envelope; 0/1/519/520/521/1040/1041-byte chunking; push opcodes; tags 1/3/5 order; parent id encoding for index 0/1/255/256/2³²−1 |
| `commit.test.ts` | NUMS key; frozen bc1p/tb1p/bcrt1p vectors cross-checked with btc-signer `p2tr` |
| `weight.test.ts` | Exact weight vs real signed transactions, both layouts, both sighash modes (0x81 == 0x83), re-signed rescue; lanes and boundaries |
| `signature.test.ts` | 0x83 and 0x81: equal BIP341 sighash in both layouts, Schnorr verification; tampering with the child output, commit amount, output order, nSequence or nVersion breaks it; 0x81 only: an extra output or a changed/dropped parent return breaks it |
| `verify.test.ts` | `verifyHalfSignedReveal` positive and negative cases in both modes: content, key, recipient, postage, outpoint, value, sighash type (incl. default 0x81 rejecting 0x83), parent return address/value, forged signature, extra outputs, no-parent 0x81 |
| `parent.test.ts` | attachParent layout in both modes (0x81: asserts, never duplicates, the parent return), parent key-path signature against the tweaked key, finalization, error paths, buildRescueReveal refusing a parent-committed 0x81 PSBT |
| `rescue.test.ts` | `buildResignedRescue`: script-path spend with a 64-byte SIGHASH_DEFAULT signature verified over the BIP341 digest (btc-signer and ours), exact weight, fee/overpay, same commit outpoint as the service reveal |
| `quote.test.ts` | Fee maths incl. fractional rates (1.1 × 1000 = 1100, not 1101) and a quote funding a real reveal |

## Envelope notes

- Tags are single-byte data pushes (`0x01 0x01`, not `OP_1`), and the body tag is `OP_0`, as ord's
  `push_slice` emits them. The pushes sit inside `OP_FALSE OP_IF`, so MINIMALDATA (which only
  applies to executed pushes) does not apply. The 520-byte push limit applies to every push, so
  `contentType` longer than 520 bytes is rejected.
- Metadata (tag 5) is emitted as ord does: one `0x05` tag before **each** ≤520-byte chunk.
- An empty body emits only the `OP_0` body tag. Empty metadata is omitted. `contentType` must be
  non-empty.
