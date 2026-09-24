/**
 * Fee and size maths, before compose, in the units the node uses.
 *
 * Counterparty takes `sat_per_vbyte` as a float and funds the commit output
 * with `max(ceil(rate × reveal_vsize) + reveal_outputs, 330)`, 330 being the
 * segwit dust floor (`composer.py`, `prepare_taproot_output`). The reveal
 * vsize is measured over its own dummy-signed reveal, whose SIGHASH_DEFAULT
 * signature is 64 bytes; a SIGHASH_ALL reveal is one witness byte heavier,
 * and `commitTopUp` covers that byte after compose. `estimateMint` reproduces
 * both numbers from the message shape so a mint can be priced — and refused
 * as oversized — before Core is asked for anything.
 *
 * Unlike counters.fun's `estimateMint` (frame sizes measured once from Core),
 * this rebuilds the envelope byte-for-byte, so the weight is exact for the
 * given inputs; `test/estimate.test.ts` pins it against a real signed reveal.
 */

import { compactSizeLen } from './bytes.js';
import { assetId, checkAssetName, compactSubassetLongname, issuanceBurnXcp } from './assetnames.js';
import { type CborValue } from './cbor.js';
import { buildCoreEnvelope, MESSAGE_TYPE } from './envelope.js';
import { fairminterMessageFields, type FairminterParams } from './fairminter.js';
import { REGULAR_DUST, SEGWIT_DUST } from './psbt.js';
import { xcp69Params } from './xcp69.js';

/** Bitcoin Core policy: the heaviest transaction the public network relays. */
export const STANDARD_WITNESS_LIMIT_WU = 400_000;

export type MintKind = 'counter' | 'reinscription' | 'fairminter';

export const vbytesOf = (weight: number): number => Math.ceil(weight / 4);
export const feeFor = (vbytes: number, rate: number): number => Math.ceil(vbytes * rate);

/** The OP_RETURN that makes a reveal a counter: `OP_RETURN PUSH8 "CNTRPRTY"`. */
export const CNTRPRTY_OP_RETURN_SCRIPT_LEN = 10;
/** Core sends the ord wrapper's 546 sat to the source's change address — a P2TR output here. */
const P2TR_SCRIPT_LEN = 34;

export interface EstimateMintArgs {
  /** Content length in bytes. */
  bytes: number;
  feeRate: number;
  kind: MintKind;
  /** The asset composed; a numeric name is assumed (the largest CBOR integer) when absent. */
  assetName?: string;
  /** `counterparty/ord` style: Core's envelope inside an ordinals-compatible one. */
  hasOrdWrapper?: boolean;
  /** Defaults to `text/plain`. Only its length matters. */
  mimeType?: string;
  /** Raw units; `counter` only (a reinscription is always 0). Only its CBOR width matters. */
  quantity?: bigint;
  /** `fairminter` only: the sale; XCP-69 scheduled at block 1,000,000 when absent. */
  fairminter?: FairminterParams;
}

export interface MintEstimate {
  /** Weight of the SIGHASH_ALL reveal this engine signs (Core's + 1 WU). */
  revealWeight: number;
  revealVsize: number;
  /** Satoshis the reveal pays: the commit value minus the reveal's outputs. */
  revealFee: number;
  /** What the commit output must hold: Core's value plus the SIGHASH_ALL top-up. */
  commitValue: number;
  /** Satoshis Core will fund the commit with (its own 64-byte-signature arithmetic, 330 floor). */
  coreCommitValue: number;
  /** Value of the reveal's outputs: 0 native, 546 with the ord wrapper. */
  revealOutputs: number;
  /** Raw XCP burned: 0.5 XCP for a named asset (a reinscription burns nothing). */
  xcpBurn: bigint;
  /** Whether the public network will relay the reveal. Past this it needs Slipstream. */
  standardRelay: boolean;
  /** Length of the tapscript leaf. */
  envelopeBytes: number;
}

