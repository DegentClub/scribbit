import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import {
  buildHalfSignedReveal,
  commitAddress,
  NUMS_INTERNAL_KEY,
  REVEAL_SEQUENCE,
  verifyHalfSignedReveal,
} from '../src/index.js';
import {
  COMMIT_OUTPOINT,
  content,
  NETWORK,
  PARENT,
  PARENT_VALUE,
  POSTAGE,
  RECIPIENT,
  REVEAL_PRIV,
  REVEAL_PUB,
} from './helpers.js';

const OPTS = { allowUnknownInputs: true } as const;
const COMMIT_VALUE = 50_000n;
const c = content(3000);
const reason = (r: ReturnType<typeof verifyHalfSignedReveal>) => (r.ok ? 'ok' : r.reason);

const buildArgs = {
  network: NETWORK,
  revealPrivkey: REVEAL_PRIV,
  content: c,
  commitOutpoint: COMMIT_OUTPOINT,
  commitValue: COMMIT_VALUE,
  recipientAddress: RECIPIENT.address!,
  postage: POSTAGE,
};
const expectArgs = {
  network: NETWORK,
  revealPubkey: REVEAL_PUB,
  content: c,
  expectedCommitOutpoint: COMMIT_OUTPOINT,
  expectedCommitValue: COMMIT_VALUE,
  expectedRecipientAddress: RECIPIENT.address!,
  expectedPostage: POSTAGE,
};

/** Same construction as buildHalfSignedReveal (0x83 shape), but with an arbitrary sighash type. */
function signedWith(sighash: number, outputs: { script: Uint8Array; amount: bigint }[] = [{ script: RECIPIENT.script, amount: POSTAGE }]): string {
  const commit = commitAddress(REVEAL_PUB, c, NETWORK);
  const tx = new Transaction({ version: 2, ...OPTS });
  outputs.forEach((o) => tx.addOutput(o));
  tx.addInput({
    txid: COMMIT_OUTPOINT.txid,
    index: COMMIT_OUTPOINT.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: commit.script, amount: COMMIT_VALUE },
    tapInternalKey: NUMS_INTERNAL_KEY,
    tapLeafScript: [[{ version: commit.controlBlock[0]!, internalKey: NUMS_INTERNAL_KEY, merklePath: [] }, new Uint8Array([...commit.leafScript, 0xc0])]],
    sighashType: sighash,
  });
  tx.signIdx(REVEAL_PRIV, 0, [sighash]);
  return base64.encode(tx.toPSBT());
}

