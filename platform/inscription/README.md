# @bsh/inscription

Pure TypeScript library for building **ordinals inscriptions** with a commit/reveal flow whose
reveal is signed by the browser with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (0x83), so a service
can later attach a collection **parent** without ever holding a key that moves user funds
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
user funds commit output
                                          attachParent(...)  ───────────► signParentInput(...)
                                          finalizeReveal(...) → broadcast in lane
(timeout) buildRescueReveal(...) → broadcast without parent
```

## Security model

**Why 0x83.** A BIP341 signature with `SIGHASH_ANYONECANPAY` does not commit to `input_index` or to
any other input; with `SIGHASH_SINGLE` it commits only to the output at the *same index* as the
input. The commit-input signature therefore covers exactly: nVersion (2), nLockTime (0), the commit
outpoint, amount, scriptPubKey and nSequence (`0xfffffffd`), the child output (recipient script +
postage) and the inscription tapleaf. It does **not** cover the parent input or the parent return
output.

**One signature, two layouts.** `buildHalfSignedReveal` produces `[commit] → [child]` (commit and
child both at index 0). `attachParent` inserts the parent input and the parent return output at
index 0, shifting commit and child *together* to index 1. Neither the signed input's data nor the
output at its index changed, so the same 65-byte signature validates in both layouts. The test
suite computes the BIP341 digest independently (btc-signer's `preimageWitnessV1` and this
package's `revealCommitSighash`) in both layouts, asserts they are byte-identical, and
Schnorr-verifies the signature against it.

**Self-rescue.** Because the half-signed PSBT *is* the rescue transaction, `buildRescueReveal` just
finalizes it. If the service disappears, the user (or anyone holding the PSBT) broadcasts it: the
inscription lands without on-chain parent provenance.

**What the service can and cannot do.** It cannot change the recipient, postage, commit amount,
content, nVersion, nLockTime or nSequence (all signed). `verifyHalfSignedReveal` re-derives every
signed field from the *order's* expected values (it trusts nothing in the PSBT except the
signature) and verifies the Schnorr signature, so a service never stores a reveal that would not
inscribe exactly the previewed bytes to exactly the quoted address.

**Parent return value is exact.** ord puts a new inscription on the first sat of the input that
carries the envelope, i.e. at offset `parentValue` in the parent layout. For that sat to be the
first sat of output 1 (the child), output 0 must carry exactly `parentValue`. `attachParent`
builds it that way and `signParentInput` refuses anything else. (ADR-0002 §3 says "≥"; a larger
return would move the child inscription into the parent return output.)

**Known limitation of 0x83 (important).** Anything the signature does not commit to can be chosen
by whoever holds the half-signed PSBT:

- *Fee skimming.* Extra outputs at index ≥ 2 can take part of `commitValue − postage`.
- *Inscription re-targeting.* Someone can put their **own** input at index 0 with a value that
  differs from their output 0, which moves the offset of the new inscription's sat out of the child
  output (into an output they control, or into fees). The child output still receives its postage,
  but not the inscription.

Holders are the browser, the service and (after a rescue broadcast) mempool observers, who can
RBF-replace the rescue transaction if they pay a higher absolute fee. So the half-signed PSBT is
confidential until broadcast, and the service should broadcast promptly. A service-side
mitigation such as `SIGHASH_ALL|ANYONECANPAY` with a pre-committed parent return output would
remove the re-targeting vector but give up the no-parent rescue. That is an ADR decision and is
out of scope for this library.

## API

| Export | Purpose |
|---|---|
| `LIMITS` | Policy/consensus constants (400k standard, 3.99M block lane, 520-byte push, dust, default postage) |
| `buildInscriptionScript(pub, content)` | ord envelope tapscript, byte-for-byte as ord emits it |
| `inscriptionScriptLength(content)` * | Length of that script without allocating it |
| `encodeParentId(id)` | `txid` reversed + LE index, trailing zeros trimmed |
| `commitAddress(pub, content, network)` | P2TR(NUMS, single leaf): address, scriptPubKey, leaf, control block, leaf hash |
| `addressToScript(address, network)` * | scriptPubKey for an address (throws on wrong network) |
| `estimateRevealWeight(args)` | **Exact** weight of the signed reveal, both layouts |
| `vsizeFromWeight(w)` / `laneFor(w)` | `ceil(w/4)` / `'standard' \| 'block' \| null` |
| `quoteReveal({revealWeight, feeRate, postage})` | `revealFee = ceil(vsize × feeRate)` in exact decimal; `commitValue = fee + postage` |
| `buildHalfSignedReveal(args)` | Browser: `[commit] → [child]`, commit input signed 0x83 |
| `verifyHalfSignedReveal(args)` | Service: full structural + content + signature check, with a reason on failure |
| `attachParent(args)` | Service: `[parent, commit] → [parent return, child]` |
| `signParentInput(psbt, key)` | Policy signer: key-path SIGHASH_DEFAULT on input 0 (BIP86-style tweaked key) |
| `finalizeReveal(psbt)` | Raw hex, txid, weight, vsize; throws if any input is unsigned |
| `buildRescueReveal(args)` | Finalize the half-signed PSBT as-is (hex, txid, weight, vsize*) |
| `revealCommitSighash(args)` * | Independent BIP341 0x83 script-path digest of the commit input |
| `sha256Hex`, `inscriptionIdFromReveal` | Utilities |
| `assignSats(inputs, outputs)` * | ord's FIFO sat assignment: which output (or the fee) every inscription and sat range lands in |
| `inscriptionDestination(tx, inputIndex, offset)` * | `{ vout, offset } \| 'fee'` for one inscription, from input/output values alone |
| `assertNoInscriptionBurn(inputs, outputs)` * | `assignSats`, throwing `InscriptionBurnError` if anything lands in the fee |
| `checkInscriptionCoverage(inputs, outputs)` * | The layout invariant that makes a burn impossible (see "Sat assignment") |
| `NUMS_INTERNAL_KEY`*, `REVEAL_TX_VERSION`*, `REVEAL_LOCKTIME`*, `REVEAL_SEQUENCE`*, `SIGHASH_SINGLE_ANYONECANPAY`*, `TAPSCRIPT_LEAF_VERSION`*, `networkParams`* | Constants / helpers |

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
});

// Service
const v = ins.verifyHalfSignedReveal({ network: 'mainnet', psbtBase64: half.psbtBase64, revealPubkey, content,
  expectedCommitOutpoint, expectedCommitValue, expectedRecipientAddress, expectedPostage });
if (!v.ok) throw new Error(v.reason);
const { psbtBase64 } = ins.attachParent({ network: 'mainnet', halfSignedPsbtBase64: half.psbtBase64,
  parentOutpoint, parentValue, parentScript, parentReturnAddress });
const signed = ins.signParentInput(psbtBase64, collectionKey);   // behind the PolicySigner port
const { hex, txid, weight: w } = ins.finalizeReveal(signed.psbtBase64);
const inscriptionId = ins.inscriptionIdFromReveal(txid);          // "<txid>i0"

// Rescue (no parent)
const rescue = ins.buildRescueReveal({ network: 'mainnet', halfSignedPsbtBase64: half.psbtBase64 });
```