function messageFields(args: EstimateMintArgs): { typeId: number; fields: CborValue[] } {
  const check = args.assetName ? checkAssetName(args.assetName) : null;
  // A subasset's own id is a numeric one Core draws at compose time: size for the widest.
  const id = check?.ok && check.kind !== 'subasset' ? assetId(args.assetName!) : 2n ** 64n - 1n;
  if (args.kind === 'fairminter') {
    const p = args.fairminter ?? xcp69Params(1_000_000);
    const parent = check?.ok && check.kind === 'subasset' ? assetId(check.parent!) : 0n;
    return { typeId: MESSAGE_TYPE.FAIRMINTER, fields: fairminterMessageFields(p, id, parent) };
  }
  const quantity = args.kind === 'reinscription' ? 0n : (args.quantity ?? 0n);
  if (check?.ok && check.kind === 'subasset' && args.kind === 'counter') {
    // Initial subasset issuance: numeric asset id (drawn by Core), compacted child name.
    const child = args.assetName!.slice(args.assetName!.indexOf('.') + 1);
    const compact = compactSubassetLongname(child);
    return { typeId: MESSAGE_TYPE.LR_SUBASSET, fields: [2n ** 64n - 1n, quantity, 1, 0, 0, compact.length, compact] };
  }
  // Standard issuance / every reissuance: [asset_id, quantity, divisible, lock, reset]
  return { typeId: MESSAGE_TYPE.LR_ISSUANCE, fields: [id, quantity, true, false, false] };
}

/** Weight of a one-input script-path reveal with these outputs and leaf. */
export function revealWeightFor(envelopeBytes: number, outputScriptLens: number[], signatureBytes: 64 | 65): number {
  let base = 4 + 1 + 41 + 1 + 4; // version, in-count, input, out-count, locktime
  for (const len of outputScriptLens) base += 8 + compactSizeLen(len) + len;
  const witness = 2 + 1 + (1 + signatureBytes) + compactSizeLen(envelopeBytes) + envelopeBytes + (1 + 33);
  return base * 4 + witness;
}

/** Price a mint from its shape, before compose. Exact for the inputs given. */
export function estimateMint(args: EstimateMintArgs): MintEstimate {
  if (!Number.isInteger(args.bytes) || args.bytes < 0) throw new Error('bytes must be a non-negative integer');
  if (!(args.feeRate > 0) || !Number.isFinite(args.feeRate)) throw new Error('fee rate must be a positive number');
  const { typeId, fields } = messageFields(args);
  const leaf = buildCoreEnvelope({
    typeId,
    fields,
    mimeType: args.mimeType ?? 'text/plain',
    content: new Uint8Array(args.bytes),
    wrapOrd: args.hasOrdWrapper === true,
  });
  const outputs = [CNTRPRTY_OP_RETURN_SCRIPT_LEN, ...(args.hasOrdWrapper ? [P2TR_SCRIPT_LEN] : [])];
  const revealOutputs = args.hasOrdWrapper ? REGULAR_DUST : 0;
  const coreWeight = revealWeightFor(leaf.length, outputs, 64);
  const revealWeight = coreWeight + 1;
  const coreCommitValue = Math.max(feeFor(vbytesOf(coreWeight), args.feeRate) + revealOutputs, SEGWIT_DUST);
  const commitValue = Math.max(coreCommitValue, feeFor(vbytesOf(revealWeight), args.feeRate) + revealOutputs);
  const xcpBurn = args.kind === 'reinscription' || !args.assetName || checkAssetName(args.assetName).ok === false ? 0n : issuanceBurnXcp(args.assetName);
  return {
    revealWeight,
    revealVsize: vbytesOf(revealWeight),
    revealFee: commitValue - revealOutputs,
    commitValue,
    coreCommitValue,
    revealOutputs,
    xcpBurn,
    standardRelay: revealWeight <= STANDARD_WITNESS_LIMIT_WU,
    envelopeBytes: leaf.length,
  };
}