describe('verifyHalfSignedReveal (0x83, expectedSighash: single_anyonecanpay)', () => {
  const half = buildHalfSignedReveal({ ...buildArgs, sighash: 'single_anyonecanpay' });
  const good = { ...expectArgs, psbtBase64: half.psbtBase64, expectedSighash: 'single_anyonecanpay' as const };

  it('accepts the genuine half-signed reveal', () => {
    expect(verifyHalfSignedReveal(good)).toEqual({ ok: true });
    expect(verifyHalfSignedReveal({ ...good, expectedSighash: 0x83 })).toEqual({ ok: true });
  });

  it('is NOT accepted under the default (0x81) expectation', () => {
    expect(reason(verifyHalfSignedReveal({ ...expectArgs, psbtBase64: half.psbtBase64 }))).toMatch(/0x81/);
  });

  it('rejects wrong content (one byte different)', () => {
    const body = Uint8Array.from(c.body);
    body[100] = body[100]! ^ 1;
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, body } }))).toMatch(/commit scriptPubKey mismatch/);
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, contentType: 'image/png' } }))).toMatch(/mismatch/);
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, parentId: undefined } }))).toMatch(/mismatch/);
  });

  it('rejects wrong reveal key', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, revealPubkey: PARENT.tweakedPubkey }))).not.toBe('ok');
  });

  it('rejects wrong recipient', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedRecipientAddress: PARENT.address! }))).toMatch(/recipient/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedRecipientAddress: 'not-an-address' }))).toMatch(/recipient/);
  });

  it('rejects wrong postage', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedPostage: POSTAGE + 1n }))).toMatch(/postage/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedPostage: 329n }))).toMatch(/dust/);
  });

  it('rejects wrong commit outpoint and value', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitOutpoint: { ...COMMIT_OUTPOINT, vout: 0 } }))).toMatch(/outpoint/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitOutpoint: { txid: 'ab'.repeat(32), vout: 1 } }))).toMatch(/outpoint/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitValue: COMMIT_VALUE + 1n }))).toMatch(/commit value/);
  });

  it('rejects wrong sighash type (0x81, 0x01, DEFAULT)', () => {
    for (const sh of [0x81, 0x01, 0x00]) {
      const psbt = signedWith(sh);
      expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: psbt }))).toMatch(/0x83|65 bytes/);
    }
    // A 0x83 PSBT built the same way is accepted, proving the helper is otherwise faithful.
    expect(verifyHalfSignedReveal({ ...good, psbtBase64: signedWith(0x83) })).toEqual({ ok: true });
  });

  it('rejects a forged signature', () => {
    const tx = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    const [[key, sig]] = tx.getInput(0).tapScriptSig! as [[{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array]];
    const bad = Uint8Array.from(sig);
    bad[10] = bad[10]! ^ 1;
    // rebuild the PSBT with the forged signature in place of the genuine one
    const inp = tx.getInput(0);
    const fresh = new Transaction({ version: 2, ...OPTS });
    fresh.addOutput(tx.getOutput(0) as { script: Uint8Array; amount: bigint });
    fresh.addInput({ ...inp, tapScriptSig: [[key, bad]] });
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: base64.encode(fresh.toPSBT()) }))).toMatch(/does not verify/);
  });

  it('rejects extra inputs/outputs and garbage', () => {
    const tx = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    tx.addOutput({ script: PARENT.script, amount: 1000n }, true);
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: base64.encode(tx.toPSBT()) }))).toMatch(/1 output/);
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: 'bm90IGEgcHNidA==' }))).toMatch(/decode/);
    expect(reason(verifyHalfSignedReveal({ ...good, network: 'mainnet' }))).not.toBe('ok');
  });
});

