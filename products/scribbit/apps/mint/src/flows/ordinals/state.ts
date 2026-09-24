/**
 * The ordinals page as a pure state machine. Steps: connect → content → quote → commit → reveal → done.
 * Money may have moved from `commit` on, so the reducer refuses to go back past it; a pending mint
 * (commit broadcast, reveal not) is resumable from storage and rescuable at any time.
 */
import type { Network } from '@bsh/inscription';
import type { FeeSnapshot, RevealQuote, WalletSession } from '../../services/types';
import type { RevealSigningPlan } from '../../lib/walletRouting';
import type { PendingOrdinals } from '../../lib/pending';

export type OrdinalsStep = 'connect' | 'content' | 'quote' | 'commit' | 'reveal' | 'done';
export const ORDINALS_STEPS: readonly OrdinalsStep[] = ['connect', 'content', 'quote', 'commit', 'reveal', 'done'];

export interface ContentItem {
  id: string;
  fileName: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  size: number;
}

export interface OrdinalsOptions {
  parentId: string;
  metadataJson: string;
  postage: bigint;
}

export interface QuoteView {
  quote: RevealQuote;
  feeRate: number;
  /** Estimated funding (commit) transaction fee, once UTXOs are known; null before. */
  fundingFee: number | null;
  fundingVsize: number | null;
  plan: RevealSigningPlan;
  commitAddress: string;
}

export interface CommitView {
  psbtBase64: string;
  txid: string;
  commitVout: number;
  commitValue: bigint;
  inputsToSign: Array<{ index: number; address: string }>;
  fundingFee: number;
  /** Shown to wallets that inspect the envelope before approving a commit (XCP Wallet). */
  inscription?: { envelopeScriptHex: string; commitAddress: string };
  broadcastTxid?: string;
}

export interface RevealView {
  psbtBase64: string;
  /** Envelope + commit address, for wallets that inspect the leaf before signing (XCP Wallet). */
  inscription?: { envelopeScriptHex: string; commitAddress: string };
  txid?: string;
  hex?: string;
  weight?: number;
  broadcastVia?: 'wallet' | 'esplora';
}

export interface DoneItem {
  fileName: string;
  contentType: string;
  sha256: string;
  size: number;
  commitTxid: string;
  revealTxid: string;
  inscriptionId: string;
  confirmed: boolean;
}

export interface OrdinalsState {
  step: OrdinalsStep;
  network: Network;
  wallet: WalletSession | null;
  fees: FeeSnapshot | null;
  items: ContentItem[];
  /** Index into `items` being minted now (batches run sequentially). */
  current: number;
  options: OrdinalsOptions;
  feeRate: number | null;
  quote: QuoteView | null;
  commit: CommitView | null;
  reveal: RevealView | null;
  done: DoneItem[];
  pending: PendingOrdinals | null;
  busy: string | null;
  error: { message: string; hint: string } | null;
}

export function initialOrdinalsState(network: Network, pending: PendingOrdinals | null = null): OrdinalsState {
  return {
    step: 'connect',
    network,
    wallet: null,
    fees: null,
    items: [],
    current: 0,
    options: { parentId: '', metadataJson: '', postage: 546n },
    feeRate: null,
    quote: null,
    commit: null,
    reveal: null,
    done: [],
    pending,
    busy: null,
    error: null,
  };
}

export type OrdinalsAction =
  | { type: 'FEES_LOADED'; fees: FeeSnapshot | null }
  | { type: 'WALLET_CONNECTED'; wallet: WalletSession }
  | { type: 'WALLET_DISCONNECTED' }
  | { type: 'ITEMS_ADDED'; items: ContentItem[] }
  | { type: 'ITEM_REMOVED'; id: string }
  | { type: 'ITEM_TYPE_CHANGED'; id: string; contentType: string }
  | { type: 'OPTIONS_CHANGED'; options: Partial<OrdinalsOptions> }
  | { type: 'FEE_RATE_CHANGED'; feeRate: number | null }
  | { type: 'QUOTED'; quote: QuoteView }
  | { type: 'COMMIT_PREPARED'; commit: CommitView; reveal: RevealView }
  | { type: 'COMMIT_BROADCAST'; txid: string; pending: PendingOrdinals }
  | { type: 'REVEAL_SIGNED'; reveal: RevealView }
  | { type: 'REVEAL_BROADCAST'; txid: string; inscriptionId: string }
  | { type: 'ITEM_CONFIRMED'; inscriptionId: string }
  | { type: 'NEXT_ITEM' }
  | { type: 'RESUME_PENDING'; pending: PendingOrdinals; reveal: RevealView; wallet: WalletSession | null }
  | { type: 'PENDING_CLEARED' }
  | { type: 'GO'; step: OrdinalsStep }
  | { type: 'BUSY'; what: string | null }
  | { type: 'ERROR'; error: { message: string; hint: string } | null }
  | { type: 'RESTART' };

const MONEY_STEPS: ReadonlySet<OrdinalsStep> = new Set(['commit', 'reveal']);