## Sat assignment

ord assigns sats **FIFO**: concatenate the sats of every input, in input order, into one stream; outputs
take contiguous chunks from it in output order; the tail is the fee. An inscription rides one sat, so
where it goes is arithmetic over values only: `position = sum(values of the inputs before it) + offset`,
then the first output whose cumulative end exceeds `position`, or the fee when `position >= sum(outputs)`.
`sat-assignment.ts` implements exactly that rule (pure, `bigint`-safe, no I/O) so a transaction can be
checked *before* it is signed:

```ts
import { assignSats, assertNoInscriptionBurn, inscriptionDestination } from '@bsh/inscription';

// ADR-0002 reveal: [parent][commit] -> [parent return][child postage]
inscriptionDestination({ inputs: [{ value: parentValue }, { value: commitValue }], outputs: [{ value: parentValue }, { value: postage }] }, 1, 0);
// -> { vout: 1, offset: 0n }      (parent return of parentValue + 1 would give { vout: 0, offset: parentValue })

const r = assertNoInscriptionBurn(
  [{ value: 777, inscriptions: [{ id, offset: 0 }] }, { value: 30_000 }],     // shave: inscription input first
  [{ value: 1 }, { value: 776 }, { value: 29_000 }],
);
r.outputs[0].inscriptions;   // [{ id, offset: 0n, sat, input: 0, inputOffset: 0n }]
r.fee;                       // { value: 1000n, ranges: [{ unknown: 1000n }], inscriptions: [] }
```

Inputs may carry `sats: SatRange[]` (`{ start, end }` half-open sat numbers, or `{ unknown: n }` for a UTXO whose
numbering is not known); ranges are sliced into each output and the fee, one range per input chunk, so `sat` is
reported for every placed inscription whose input was numbered. Consequences the tests pin down:

- Each output gets **one contiguous slice**, so two inscriptions separated by padding cannot share an output in a
  single transaction: shave each to `[1 sat][rest]` first, then pack the 1-sat outputs (`N` one-sat inputs → one
  `N`-sat output with the inscriptions at offsets `0..N-1`).