describe('verifyHalfSignedReveal (0x81 default, with parent return output)', () => {
  const half = buildHalfSignedReveal({ ...buildArgs, parentReturnAddress: PARENT.address!, parentValue: PARENT_VALUE });
  const good = {
    ...expectArgs,
    psbtBase64: half.psbtBase64,
    expectedParentReturnAddress: PARENT.address!,
    expectedParentValue: PARENT_VALUE,
  };

  it('accepts the genuine half-signed reveal (default expectedSighash is all_anyonecanpay)', () => {
    expect(half.sighashType).toBe(0x81);
    expect(verifyHalfSignedReveal(good)).toEqual({ ok: true });
    expect(verifyHalfSignedReveal({ ...good, expectedSighash: 'all_anyonecanpay' })).toEqual({ ok: true });
    expect(verifyHalfSignedReveal({ ...good, expectedSighash: 0x81 })).toEqual({ ok: true });
  });

  it('is NOT accepted under a single_anyonecanpay expectation', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedSighash: 'single_anyonecanpay' }))).toMatch(/1 output/);
  });

  it('rejects a wrong or missing parent return expectation', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedParentReturnAddress: RECIPIENT.address! }))).toMatch(/parent return output address/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedParentReturnAddress: 'nope' }))).toMatch(/parent return address invalid/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedParentValue: PARENT_VALUE + 1n }))).toMatch(/parent return output value/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedParentValue: undefined }))).toMatch(/expectedParentValue/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedParentValue: 0n }))).toMatch(/expectedParentValue/);
    // No parent expected => a 2-output PSBT is rejected outright.
    expect(reason(verifyHalfSignedReveal({ ...expectArgs, psbtBase64: half.psbtBase64 }))).toMatch(/expected 1 output/);
  });

  it('rejects child, commit, content and key mismatches exactly as in 0x83 mode', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedRecipientAddress: PARENT.address! }))).toMatch(/recipient/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedPostage: POSTAGE + 1n }))).toMatch(/postage/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitValue: COMMIT_VALUE + 1n }))).toMatch(/commit value/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitOutpoint: { ...COMMIT_OUTPOINT, vout: 0 } }))).toMatch(/outpoint/);
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, contentType: 'image/png' } }))).toMatch(/mismatch/);
    expect(reason(verifyHalfSignedReveal({ ...good, revealPubkey: PARENT.tweakedPubkey }))).not.toBe('ok');
    expect(reason(verifyHalfSignedReveal({ ...good, network: 'mainnet' }))).not.toBe('ok');
  });

  it('rejects a PSBT signed 0x83 / 0x01 / DEFAULT over the same two outputs', () => {
    const outs = [
      { script: PARENT.script, amount: PARENT_VALUE },
      { script: RECIPIENT.script, amount: POSTAGE },
    ];
    for (const sh of [0x83, 0x01, 0x00]) {
      expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: signedWith(sh, outs) }))).toMatch(/0x81|65 bytes/);
    }
    expect(verifyHalfSignedReveal({ ...good, psbtBase64: signedWith(0x81, outs) })).toEqual({ ok: true });
  });

  it('rejects a PSBT whose signed outputs differ from the expected ones (signature over all outputs)', () => {
    // Genuinely signed with 0x81, but over [parent return + 1 sat, child]: the service's expected
    // parentValue is what the digest is recomputed from, so the signature must fail to verify.
    const psbt = signedWith(0x81, [
      { script: PARENT.script, amount: PARENT_VALUE + 1n },
      { script: RECIPIENT.script, amount: POSTAGE },
    ]);
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: psbt }))).toMatch(/parent return output value/);
    // Same digest check when the PSBT's own output fields are consistent but the signature is not.
    const tx = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    const [[key, sig]] = tx.getInput(0).tapScriptSig! as [[{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array]];
    const bad = Uint8Array.from(sig);
    bad[20] = bad[20]! ^ 1;
    const fresh = new Transaction({ version: 2, ...OPTS });
    fresh.addOutput(tx.getOutput(0) as { script: Uint8Array; amount: bigint });
    fresh.addOutput(tx.getOutput(1) as { script: Uint8Array; amount: bigint });
    fresh.addInput({ ...tx.getInput(0), tapScriptSig: [[key, bad]] });
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: base64.encode(fresh.toPSBT()) }))).toMatch(/does not verify/);
  });

  it('rejects a third output', () => {
    const tx = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    tx.addOutput({ script: PARENT.script, amount: 1000n }, true);
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: base64.encode(tx.toPSBT()) }))).toMatch(/2 output/);
  });
});

describe('verifyHalfSignedReveal (0x81, no parent)', () => {
  const noParent = { ...c, parentId: undefined };
  const half = buildHalfSignedReveal({ ...buildArgs, content: noParent });
  const good = { ...expectArgs, content: noParent, psbtBase64: half.psbtBase64 };

  it('accepts [commit] -> [child] when no parent return is expected', () => {
    expect(Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS).outputsLength).toBe(1);
    expect(verifyHalfSignedReveal(good)).toEqual({ ok: true });
  });

  it('rejects it when a parent return is expected', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedParentReturnAddress: PARENT.address!, expectedParentValue: PARENT_VALUE }))).toMatch(/2 output/);
  });

  it('an envelope WITH a parent id can still be built without a parent input (withParent: false)', () => {
    const h = buildHalfSignedReveal({ ...buildArgs, withParent: false });
    expect(Transaction.fromPSBT(base64.decode(h.psbtBase64), OPTS).outputsLength).toBe(1);
    expect(verifyHalfSignedReveal({ ...expectArgs, psbtBase64: h.psbtBase64 })).toEqual({ ok: true });
  });
});