export function canEnter(state: OrdinalsState, step: OrdinalsStep): boolean {
  switch (step) {
    case 'connect':
      return !MONEY_STEPS.has(state.step) || state.commit?.broadcastTxid === undefined;
    case 'content':
      return state.wallet !== null && (!MONEY_STEPS.has(state.step) || state.commit?.broadcastTxid === undefined);
    case 'quote':
      return state.wallet !== null && state.items.length > 0 && state.feeRate !== null && (!MONEY_STEPS.has(state.step) || state.commit?.broadcastTxid === undefined);
    case 'commit':
      return state.quote !== null && state.commit !== null;
    case 'reveal':
      return state.commit?.broadcastTxid !== undefined && state.reveal !== null;
    case 'done':
      return state.done.length > 0;
  }
}

export function ordinalsReducer(state: OrdinalsState, action: OrdinalsAction): OrdinalsState {
  switch (action.type) {
    case 'FEES_LOADED':
      return { ...state, fees: action.fees, feeRate: state.feeRate ?? action.fees?.standard.normal ?? null };
    case 'WALLET_CONNECTED':
      return { ...state, wallet: action.wallet, step: state.step === 'connect' ? 'content' : state.step, error: null };
    case 'WALLET_DISCONNECTED':
      return { ...state, wallet: null, step: 'connect', quote: null, commit: null, reveal: null };
    case 'ITEMS_ADDED':
      return { ...state, items: [...state.items, ...action.items], quote: null, commit: null, error: null };
    case 'ITEM_REMOVED':
      return { ...state, items: state.items.filter((i) => i.id !== action.id), quote: null, commit: null };
    case 'ITEM_TYPE_CHANGED':
      return { ...state, items: state.items.map((i) => (i.id === action.id ? { ...i, contentType: action.contentType } : i)), quote: null, commit: null };
    case 'OPTIONS_CHANGED':
      return { ...state, options: { ...state.options, ...action.options }, quote: null, commit: null };
    case 'FEE_RATE_CHANGED':
      return { ...state, feeRate: action.feeRate, quote: null, commit: null };
    case 'QUOTED':
      return { ...state, quote: action.quote, commit: null, reveal: null, step: 'quote', error: null };
    case 'COMMIT_PREPARED':
      return { ...state, commit: action.commit, reveal: action.reveal, step: 'commit', error: null };
    case 'COMMIT_BROADCAST':
      return { ...state, commit: state.commit ? { ...state.commit, broadcastTxid: action.txid } : state.commit, pending: action.pending, step: 'reveal', error: null };
    case 'REVEAL_SIGNED':
      return { ...state, reveal: action.reveal };
    case 'REVEAL_BROADCAST': {
      const item = state.items[state.current];
      const src = item ?? (state.pending ? { fileName: state.pending.fileName, contentType: state.pending.contentType, sha256: state.pending.sha256, size: 0 } : null);
      if (!src) return state;
      const done: DoneItem = { fileName: src.fileName, contentType: src.contentType, sha256: src.sha256, size: src.size, commitTxid: state.commit?.broadcastTxid ?? state.pending?.commitTxid ?? '', revealTxid: action.txid, inscriptionId: action.inscriptionId, confirmed: false };
      return { ...state, done: [...state.done, done], pending: null, reveal: state.reveal ? { ...state.reveal, txid: action.txid } : state.reveal, step: 'done', error: null };
    }
    case 'ITEM_CONFIRMED':
      return { ...state, done: state.done.map((d) => (d.inscriptionId === action.inscriptionId ? { ...d, confirmed: true } : d)) };
    case 'NEXT_ITEM': {
      const next = state.current + 1;
      if (next >= state.items.length) return state;
      return { ...state, current: next, quote: null, commit: null, reveal: null, step: 'quote' };
    }
    case 'RESUME_PENDING':
      return {
        ...state,
        wallet: action.wallet ?? state.wallet,
        pending: action.pending,
        commit: { psbtBase64: '', txid: action.pending.commitTxid, commitVout: action.pending.commitVout, commitValue: BigInt(action.pending.commitValue), inputsToSign: [], fundingFee: 0, broadcastTxid: action.pending.commitTxid },
        reveal: action.reveal,
        step: 'reveal',
        error: null,
      };
    case 'PENDING_CLEARED':
      return { ...state, pending: null, step: state.step === 'reveal' ? (state.wallet ? 'content' : 'connect') : state.step, commit: null, reveal: null };
    case 'GO':
      return canEnter(state, action.step) ? { ...state, step: action.step, error: null } : state;
    case 'BUSY':
      return { ...state, busy: action.what };
    case 'ERROR':
      return { ...state, error: action.error, busy: null };
    case 'RESTART':
      return { ...initialOrdinalsState(state.network), wallet: state.wallet, fees: state.fees, feeRate: state.feeRate, step: state.wallet ? 'content' : 'connect' };
    default:
      return state;
  }
}
