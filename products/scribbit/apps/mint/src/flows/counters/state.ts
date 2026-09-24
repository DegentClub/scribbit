/**
 * The counters mint as a pure state machine (modelled on counters.fun /mint and the @bsh/scribbit-counters
 * MintPlan stages): idle → checking → composing → signing-commit → broadcasting-commit → signing-reveal →
 * broadcasting-reveal → done. From `broadcasting-commit` on money may have moved: an error there leaves a
 * pending mint that is resumed by re-signing the reveal, never by starting over.
 */
import type { FairminterParams, MintKind } from '../../services/types';
import type { PendingCounters } from '../../lib/pending';

export type CountersStage = 'idle' | 'checking' | 'composing' | 'signing-commit' | 'broadcasting-commit' | 'signing-reveal' | 'broadcasting-reveal' | 'done';

export const STAGE_ORDER: readonly CountersStage[] = ['idle', 'checking', 'composing', 'signing-commit', 'broadcasting-commit', 'signing-reveal', 'broadcasting-reveal', 'done'];

const TRANSITIONS: Readonly<Record<CountersStage, readonly CountersStage[]>> = {
  idle: ['checking', 'signing-reveal'],
  checking: ['composing', 'idle'],
  composing: ['signing-commit', 'idle'],
  'signing-commit': ['broadcasting-commit', 'idle'],
  'broadcasting-commit': ['signing-reveal', 'idle'],
  'signing-reveal': ['broadcasting-reveal', 'idle'],
  'broadcasting-reveal': ['done', 'idle'],
  done: ['idle'],
};

export function canMove(from: CountersStage, to: CountersStage): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CountersResult {
  kind: MintKind;
  asset: string;
  commitTxid: string;
  revealTxid: string;
  commitValue: number;
  commitFee: number;
  revealFee: number;
  revealWeight: number;
  route: 'public' | 'slipstream';
  preset?: 'xcp69' | 'custom';
  fairminter?: FairminterParams;
}

export interface CountersFlowState {
  stage: CountersStage;
  pending: PendingCounters | null;
  result: CountersResult | null;
  error: { message: string; hint: string } | null;
  /** Stages reached in this run, for the progress list. */
  trail: CountersStage[];
}

export type CountersAction =
  | { type: 'STAGE'; stage: CountersStage }
  | { type: 'PENDING_SAVED'; pending: PendingCounters }
  | { type: 'PENDING_CLEARED' }
  | { type: 'DONE'; result: CountersResult }
  | { type: 'FAILED'; error: { message: string; hint: string } }
  | { type: 'RESET' };

export function initialCountersFlow(pending: PendingCounters | null = null): CountersFlowState {
  return { stage: 'idle', pending, result: null, error: null, trail: [] };
}

export function countersReducer(s: CountersFlowState, a: CountersAction): CountersFlowState {
  switch (a.type) {
    case 'STAGE':
      if (!canMove(s.stage, a.stage)) return s;
      return { ...s, stage: a.stage, error: a.stage === 'checking' || a.stage === 'signing-reveal' ? null : s.error, trail: a.stage === 'idle' ? s.trail : [...s.trail, a.stage] };
    case 'PENDING_SAVED':
      return { ...s, pending: a.pending };
    case 'PENDING_CLEARED':
      return { ...s, pending: null };
    case 'DONE':
      return { ...s, stage: 'done', pending: null, result: a.result, error: null, trail: [...s.trail, 'done'] };
    case 'FAILED':
      // Back to idle so the user can act; a saved pending mint survives and offers "sign the reveal again".
      return { ...s, stage: 'idle', error: a.error };
    case 'RESET':
      return { ...initialCountersFlow(s.pending), result: null };
    default:
      return s;
  }
}
