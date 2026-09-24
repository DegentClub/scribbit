/**
 * The mint as a state machine, and the record that lets it resume.
 *
 * ORDER MATTERS, and not the way it first appears. The commit is broadcast
 * BEFORE the reveal is signed:
 *
 *   idle → composing → signing-commit → broadcasting-commit → signing-reveal
 *        → [awaiting-commit]* → broadcasting-reveal → done | failed
 *
 *   * Slipstream only: MARA prices a reveal from the chain and its own
 *     submissions, never from the public mempool, so the commit must be
 *     MINED before the reveal can be submitted.
 *
 * Why not sign both first? The reveal spends the commit's txid, which is only
 * final once the commit is signed; and a browser wallet asked to sign an input
 * whose parent it cannot find blocks on a lookup, reports "could not
 * independently verify previous transaction", and Chrome idles out the
 * extension's service worker before the prompt is usable (counters.fun,
 * `mint.ts`). The engine keeps that order even when it signs the reveal itself,
 * so a wallet-signed reveal is a drop-in.
 *
 * The cost of the ordering is that an unsigned reveal parks the commit's
 * coins. It is recoverable, because the re-keyed leaf names a key THIS mint
 * holds rather than Core's discarded one: the reveal can be rebuilt and
 * re-signed as many times as it takes. `PendingMint` is everything needed to
 * do that, saved BEFORE the commit goes out.
 */

import { type MintKind } from './estimate.js';
import { type FairminterParams } from './fairminter.js';
import { type RevealRoute } from './slipstream.js';

export type MintStage =
  | 'idle'
  | 'composing'
  | 'signing-commit'
  | 'broadcasting-commit'
  | 'signing-reveal'
  /** Slipstream only: MARA cannot price the reveal until the commit is mined. */
  | 'awaiting-commit'
  | 'broadcasting-reveal'
  | 'done'
  | 'failed';

/** Legal transitions. `failed` is reachable from every working stage; `signing-reveal` also from a resumed `PendingMint`. */
export const MINT_TRANSITIONS: Readonly<Record<MintStage, readonly MintStage[]>> = Object.freeze({
  idle: ['composing'],
  composing: ['signing-commit', 'failed'],
  'signing-commit': ['broadcasting-commit', 'failed'],
  'broadcasting-commit': ['signing-reveal', 'failed'],
  'signing-reveal': ['awaiting-commit', 'broadcasting-reveal', 'failed'],
  'awaiting-commit': ['broadcasting-reveal', 'failed'],
  'broadcasting-reveal': ['done', 'failed'],
  done: [],
  failed: ['signing-reveal'],
});

export function canTransition(from: MintStage, to: MintStage): boolean {
  return MINT_TRANSITIONS[from].includes(to);
}

export type FairminterPreset = 'xcp69' | 'custom';

/** Everything known about a mint once the commit is built — the receipt, and what a `PendingMint` carries. */
export interface MintPlanFacts {
  kind: MintKind;
  /** The name actually composed — the drawn one when the request left it empty. */
  asset: string;
  /** fairminter: what was deployed. */
  preset?: FairminterPreset;
  fairminter?: FairminterParams;
  /** Numeric asset for the LP token, when a pool was wanted. */
  lpAsset?: string;
  route: RevealRoute;
  commitAddress: string;
  commitValue: number;
  commitVout: number;
  commitFee: number;
  revealFee: number;
  totalFee: number;
  commitTxid: string;
  /** Exact before signing: a script-path witness is not part of the txid. */
  revealTxid: string;
  commitHex: string;
  revealHex: string;
  leafBytes: number;
  revealWeight: number;
  /** Core's adjusted vsize for the commit — what `commitFee` was computed over. */
  commitVsize: number;
  /** Value of the reveal's outputs (0 native, 546 ord); the rest of the commit is fee. */
  revealOutputs: number;
  ordWrapper: boolean;
}

/** The state machine's current position plus the facts gathered so far. */
export interface MintPlan extends Partial<MintPlanFacts> {
  stage: MintStage;
  /** Set on `failed`. */
  error?: string;
  /** Set once the commit has been accepted by a relay. */
  commitBroadcast?: string;
  /** Set once the reveal has been accepted (public) or handed off (slipstream). */
  revealBroadcast?: string;
}

/**
 * A mint whose commit is (or is about to be) on chain and whose reveal is
 * not, kept across reloads. One pending mint per address at a time.
 *
 * `revealKey` is the one thing that is not "safe to store", and it is
 * deliberate: it is the only thing that can open the commit — dropping it
 * would strand the coins exactly as Core's discarded key does. It is a fresh
 * key that has never held anything else, it guards one output worth the
 * reveal's fee, and it is cleared the moment the reveal is broadcast.
 */
export interface PendingMint {
  source: string;
  asset: string;
  commitTxid: string;
  /** The unsigned reveal PSBT, base64. Re-signable at any time. */
  revealPsbt: string;
  /** Hex of the 32-byte reveal private key. */
  revealKey: string;
  route: RevealRoute;
  plan: MintPlanFacts;
  savedAt: number;
}