- A funding input placed **ahead** of inscription inputs shifts every inscription behind it; whatever slides past
  `sum(outputs)` is burned to the fee. The classic marketplace bug is the same rule: inscription input 0 with the
  price at output 0 hands the inscription back to the seller; two dummy inputs ahead of it move it to output 1.
- **Safety invariant** (`checkInscriptionCoverage`): every inscription input strictly ahead of every funding input
  and `sum(outputs) >= total value of the inscription inputs` guarantees no burn whatever the output layout, even
  with no change output. A property test checks it against random layouts.
- The reveal layout's "parent return value is exact" rule above is this rule applied to `[parent][commit]`.

### Shared vectors (`test/vectors/fifo.json`)

`test/sat-assignment.test.ts` loads `test/vectors/fifo.json` when present and runs every case through both
`assignSats` and `inscriptionDestination`. `DegentClub/blockspace-holdings` produces `tests/vectors/fifo.json` in
the same shape so both implementations are checked against one set. The file is a JSON array of cases:

```json
{
  "name": "shave: [insc 777] + funding -> [1][776][change]",
  "inputs": [ { "value": 777, "inscriptions": [ { "id": "i", "offset": 0 } ] }, { "value": 30000 } ],
  "outputs": [ { "value": 1 }, { "value": 776 }, { "value": 29000 } ],
  "expect": { "i": { "vout": 0, "offset": 0 } }
}
```

`inputs[].value`, `outputs[].value` and offsets are JSON integers (sats); `inputs[].inscriptions` is optional (absent
= funding input); `expect` has one entry per inscription id, `{ "vout": <index>, "offset": <sats into that output> }`
or `{ "vout": "fee", "offset": <sats into the fee tail> }` for a burn. Every inscription id must appear in `expect`.

## Sizes and lanes (real numbers)

Computed by `estimateRevealWeight` (which the tests prove equals the signed transaction) for
`contentType = "image/webp"`, a parent id with index 0, P2TR recipient and P2TR parent return.
Fee shown at 2 sat/vB. The rescue layout inscribes the same envelope (parent tag included) and is
exactly 402 WU lighter.

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
**both** layouts. It then asserts `estimateRevealWeight(...)` equals three independent
measurements: the weight from `finalizeReveal` / `buildRescueReveal`, the weight recomputed from
the raw hex (`3 × stripped + total`), and btc-signer's `Transaction.fromRaw(hex).weight`.

## Tests

`pnpm --filter @bsh/inscription test` (vitest, about 3 s) and `pnpm --filter @bsh/inscription typecheck`.

| File | Covers |
|---|---|
| `envelope.test.ts` | Opcode-level decode of the envelope; 0/1/519/520/521/1040/1041-byte chunking; push opcodes; tags 1/3/5 order; parent id encoding for index 0/1/255/256/2³²−1 |
| `commit.test.ts` | NUMS key; frozen bc1p/tb1p/bcrt1p vectors cross-checked with btc-signer `p2tr` |
| `weight.test.ts` | Exact weight vs real signed transactions, both layouts; lanes and boundaries |
| `signature.test.ts` | Equal BIP341 sighash in both layouts, Schnorr verification; tampering with the child output, commit amount, output order, nSequence or nVersion breaks it |
| `verify.test.ts` | `verifyHalfSignedReveal` positive and negative cases: content, key, recipient, postage, outpoint, value, sighash type, forged signature, extra outputs |
| `parent.test.ts` | attachParent layout, parent key-path signature against the tweaked key, finalization, error paths |
| `quote.test.ts` | Fee maths incl. fractional rates (1.1 × 1000 = 1100, not 1101) and a quote funding a real reveal |
| `sat-assignment.test.ts` | FIFO rule: offset-0 placement, marketplace bug vs fixed layout, shave, pack, funding-first burn, the coverage invariant (property test), the ADR-0002 reveal layout, sat ranges, bigint safety, error paths; plus every case in `test/vectors/fifo.json` |

## Envelope notes

- Tags are single-byte data pushes (`0x01 0x01`, not `OP_1`), and the body tag is `OP_0`, as ord's
  `push_slice` emits them. The pushes sit inside `OP_FALSE OP_IF`, so MINIMALDATA (which only
  applies to executed pushes) does not apply. The 520-byte push limit applies to every push, so
  `contentType` longer than 520 bytes is rejected.
- Metadata (tag 5) is emitted as ord does: one `0x05` tag before **each** ≤520-byte chunk.
- An empty body emits only the `OP_0` body tag. Empty metadata is omitted. `contentType` must be
  non-empty.
