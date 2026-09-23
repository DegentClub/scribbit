import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import {
  buildResignedRescue,
  commitAddress,
  estimateResignedRescueWeight,
  estimateRevealWeight,
  quoteReveal,
  revealCommitSighash,
  REVEAL_SEQUENCE,
} from '../src/index.js';
import { buildAll, COMMIT_OUTPOINT, content, NETWORK, POSTAGE, RECIPIENT, REVEAL_PRIV, REVEAL_PUB } from './helpers.js';

const OPTS = { allowUnknownInputs: true } as const;
const COMMIT_VALUE = 30_000n;

describe('buildResignedRescue (0x81 self-rescue: re-sign [commit] -> [child] with K_e)', () => {
  const c = content(4321);
  const commit = commitAddress(REVEAL_PUB, c, NETWORK);
  const args = {
    network: NETWORK,
    revealPrivkey: REVEAL_PRIV,
    content: c,
    commitOutpoint: COMMIT_OUTPOINT,
    commitValue: COMMIT_VALUE,
    recipientAddress: RECIPIENT.address!,
    postage: POSTAGE,
  };
  const rescue = buildResignedRescue(args);
  const tx = Transaction.fromRaw(hex.decode(rescue.hex), OPTS);

  it('is a 1-in/1-out script-path spend of the commit with a 64-byte SIGHASH_DEFAULT signature', () => {
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.version).toBe(2);
    expect(tx.lockTime).toBe(0);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(COMMIT_OUTPOINT.txid);
    expect(tx.getInput(0).index).toBe(COMMIT_OUTPOINT.vout);
    expect(tx.getInput(0).sequence).toBe(REVEAL_SEQUENCE);
    expect(tx.getOutput(0)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
    const w = tx.getInput(0).finalScriptWitness!;
    expect(w.length).toBe(3);
    expect(w[0]!.length).toBe(64);
    expect(w[1]).toEqual(commit.leafScript);
    expect(w[2]).toEqual(commit.controlBlock);
    expect(rescue.txid).toBe(tx.id);
    expect(rescue.fee).toBe(COMMIT_VALUE - POSTAGE);
    expect(rescue.overpay).toBeUndefined();
  });

  it('signature verifies (Schnorr, K_e) over the BIP341 SIGHASH_DEFAULT digest, via btc-signer and our own digest', () => {
    const sig = tx.getInput(0).finalScriptWitness![0]!;
    const theirs = tx.preimageWitnessV1(0, [commit.script], 0x00, [COMMIT_VALUE], -1, commit.leafScript, 0xc0);
    const ours = revealCommitSighash({
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      commitScript: commit.script,
      tapLeafHash: commit.tapLeafHash,
      sighashType: 0x00,
      outputs: [{ script: RECIPIENT.script, value: POSTAGE }],
    });
    expect(hex.encode(ours)).toBe(hex.encode(theirs));
    expect(schnorr.verify(sig, theirs, REVEAL_PUB)).toBe(true);
    // Everything is committed: outputs, amount, sequence.
    const tampered = (patch: Parameters<typeof revealCommitSighash>[0]) =>
      schnorr.verify(sig, revealCommitSighash({ ...patch }), REVEAL_PUB);
    const base = { commitOutpoint: COMMIT_OUTPOINT, commitValue: COMMIT_VALUE, commitScript: commit.script, tapLeafHash: commit.tapLeafHash, sighashType: 0x00 };
    expect(tampered({ ...base, outputs: [{ script: RECIPIENT.script, value: POSTAGE + 1n }] })).toBe(false);
    expect(tampered({ ...base, outputs: [{ script: RECIPIENT.script, value: POSTAGE }, { script: RECIPIENT.script, value: 1n }] })).toBe(false);
    expect(tampered({ ...base, commitValue: COMMIT_VALUE - 1n, outputs: [{ script: RECIPIENT.script, value: POSTAGE }] })).toBe(false);
    expect(tampered({ ...base, sequence: 0xffffffff, outputs: [{ script: RECIPIENT.script, value: POSTAGE }] })).toBe(false);
  });

  it('weight is exact: estimateResignedRescueWeight == real tx == rescue-layout estimate - 1 WU', () => {
    const est = estimateResignedRescueWeight({ content: c, recipientScript: RECIPIENT.script });
    expect(rescue.weight).toBe(est);
    expect(tx.weight).toBe(est);
    expect(est).toBe(estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script }) - 1);
    expect(rescue.vsize).toBe(Math.ceil(est / 4));
  });

  it('spends the same commit as the service reveal, so either confirms but not both', () => {
    const { final } = buildAll(c, COMMIT_VALUE);
    const serviceTx = Transaction.fromRaw(hex.decode(final.hex), OPTS);
    expect(hex.encode(serviceTx.getInput(1).txid!)).toBe(hex.encode(tx.getInput(0).txid!));
    expect(serviceTx.getInput(1).index).toBe(tx.getInput(0).index);
    expect(final.txid).not.toBe(rescue.txid);
  });

  it('is independent of the half-signed PSBT: works with a fresh K_e-only recovery bundle', () => {
    // Nothing from buildHalfSignedReveal is an input; the same args reproduce the same transaction
    // (txid excludes the witness, and Schnorr signing uses random aux data, so only the signature bytes differ).
    const again = buildResignedRescue(args);
    expect(again.txid).toBe(rescue.txid);
    expect(again.weight).toBe(rescue.weight);
    expect(again.fee).toBe(rescue.fee);
    const w = Transaction.fromRaw(hex.decode(again.hex), OPTS).getInput(0).finalScriptWitness!;
    expect(w[1]).toEqual(commit.leafScript);
    expect(w[2]).toEqual(commit.controlBlock);
  });

  it('feeRate: refuses an underfunded commit, otherwise reports the overpay', () => {
    const est = estimateResignedRescueWeight({ content: c, recipientScript: RECIPIENT.script });
    const q = quoteReveal({ revealWeight: est, feeRate: 5, postage: POSTAGE });
    const exact = buildResignedRescue({ ...args, commitValue: q.commitValue, feeRate: 5 });
    expect(exact.overpay).toBe(0n);
    expect(exact.fee).toBe(q.revealFee);
    const rich = buildResignedRescue({ ...args, commitValue: q.commitValue + 100n, feeRate: 5 });
    expect(rich.overpay).toBe(100n);
    expect(() => buildResignedRescue({ ...args, commitValue: q.commitValue - 1n, feeRate: 5 })).toThrow(/needed at 5/);
    expect(() => buildResignedRescue({ ...args, commitValue: q.commitValue - 1n })).not.toThrow(); // no rate => no check
  });

  it('validates its inputs', () => {
    expect(() => buildResignedRescue({ ...args, postage: 329n })).toThrow(/postage/);
    expect(() => buildResignedRescue({ ...args, commitValue: POSTAGE })).toThrow(/commitValue/);
    expect(() => buildResignedRescue({ ...args, revealPrivkey: new Uint8Array(31) })).toThrow(/revealPrivkey/);
    expect(() => buildResignedRescue({ ...args, commitOutpoint: { txid: 'zz', vout: 0 } })).toThrow(/txid/);
    expect(() => buildResignedRescue({ ...args, recipientAddress: RECIPIENT.address!.replace('bcrt', 'tb') })).toThrow();
  });
});
