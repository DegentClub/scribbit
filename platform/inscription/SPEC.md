# @bsh/inscription: public API specification

This is the contract other packages code against. Implementation lives in `src/`.
All byte values are `Uint8Array`; all amounts are **integer sats as `bigint`**; weights are integers (WU).

```ts
export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface InscriptionContent {
  contentType: string;          // e.g. "image/webp"
  body: Uint8Array;             // exact bytes inscribed
  parentId?: string;            // "<txid>i<index>" parent inscription id (tag 3)
  metadata?: Uint8Array;        // optional CBOR (tag 5)
}

export const LIMITS: {
  MAX_STANDARD_TX_WEIGHT: 400_000;
  MAX_BLOCK_WEIGHT: 4_000_000;
  BLOCK_LANE_MAX_TX_WEIGHT: 3_990_000;   // headroom for header + coinbase
  MAX_SCRIPT_ELEMENT_SIZE: 520;
  DUST_P2TR: 330n;
  DEFAULT_POSTAGE: 546n;
};

export type Lane = 'standard' | 'block';

// Envelope + commit
export function buildInscriptionScript(revealPubkey: Uint8Array /*32-byte x-only*/, content: InscriptionContent): Uint8Array;
export function commitAddress(revealPubkey: Uint8Array, content: InscriptionContent, network: Network): {
  address: string; script: Uint8Array /* P2TR scriptPubKey */; leafScript: Uint8Array; controlBlock: Uint8Array; tapLeafHash: Uint8Array;
};
export function encodeParentId(id: string): Uint8Array;   // txid reversed + LE index, trailing zeros trimmed (ord format)

// Sizing (EXACT: tests assert == real signed tx weight)
export function estimateRevealWeight(args: { content: InscriptionContent; withParent: boolean; recipientScript: Uint8Array; parentReturnScript?: Uint8Array; parentInputScript?: Uint8Array }): number;
export function vsizeFromWeight(weight: number): number;  // ceil(weight/4)
export function laneFor(revealWeight: number): Lane | null; // null = too big for any lane

// Fees / quote maths
export function quoteReveal(args: { revealWeight: number; feeRate: number /* sat/vB, may be fractional */; postage: bigint }): {
  revealVsize: number; revealFee: bigint; commitValue: bigint /* = revealFee + postage */;
};

// Sighash mode of the commit-input signature (ADR-0005). 0x81 is the default; 0x83 is kept for one release.
export type RevealSighashMode = 'all_anyonecanpay' /* 0x81 */ | 'single_anyonecanpay' /* 0x83 */;
export type RevealSighashType = 0x81 | 0x83;

// Reveal construction (browser side). Commit input at index 0, signed with `sighash`:
//   'all_anyonecanpay' (default): outputs [parentReturn, child] when withParent, else [child]; signature covers ALL outputs.
//   'single_anyonecanpay':        outputs [child]; signature covers only the output at the input's index.
// `withParent` defaults to `content.parentId !== undefined`. parentReturnAddress + parentValue are REQUIRED
// for 0x81 with a parent (the collection address and the parent's constant postage) and ignored otherwise.
export function buildHalfSignedReveal(args: {
  network: Network;
  revealPrivkey: Uint8Array;           // ephemeral K_e (32 bytes) — the user keeps it in their recovery bundle
  content: InscriptionContent;
  commitOutpoint: { txid: string; vout: number };
  commitValue: bigint;
  recipientAddress: string;            // child output
  postage: bigint;
  sighash?: RevealSighashMode;         // default 'all_anyonecanpay'
  withParent?: boolean;
  parentReturnAddress?: string;        // 0x81 + parent: output 0
  parentValue?: bigint;                // 0x81 + parent: value of output 0 (== parent UTXO value)
}): { psbtBase64: string; signature: Uint8Array /* 65 bytes incl. hash type */; sighashType: RevealSighashType };

// Service side: insert the parent input at index 0 (commit -> index 1). Result: [parent, commit] -> [parent return, child].
//   0x83 half-signed: also inserts the parent return output at index 0.
//   0x81 half-signed: the parent return output already exists (signed); throws unless output 0 == (parentReturnAddress, parentValue).
export function attachParent(args: {
  network: Network;
  halfSignedPsbtBase64: string;
  parentOutpoint: { txid: string; vout: number };
  parentValue: bigint;
  parentScript: Uint8Array;            // scriptPubKey of the parent UTXO (P2TR)
  parentReturnAddress: string;
}): { psbtBase64: string };            // unsigned input 0, signed input 1

// Service side: sign the parent input (key-path P2TR) with the collection key. Used by the policy signer.
export function signParentInput(psbtBase64: string, parentPrivkey: Uint8Array): { psbtBase64: string };

// Finalize to raw hex. Throws if any input is unsigned.
export function finalizeReveal(psbtBase64: string): { hex: string; txid: string; weight: number; vsize: number };

// Self-rescue by replay: [commit] -> [child] with the SAME signature, no parent. Valid for a 0x83 reveal and for a
// 0x81 reveal built with withParent=false; throws for a 0x81 reveal that pre-committed a parent return output.
export function buildRescueReveal(args: { network: Network; halfSignedPsbtBase64: string }): { hex: string; txid: string; weight: number; vsize: number };

// Self-rescue by re-signing (0x81 model): the user re-signs a fresh [commit] -> [child] with K_e, SIGHASH_DEFAULT
// (script-path spend of the same tapleaf). Child gets `postage`; commitValue - postage is the fee; no change output.
// With `feeRate`, throws if that fee is below ceil(vsize × feeRate) and reports the `overpay` above it.
export function buildResignedRescue(args: {
  network: Network; revealPrivkey: Uint8Array; content: InscriptionContent;
  commitOutpoint: { txid: string; vout: number }; commitValue: bigint;
  recipientAddress: string; postage: bigint; feeRate?: number;
}): { hex: string; txid: string; weight: number; vsize: number; fee: bigint; overpay?: bigint };

// Verification helpers (used by the service before storing a user-supplied half-signed reveal).
// expectedSighash defaults to 'all_anyonecanpay' (0x81). In 0x81 mode, expectedParentReturnAddress (+ expectedParentValue)
// requires outputs [parent return, child]; omitting it requires [child]. Ignored for 'single_anyonecanpay'.
export function verifyHalfSignedReveal(args: {
  network: Network; psbtBase64: string; revealPubkey: Uint8Array; content: InscriptionContent;
  expectedCommitOutpoint: { txid: string; vout: number }; expectedCommitValue: bigint;
  expectedRecipientAddress: string; expectedPostage: bigint;
  expectedSighash?: RevealSighashMode | RevealSighashType;
  expectedParentReturnAddress?: string; expectedParentValue?: bigint;
}): { ok: true } | { ok: false; reason: string };

// Utilities
export function sha256Hex(bytes: Uint8Array): string;
export function inscriptionIdFromReveal(revealTxid: string, index?: number): string; // "<txid>i0"
```

