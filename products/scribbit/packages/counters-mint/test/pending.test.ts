import { describe, expect, it } from 'vitest';
import { PENDING_MINT_KEY, clearPendingMint, loadPendingMint, memoryKV, savePendingMint } from '../src/pending.js';
import { MINT_TRANSITIONS, canTransition, type MintStage, type PendingMint } from '../src/plan.js';

const pending: PendingMint = {
  source: 'bc1p...',
  asset: 'MEMENOME',
  commitTxid: 'a'.repeat(64),
  revealPsbt: 'cHNidP8BAA==',
  revealKey: '11'.repeat(32),
  route: 'public',
  savedAt: 1_700_000_000_000,
  plan: {
    kind: 'counter',
    asset: 'MEMENOME',
    route: 'public',
    commitAddress: 'bc1p...',
    commitValue: 1234,
    commitVout: 0,
    commitFee: 310,
    revealFee: 1234,
    totalFee: 1544,
    commitTxid: 'a'.repeat(64),
    revealTxid: 'b'.repeat(64),
    commitHex: '02',
    revealHex: '',
    leafBytes: 74,
    revealWeight: 605,
    commitVsize: 155,
    revealOutputs: 0,
    ordWrapper: false,
  },
};

describe('pending mint persistence', () => {
  it('round-trips through a KV store and clears', () => {
    const kv = memoryKV();
    expect(loadPendingMint(kv)).toBeNull();
    savePendingMint(kv, pending);
    expect(kv.getItem(PENDING_MINT_KEY)).toContain('"revealKey"');
    expect(loadPendingMint(kv)).toEqual(pending);
    clearPendingMint(kv);
    expect(loadPendingMint(kv)).toBeNull();
  });

  it('ignores garbage and records missing what recovery needs', () => {
    const kv = memoryKV();
    kv.setItem(PENDING_MINT_KEY, '{not json');
    expect(loadPendingMint(kv)).toBeNull();
    kv.setItem(PENDING_MINT_KEY, JSON.stringify({ source: 'x' }));
    expect(loadPendingMint(kv)).toBeNull();
  });

  it('survives a throwing store', () => {
    const broken = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };
    expect(() => savePendingMint(broken, pending)).not.toThrow();
    expect(loadPendingMint(broken)).toBeNull();
    expect(() => clearPendingMint(broken)).not.toThrow();
  });

  it('supports a custom key', () => {
    const kv = memoryKV();
    savePendingMint(kv, pending, 'k');
    expect(loadPendingMint(kv, 'k')).toEqual(pending);
    expect(loadPendingMint(kv)).toBeNull();
  });
});

describe('MintPlan state machine', () => {
  it('walks the documented order: commit broadcast before the reveal is signed', () => {
    const publicPath: MintStage[] = ['idle', 'composing', 'signing-commit', 'broadcasting-commit', 'signing-reveal', 'broadcasting-reveal', 'done'];
    for (let i = 1; i < publicPath.length; i++) expect(canTransition(publicPath[i - 1]!, publicPath[i]!)).toBe(true);
    const slipstreamPath: MintStage[] = ['signing-reveal', 'awaiting-commit', 'broadcasting-reveal', 'done'];
    for (let i = 1; i < slipstreamPath.length; i++) expect(canTransition(slipstreamPath[i - 1]!, slipstreamPath[i]!)).toBe(true);
    expect(canTransition('signing-reveal', 'broadcasting-commit')).toBe(false);
    expect(canTransition('composing', 'signing-reveal')).toBe(false);
    expect(canTransition('done', 'idle')).toBe(false);
    // A resumed PendingMint re-enters at signing-reveal.
    expect(canTransition('failed', 'signing-reveal')).toBe(true);
    for (const stage of Object.keys(MINT_TRANSITIONS) as MintStage[]) {
      if (stage !== 'done' && stage !== 'failed' && stage !== 'idle') expect(canTransition(stage, 'failed')).toBe(true);
    }
  });
});
