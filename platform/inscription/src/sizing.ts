import { compactSizeLen } from './bytes.js';
import { LIMITS } from './constants.js';
import { inscriptionScriptLength, type InscriptionContent } from './envelope.js';

export type Lane = 'standard' | 'block';

const P2TR_SCRIPT_LEN = 34;
/** outpoint (36) + scriptSig length (1, empty) + nSequence (4) */
const INPUT_BASE = 41;
const COMMIT_SIG = 65; // 64-byte Schnorr + hash-type byte (0x81 or 0x83: same size)
const PARENT_SIG = 64; // SIGHASH_DEFAULT key-path
const CONTROL_BLOCK = 33; // single leaf, no merkle path

const outputSize = (scriptLen: number) => 8 + compactSizeLen(scriptLen) + scriptLen;

function isP2TR(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}

/**
 * EXACT weight (WU) of the fully signed reveal.
 *   withParent=false (rescue):  [commit] -> [child]
 *   withParent=true  (parent):  [parent, commit] -> [parent return, child]
 * weight = 4 × non-witness bytes + witness bytes (marker+flag and witness stacks).
 */
export function estimateRevealWeight(args: {
  content: InscriptionContent;
  withParent: boolean;
  recipientScript: Uint8Array;
  parentReturnScript?: Uint8Array;
  parentInputScript?: Uint8Array;
}): number {
  const { content, withParent, recipientScript } = args;
  if (!(recipientScript instanceof Uint8Array) || recipientScript.length === 0)
    throw new Error('recipientScript is required');
  if (withParent && args.parentInputScript !== undefined && !isP2TR(args.parentInputScript))
    throw new Error('parentInputScript must be P2TR (key-path spend is assumed)');
  const leafLen = inscriptionScriptLength(content);
  const nIn = withParent ? 2 : 1;
  const nOut = withParent ? 2 : 1;

  let base = 4 /* nVersion */ + compactSizeLen(nIn) + nIn * INPUT_BASE + compactSizeLen(nOut) + 4 /* nLockTime */;
  base += outputSize(recipientScript.length);
  if (withParent) base += outputSize(args.parentReturnScript?.length ?? P2TR_SCRIPT_LEN);

  let witness = 2; // segwit marker + flag
  witness += compactSizeLen(3);
  witness += compactSizeLen(COMMIT_SIG) + COMMIT_SIG;
  witness += compactSizeLen(leafLen) + leafLen;
  witness += compactSizeLen(CONTROL_BLOCK) + CONTROL_BLOCK;
  if (withParent) witness += compactSizeLen(1) + compactSizeLen(PARENT_SIG) + PARENT_SIG;

  return base * 4 + witness;
}

/**
 * EXACT weight of the re-signed rescue `[commit] -> [child]` (buildResignedRescue). Same
 * serialization as the rescue layout above except the SIGHASH_DEFAULT signature has no trailing
 * hash-type byte: exactly 1 WU lighter.
 */
export function estimateResignedRescueWeight(args: { content: InscriptionContent; recipientScript: Uint8Array }): number {
  return estimateRevealWeight({ content: args.content, withParent: false, recipientScript: args.recipientScript }) - (COMMIT_SIG - PARENT_SIG);
}

export function vsizeFromWeight(weight: number): number {
  if (!Number.isSafeInteger(weight) || weight < 0) throw new Error(`invalid weight: ${weight}`);
  return Math.ceil(weight / 4);
}

export function laneFor(revealWeight: number): Lane | null {
  if (!Number.isFinite(revealWeight) || revealWeight < 0) throw new Error(`invalid weight: ${revealWeight}`);
  if (revealWeight <= LIMITS.MAX_STANDARD_TX_WEIGHT) return 'standard';
  if (revealWeight <= LIMITS.BLOCK_LANE_MAX_TX_WEIGHT) return 'block';
  return null;
}

/** Parse a finite non-negative JS number to an exact decimal fraction num/den (den = 10^k). */
function toDecimal(x: number): { num: bigint; den: bigint } {
  if (!Number.isFinite(x) || x < 0) throw new Error(`invalid fee rate: ${x}`);
  // Shortest round-trip representation, e.g. 1.1 -> "1.1", 1e-7 -> "1e-7".
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x));
  if (!m) throw new Error(`cannot parse fee rate: ${x}`);
  const intPart = m[1]!;
  const frac = m[2] ?? '';
  const exp = Number(m[3] ?? 0);
  let num = BigInt(intPart + frac);
  let scale = frac.length - exp; // value = num / 10^scale
  if (scale < 0) {
    num *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { num, den: 10n ** BigInt(scale) };
}

/**
 * revealFee = ceil(vsize × feeRate) computed exactly in decimal (1000 vB × 1.1 sat/vB = 1100,
 * never 1101 from binary float error). commitValue = revealFee + postage.
 */
export function quoteReveal(args: { revealWeight: number; feeRate: number; postage: bigint }): {
  revealVsize: number;
  revealFee: bigint;
  commitValue: bigint;
} {
  const revealVsize = vsizeFromWeight(args.revealWeight);
  if (typeof args.postage !== 'bigint' || args.postage < 0n) throw new Error('postage must be a non-negative bigint');
  const { num, den } = toDecimal(args.feeRate);
  const product = BigInt(revealVsize) * num;
  const revealFee = (product + den - 1n) / den;
  return { revealVsize, revealFee, commitValue: revealFee + args.postage };
}