## Additions (implemented beyond the original contract; existing signatures unchanged)

```ts
export const REVEAL_TX_VERSION: 2; export const REVEAL_LOCKTIME: 0;
export const REVEAL_SEQUENCE: 0xfffffffd;          // nSequence of every reveal input (both layouts)
export const SIGHASH_ALL_ANYONECANPAY: 0x81; export const SIGHASH_SINGLE_ANYONECANPAY: 0x83;
export const DEFAULT_REVEAL_SIGHASH_MODE: RevealSighashMode; // 'all_anyonecanpay'
export function revealSighashType(mode?: RevealSighashMode | RevealSighashType): RevealSighashType; // mode -> hash-type byte
export const TAPSCRIPT_LEAF_VERSION: 0xc0;
export const NUMS_INTERNAL_KEY: Uint8Array;        // BIP341 H, internal key of every commit output
export function networkParams(network: Network): { bech32: string; pubKeyHash: number; scriptHash: number; wif: number };
export function inscriptionScriptLength(content: InscriptionContent): number;   // == buildInscriptionScript(...).length
export function addressToScript(address: string, network: Network): Uint8Array;
// EXACT weight of buildResignedRescue's transaction (rescue layout minus the 1-byte hash type).
export function estimateResignedRescueWeight(args: { content: InscriptionContent; recipientScript: Uint8Array }): number;
// Independent BIP341 digest of the commit input (script path, no annex) for hash type
//   0x83 (childScript/childValue: the output at the input's index),
//   0x81 (outputs: ALL outputs in order) or
//   0x00 SIGHASH_DEFAULT (outputs; single-input tx, input_index 0 — the re-signed rescue).
// sighashType defaults to 0x83 when childScript is given and to 0x81 when outputs is given.
export function revealCommitSighash(args: {
  commitOutpoint: { txid: string; vout: number }; commitValue: bigint; commitScript: Uint8Array; tapLeafHash: Uint8Array;
  childScript?: Uint8Array; childValue?: bigint;
  outputs?: { script: Uint8Array; value: bigint }[];
  sighashType?: number; version?: number; lockTime?: number; sequence?: number;
}): Uint8Array;
// buildRescueReveal additionally returns `vsize`.
```

Behavioural notes: `estimateRevealWeight` assumes a 34-byte P2TR parent return when
`parentReturnScript` is omitted and throws if `parentInputScript` is given and is not P2TR.
The parent return output carries exactly `parentValue` (required for the child inscription to land
on output 1): `buildHalfSignedReveal` signs it that way in 0x81, `attachParent` builds it that way
in 0x83, and `signParentInput` refuses otherwise. `buildHalfSignedReveal` and `buildResignedRescue`
require `postage >= DUST_P2TR` and `commitValue > postage`. Reveal weights are identical for 0x81
and 0x83 (65-byte commit signature either way), so `estimateRevealWeight` / `quoteReveal` are
mode-independent.

Migration from 0x83 (ADR-0002) to 0x81 (ADR-0005): browsers add `parentReturnAddress` + `parentValue`
and keep K_e in the user's recovery bundle; services add `expectedParentReturnAddress` +
`expectedParentValue` (and pass `expectedSighash: 'single_anyonecanpay'` while still accepting legacy
reveals); rescue tooling uses `buildResignedRescue` for 0x81 orders. 0x83 is removed one release later.

Funding PSBTs are built by `@bsh/wallet-kit` / the front end, not here.
