import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { base64, hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { commitAddress, revealCommitSighash, REVEAL_SEQUENCE } from '../src/index.js';
import {
  buildAll,
  COMMIT_OUTPOINT,
  content,
  PARENT,
  PARENT_VALUE,
  POSTAGE,
  RECIPIENT,
  NETWORK,
  REVEAL_PUB,
} from './helpers.js';

const OPTS = { allowUnknownInputs: true } as const;
const fromPsbt = (b64: string) => Transaction.fromPSBT(base64.decode(b64), OPTS);
const COMMIT_VALUE = 100_000n;

describe('one 0x83 signature, two layouts (legacy sighash: single_anyonecanpay)', () => {
  const c = content(1234);
  const commit = commitAddress(REVEAL_PUB, c, NETWORK);
  const { half, attached, final, rescue } = buildAll(c, COMMIT_VALUE, 'single_anyonecanpay');
  const sig = half.signature;

  /** BIP341 sighash via btc-signer (independent of src/sighash.ts). */
  const parentLayoutSighash = (tx: Transaction, commitValue = COMMIT_VALUE) =>
    tx.preimageWitnessV1(1, [PARENT.script, commit.script], 0x83, [PARENT_VALUE, commitValue], -1, commit.leafScript, 0xc0);
  const rescueLayoutSighash = (tx: Transaction, commitValue = COMMIT_VALUE) =>
    tx.preimageWitnessV1(0, [commit.script], 0x83, [commitValue], -1, commit.leafScript, 0xc0);

  it('signature is 65 bytes ending in 0x83', () => {
    expect(sig.length).toBe(65);
    expect(sig[64]).toBe(0x83);
    expect(half.sighashType).toBe(0x83);
  });

  it('parent layout (commit@1, child@1) and rescue layout (commit@0, child@0) have the SAME sighash', () => {
    const parentTx = fromPsbt(attached.psbtBase64);
    const rescueTx = fromPsbt(half.psbtBase64);
    expect(parentTx.inputsLength).toBe(2);
    expect(rescueTx.inputsLength).toBe(1);
    expect(hex.encode(parentTx.getInput(1).txid!)).toBe(COMMIT_OUTPOINT.txid);
    expect(parentTx.getOutput(1).script).toEqual(RECIPIENT.script);
    expect(parentTx.version).toBe(rescueTx.version);
    expect(parentTx.lockTime).toBe(rescueTx.lockTime);
    expect(parentTx.getInput(1).sequence).toBe(REVEAL_SEQUENCE);
    expect(rescueTx.getInput(0).sequence).toBe(REVEAL_SEQUENCE);

    const a = parentLayoutSighash(parentTx);
    const b = rescueLayoutSighash(rescueTx);
    expect(hex.encode(a)).toBe(hex.encode(b));
    const ours = revealCommitSighash({
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      commitScript: commit.script,
      childScript: RECIPIENT.script,
      childValue: POSTAGE,
      tapLeafHash: commit.tapLeafHash,
    });
    expect(hex.encode(ours)).toBe(hex.encode(a));
    expect(schnorr.verify(sig.subarray(0, 64), a, REVEAL_PUB)).toBe(true);
    expect(schnorr.verify(sig.subarray(0, 64), b, REVEAL_PUB)).toBe(true);
  });

  it('both final transactions carry that exact signature in witness [sig, script, controlBlock]', () => {
    const p = Transaction.fromRaw(hex.decode(final.hex), OPTS);
    const r = Transaction.fromRaw(hex.decode(rescue.hex), OPTS);
    const pw = p.getInput(1).finalScriptWitness!;
    const rw = r.getInput(0).finalScriptWitness!;
    for (const w of [pw, rw]) {
      expect(w.length).toBe(3);
      expect(w[0]).toEqual(sig);
      expect(w[1]).toEqual(commit.leafScript);
      expect(w[2]).toEqual(commit.controlBlock);
    }
    expect(p.getInput(0).finalScriptWitness!.length).toBe(1);
    expect(p.getInput(0).finalScriptWitness![0]!.length).toBe(64);
    expect(final.txid).not.toBe(rescue.txid);
  });

  it('any parent outpoint works (signature does not commit to other inputs)', () => {
    const tx = new Transaction({ version: 2, allowUnknownInputs: true });
    tx.addOutput({ script: PARENT.script, amount: 999n });
    tx.addOutput({ script: RECIPIENT.script, amount: POSTAGE });
    tx.addInput({ txid: 'dd'.repeat(32), index: 7, sequence: REVEAL_SEQUENCE, witnessUtxo: { script: PARENT.script, amount: 999n } });
    tx.addInput({ txid: COMMIT_OUTPOINT.txid, index: COMMIT_OUTPOINT.vout, sequence: REVEAL_SEQUENCE, witnessUtxo: { script: commit.script, amount: COMMIT_VALUE } });
    const h = tx.preimageWitnessV1(1, [PARENT.script, commit.script], 0x83, [999n, COMMIT_VALUE], -1, commit.leafScript, 0xc0);
    expect(schnorr.verify(sig.subarray(0, 64), h, REVEAL_PUB)).toBe(true);
  });

  function tamperedParentTx(childAmount: bigint, swapOutputs = false) {
    const tx = new Transaction({ version: 2, allowUnknownInputs: true });
    const outs = [
      { script: PARENT.script, amount: PARENT_VALUE },
      { script: RECIPIENT.script, amount: childAmount },
    ];
    if (swapOutputs) outs.reverse();
    outs.forEach((o) => tx.addOutput(o));
    tx.addInput({ txid: 'bb'.repeat(32), index: 0, sequence: REVEAL_SEQUENCE, witnessUtxo: { script: PARENT.script, amount: PARENT_VALUE } });
    tx.addInput({ txid: COMMIT_OUTPOINT.txid, index: COMMIT_OUTPOINT.vout, sequence: REVEAL_SEQUENCE, witnessUtxo: { script: commit.script, amount: COMMIT_VALUE } });
    return tx;
  }

  it('tampering with the child output breaks the signature', () => {
    expect(schnorr.verify(sig.subarray(0, 64), parentLayoutSighash(tamperedParentTx(POSTAGE)), REVEAL_PUB)).toBe(true);
    expect(schnorr.verify(sig.subarray(0, 64), parentLayoutSighash(tamperedParentTx(POSTAGE - 1n)), REVEAL_PUB)).toBe(false);
    expect(schnorr.verify(sig.subarray(0, 64), parentLayoutSighash(tamperedParentTx(POSTAGE, true)), REVEAL_PUB)).toBe(false);
    const other = revealCommitSighash({
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      commitScript: commit.script,
      childScript: PARENT.script, // different recipient
      childValue: POSTAGE,
      tapLeafHash: commit.tapLeafHash,
    });
    expect(schnorr.verify(sig.subarray(0, 64), other, REVEAL_PUB)).toBe(false);
  });

  it('tampering with the commit amount breaks the signature', () => {
    const rescueTx = fromPsbt(half.psbtBase64);
    expect(schnorr.verify(sig.subarray(0, 64), rescueLayoutSighash(rescueTx, COMMIT_VALUE + 1n), REVEAL_PUB)).toBe(false);
    expect(schnorr.verify(sig.subarray(0, 64), parentLayoutSighash(tamperedParentTx(POSTAGE), COMMIT_VALUE - 1n), REVEAL_PUB)).toBe(false);
  });

  it('changing nSequence or nVersion breaks the signature', () => {
    const base = {
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      commitScript: commit.script,
      childScript: RECIPIENT.script,
      childValue: POSTAGE,
      tapLeafHash: commit.tapLeafHash,
    };
    expect(schnorr.verify(sig.subarray(0, 64), revealCommitSighash({ ...base, sequence: 0xffffffff }), REVEAL_PUB)).toBe(false);
    expect(schnorr.verify(sig.subarray(0, 64), revealCommitSighash({ ...base, version: 1 }), REVEAL_PUB)).toBe(false);
  });
});

describe('one 0x81 signature, two layouts (default sighash: all_anyonecanpay)', () => {
  const c = content(1234);
  const commit = commitAddress(REVEAL_PUB, c, NETWORK);
  const { half, attached, final } = buildAll(c, COMMIT_VALUE);
  const sig = half.signature;
  const OUTPUTS = [
    { script: PARENT.script, value: PARENT_VALUE },
    { script: RECIPIENT.script, value: POSTAGE },
  ];

  /** BIP341 sighash via btc-signer (independent of src/sighash.ts). */
  const parentLayoutSighash = (tx: Transaction, commitValue = COMMIT_VALUE) =>
    tx.preimageWitnessV1(1, [PARENT.script, commit.script], 0x81, [PARENT_VALUE, commitValue], -1, commit.leafScript, 0xc0);
  const halfLayoutSighash = (tx: Transaction, commitValue = COMMIT_VALUE) =>
    tx.preimageWitnessV1(0, [commit.script], 0x81, [commitValue], -1, commit.leafScript, 0xc0);
  const verifies = (digest: Uint8Array) => schnorr.verify(sig.subarray(0, 64), digest, REVEAL_PUB);

  it('is the default mode; signature is 65 bytes ending in 0x81', () => {
    expect(sig.length).toBe(65);
    expect(sig[64]).toBe(0x81);
    expect(half.sighashType).toBe(0x81);
  });

  it('half-signed layout is [commit] -> [parent return, child]; attachParent only inserts the parent input', () => {
    const halfTx = fromPsbt(half.psbtBase64);
    const parentTx = fromPsbt(attached.psbtBase64);
    expect(halfTx.inputsLength).toBe(1);
    expect(halfTx.outputsLength).toBe(2);
    expect(parentTx.inputsLength).toBe(2);
    expect(parentTx.outputsLength).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(parentTx.getOutput(i).script).toEqual(halfTx.getOutput(i).script);
      expect(parentTx.getOutput(i).amount).toBe(halfTx.getOutput(i).amount);
    }
    expect(hex.encode(parentTx.getInput(1).txid!)).toBe(COMMIT_OUTPOINT.txid);
    expect(parentTx.getInput(1).tapScriptSig![0]![1]).toEqual(sig);
  });

  it('commit@0 (half-signed) and commit@1 (parent attached) have the SAME sighash', () => {
    const a = parentLayoutSighash(fromPsbt(attached.psbtBase64));
    const b = halfLayoutSighash(fromPsbt(half.psbtBase64));
    expect(hex.encode(a)).toBe(hex.encode(b));
    const ours = revealCommitSighash({
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      commitScript: commit.script,
      tapLeafHash: commit.tapLeafHash,
      outputs: OUTPUTS, // sighashType defaults to 0x81 with `outputs`
    });
    expect(hex.encode(ours)).toBe(hex.encode(a));
    expect(verifies(a)).toBe(true);
    expect(verifies(b)).toBe(true);
    // 0x81 and 0x83 digests over the same layout differ (different hash type, sha_outputs vs sha_single_output).
    const single = revealCommitSighash({
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      commitScript: commit.script,
      tapLeafHash: commit.tapLeafHash,
      childScript: RECIPIENT.script,
      childValue: POSTAGE,
    });
    expect(hex.encode(single)).not.toBe(hex.encode(a));
    expect(verifies(single)).toBe(false);
  });

  it('the final transaction carries that exact signature in witness [sig, script, controlBlock]', () => {
    const p = Transaction.fromRaw(hex.decode(final.hex), OPTS);
    const w = p.getInput(1).finalScriptWitness!;
    expect(w.length).toBe(3);
    expect(w[0]).toEqual(sig);
    expect(w[1]).toEqual(commit.leafScript);
    expect(w[2]).toEqual(commit.controlBlock);
    expect(p.getInput(0).finalScriptWitness!.length).toBe(1);
  });

  function layout(outs: { script: Uint8Array; amount: bigint }[], parent = { txid: 'bb'.repeat(32), index: 0, amount: PARENT_VALUE }) {
    const tx = new Transaction({ version: 2, allowUnknownInputs: true });
    outs.forEach((o) => tx.addOutput(o));
    tx.addInput({ txid: parent.txid, index: parent.index, sequence: REVEAL_SEQUENCE, witnessUtxo: { script: PARENT.script, amount: parent.amount } });
    tx.addInput({ txid: COMMIT_OUTPOINT.txid, index: COMMIT_OUTPOINT.vout, sequence: REVEAL_SEQUENCE, witnessUtxo: { script: commit.script, amount: COMMIT_VALUE } });
    const scripts = [PARENT.script, commit.script];
    const amounts = [parent.amount, COMMIT_VALUE];
    return tx.preimageWitnessV1(1, scripts, 0x81, amounts, -1, commit.leafScript, 0xc0);
  }
  const GOOD = [
    { script: PARENT.script, amount: PARENT_VALUE },
    { script: RECIPIENT.script, amount: POSTAGE },
  ];

  it('any parent outpoint / parent input value works (signature does not commit to other inputs)', () => {
    expect(verifies(layout(GOOD))).toBe(true);
    expect(verifies(layout(GOOD, { txid: 'dd'.repeat(32), index: 7, amount: 999n }))).toBe(true);
  });

  it('adding an extra output breaks the signature (fee skimming closed)', () => {
    expect(verifies(layout([...GOOD, { script: PARENT.script, amount: 1n }]))).toBe(false);
    expect(verifies(layout([{ script: PARENT.script, amount: 1n }, ...GOOD]))).toBe(false);
  });

  it('changing output 0 (parent return) breaks the signature (re-targeting closed)', () => {
    expect(verifies(layout([{ script: PARENT.script, amount: PARENT_VALUE + 1n }, GOOD[1]!]))).toBe(false);
    expect(verifies(layout([{ script: PARENT.script, amount: PARENT_VALUE - 1n }, GOOD[1]!]))).toBe(false);
    expect(verifies(layout([{ script: RECIPIENT.script, amount: PARENT_VALUE }, GOOD[1]!]))).toBe(false);
    expect(verifies(layout([GOOD[1]!, GOOD[0]!]))).toBe(false); // swapped
    expect(verifies(layout([GOOD[1]!]))).toBe(false); // parent return dropped
  });

  it('tampering with the child output, commit amount, nSequence or nVersion breaks the signature', () => {
    expect(verifies(layout([GOOD[0]!, { script: RECIPIENT.script, amount: POSTAGE - 1n }]))).toBe(false);
    expect(verifies(layout([GOOD[0]!, { script: PARENT.script, amount: POSTAGE }]))).toBe(false);
    const base = { commitOutpoint: COMMIT_OUTPOINT, commitValue: COMMIT_VALUE, commitScript: commit.script, tapLeafHash: commit.tapLeafHash, outputs: OUTPUTS };
    expect(verifies(revealCommitSighash(base))).toBe(true);
    expect(verifies(revealCommitSighash({ ...base, commitValue: COMMIT_VALUE + 1n }))).toBe(false);
    expect(verifies(revealCommitSighash({ ...base, sequence: 0xffffffff }))).toBe(false);
    expect(verifies(revealCommitSighash({ ...base, version: 1 }))).toBe(false);
    expect(verifies(revealCommitSighash({ ...base, lockTime: 1 }))).toBe(false);
  });
});
