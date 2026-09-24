import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { base64, hex } from '@scure/base';
import { Transaction, TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer';
import { taprootTweakPrivKey, taprootTweakPubkey } from '@scure/btc-signer/utils.js';
import {
  attachParent,
  buildHalfSignedReveal,
  buildUnsignedRescuePsbt,
  buildUnsignedRevealPsbt,
  commitAddress,
  estimateResignedRescueWeight,
  estimateRevealWeight,
  extractLeafSignature,
  finalizeReveal,
  finalizeWalletSignedReveal,
  leafKeyOf,
  leafKeyOfPsbt,
  quoteReveal,
  revealCommitSighash,
  REVEAL_SEQUENCE,
  signParentInput,
  verifyWalletSignedReveal,
  type LeafKeyKind,
  type WalletRevealSighash,
} from '../src/index.js';
import { COMMIT_OUTPOINT, content, NETWORK, PARENT, PARENT_OUTPOINT, PARENT_PRIV, PARENT_VALUE, POSTAGE, RECIPIENT } from './helpers.js';

const OPTS = { allowUnknownInputs: true } as const;

/**
 * A local key standing in for the user's wallet. `internal` is the untweaked x-only key wallets
 * report as `publicKey` for a p2tr account; `output` is the tweaked key that is the bc1p witness
 * program. A wallet signing with `disableTweakSigner` uses `priv`; a wallet signing "normally"
 * (BIP86 key-path style, XCP Wallet) uses `tweakedPriv`.
 */
const WALLET_PRIV = hex.decode('0404040404040404040404040404040404040404040404040404040404040404');
const WALLET = {
  priv: WALLET_PRIV,
  internal: schnorr.getPublicKey(WALLET_PRIV),
  tweakedPriv: taprootTweakPrivKey(WALLET_PRIV),
  output: taprootTweakPubkey(schnorr.getPublicKey(WALLET_PRIV), new Uint8Array())[0],
};
const KINDS: LeafKeyKind[] = ['internal', 'output'];
const leafKeyFor = (kind: LeafKeyKind) => (kind === 'internal' ? WALLET.internal : WALLET.output);
const signerFor = (kind: LeafKeyKind) => (kind === 'internal' ? WALLET.priv : WALLET.tweakedPriv);

const OTHER_PRIV = hex.decode('0505050505050505050505050505050505050505050505050505050505050505');

/** "The wallet": sign input 0 of a PSBT with the given key, optionally finalizing like UniSat `autoFinalized`. */
function walletSign(psbtBase64: string, priv: Uint8Array, sighashType: number, finalize = false): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtBase64), OPTS);
  tx.signIdx(priv, 0, [sighashType]);
  if (finalize) tx.finalize();
  return base64.encode(tx.toPSBT());
}

const COMMIT_VALUE = 40_000n;

const NO_PARENT = () => content(777, { parentId: undefined });

function args(kind: LeafKeyKind, c = NO_PARENT(), extra: Partial<Parameters<typeof buildUnsignedRevealPsbt>[0]> = {}) {
  return {
    network: NETWORK,
    leafPubkey: leafKeyFor(kind),
    content: c,
    commitOutpoint: COMMIT_OUTPOINT,
    commitValue: COMMIT_VALUE,
    recipientAddress: RECIPIENT.address!,
    postage: POSTAGE,
    ...extra,
  };
}

/** Rescue args: no parent fields, no reveal-only sighash. */
function rescueArgs(kind: LeafKeyKind, c = NO_PARENT(), extra: Partial<Parameters<typeof buildUnsignedRescuePsbt>[0]> = {}) {
  const { withParent: _w, parentReturnAddress: _p, parentValue: _v, sighash: _s, ...base } = args(kind, c);
  return { ...base, ...extra };
}

const withParentArgs = (kind: LeafKeyKind, c = content(777)) =>
  args(kind, c, { withParent: true, parentReturnAddress: PARENT.address!, parentValue: PARENT_VALUE });

function expected(kind: LeafKeyKind, c = NO_PARENT()) {
  return {
    network: NETWORK,
    leafPubkey: leafKeyFor(kind),
    content: c,
    expectedCommitOutpoint: COMMIT_OUTPOINT,
    expectedCommitValue: COMMIT_VALUE,
    expectedRecipientAddress: RECIPIENT.address!,
    expectedPostage: POSTAGE,
  };
}

describe('wallet key kinds', () => {
  it('the output key is the tweak of the internal key, and the tweaked private key signs for it', () => {
    expect(WALLET.output).not.toEqual(WALLET.internal);
    expect(schnorr.getPublicKey(WALLET.tweakedPriv)).toEqual(WALLET.output);
    expect(schnorr.getPublicKey(WALLET.priv)).toEqual(WALLET.internal);
  });
});

describe('buildUnsignedRevealPsbt', () => {
  for (const kind of KINDS) {
    it(`[${kind}] commit == commitAddress(leafPubkey): NUMS internal key, leaf names the wallet key, PSBT carries the leaf fields`, () => {
      const c = NO_PARENT();
      const built = buildUnsignedRevealPsbt(args(kind, c));
      const commit = commitAddress(leafKeyFor(kind), c, NETWORK);
      expect(built.commitAddress).toBe(commit.address);
      expect(built.inputIndex).toBe(0);
      expect(built.leafScript).toEqual(commit.leafScript);
      expect(built.controlBlock).toEqual(commit.controlBlock);
      expect(built.tapLeafHash).toEqual(commit.tapLeafHash);
      expect(built.controlBlock.subarray(1)).toEqual(Uint8Array.from(TAPROOT_UNSPENDABLE_KEY));
      expect(leafKeyOf(built.leafScript)).toEqual(leafKeyFor(kind));
      expect(leafKeyOfPsbt(built.psbtBase64)).toEqual(leafKeyFor(kind));

      const tx = Transaction.fromPSBT(base64.decode(built.psbtBase64), OPTS);
      expect(tx.inputsLength).toBe(1);
      expect(tx.outputsLength).toBe(1);
      const input = tx.getInput(0);
      expect(input.witnessUtxo).toEqual({ script: commit.script, amount: COMMIT_VALUE });
      expect(input.tapInternalKey).toEqual(Uint8Array.from(TAPROOT_UNSPENDABLE_KEY));
      expect(input.tapMerkleRoot).toEqual(commit.tapLeafHash);
      expect(input.tapLeafScript!.length).toBe(1);
      expect(input.tapLeafScript![0]![1]).toEqual(new Uint8Array([...commit.leafScript, 0xc0]));
      expect(input.tapLeafScript![0]![0]).toEqual({ version: commit.controlBlock[0], internalKey: commit.controlBlock.subarray(1), merklePath: [] });
      expect(input.sequence).toBe(REVEAL_SEQUENCE);
      expect(input.sighashType).toBeUndefined(); // SIGHASH_DEFAULT: field omitted
      expect(input.tapScriptSig ?? []).toEqual([]);
      expect(tx.getOutput(0)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
    });
  }

  it('sighash defaults: default without parent, all_anyonecanpay with parent; a parent refuses anything else', () => {
    expect(buildUnsignedRevealPsbt(args('output')).sighashType).toBe(0x00);
    expect(buildUnsignedRevealPsbt(args('output', content(1, { parentId: undefined }), { sighash: 'all' })).sighashType).toBe(0x01);
    const p = buildUnsignedRevealPsbt(withParentArgs('output'));
    expect(p.sighashType).toBe(0x81);
    const tx = Transaction.fromPSBT(base64.decode(p.psbtBase64), OPTS);
    expect(tx.getInput(0).sighashType).toBe(0x81);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(0)).toMatchObject({ script: PARENT.script, amount: PARENT_VALUE });
    expect(tx.getOutput(1)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
    expect(() => buildUnsignedRevealPsbt({ ...withParentArgs('output'), sighash: 'default' })).toThrow(/cannot take a parent/);
    expect(() => buildUnsignedRevealPsbt({ ...withParentArgs('output'), sighash: 'all' })).toThrow(/cannot take a parent/);
    // withParent defaults to content.parentId !== undefined
    expect(() => buildUnsignedRevealPsbt(args('output', content(1)))).toThrow(/parentReturnAddress/);
    expect(buildUnsignedRevealPsbt(args('output', content(1, { parentId: undefined }))).sighashType).toBe(0x00);
  });

  it('validates its inputs', () => {
    expect(() => buildUnsignedRevealPsbt({ ...args('output'), leafPubkey: new Uint8Array(33) })).toThrow(/leafPubkey/);
    expect(() => buildUnsignedRevealPsbt({ ...args('output'), postage: 329n })).toThrow(/postage/);
    expect(() => buildUnsignedRevealPsbt({ ...args('output'), commitValue: POSTAGE })).toThrow(/commitValue/);
    expect(() => buildUnsignedRevealPsbt({ ...args('output'), commitOutpoint: { txid: 'zz', vout: 0 } })).toThrow(/txid/);
    expect(() => buildUnsignedRevealPsbt({ ...withParentArgs('output'), parentValue: 0n })).toThrow(/parentValue/);
    expect(() => buildUnsignedRevealPsbt({ ...args('output'), recipientAddress: RECIPIENT.address!.replace('bcrt', 'tb') })).toThrow();
  });
});

describe('wallet-signed reveal without a parent: sign, finalize, exact weight, sighash equality', () => {
  const SIGHASHES: Array<[WalletRevealSighash, number, number]> = [
    ['default', 0x00, 64],
    ['all', 0x01, 65],
    ['all_anyonecanpay', 0x81, 65],
  ];
  for (const kind of KINDS) {
    for (const [mode, type, sigLen] of SIGHASHES) {
      for (const finalized of [false, true]) {
        it(`[${kind}] ${mode} (0x${type.toString(16)}), wallet ${finalized ? 'finalizes' : 'leaves tapScriptSig'}`, () => {
          const c = content(1234, { parentId: undefined });
          const built = buildUnsignedRevealPsbt(args(kind, c, { sighash: mode }));
          const signed = walletSign(built.psbtBase64, signerFor(kind), type, finalized);

          // The signature is for the leaf key, with the requested hash type.
          const stx = Transaction.fromPSBT(base64.decode(signed), OPTS);
          const ls = extractLeafSignature(stx, 0);
          expect(ls.source).toBe(finalized ? 'finalScriptWitness' : 'tapScriptSig');
          expect(ls.pubKey).toEqual(leafKeyFor(kind));
          expect(ls.sighashType).toBe(type);
          expect(ls.sig.length).toBe(sigLen);

          // Verify accepts; sighash equality between btc-signer and our independent digest.
          expect(verifyWalletSignedReveal({ ...expected(kind, c), psbtBase64: signed })).toEqual({ ok: true });
          expect(verifyWalletSignedReveal({ ...expected(kind, c), psbtBase64: signed, expectedSighash: mode })).toEqual({ ok: true });
          const commit = commitAddress(leafKeyFor(kind), c, NETWORK);
          const ours = revealCommitSighash({
            commitOutpoint: COMMIT_OUTPOINT,
            commitValue: COMMIT_VALUE,
            commitScript: commit.script,
            tapLeafHash: commit.tapLeafHash,
            sighashType: type,
            outputs: [{ script: RECIPIENT.script, value: POSTAGE }],
          });
          const theirs = stx.preimageWitnessV1(0, [commit.script], type, [COMMIT_VALUE], undefined, commit.leafScript, 0xc0);
          expect(hex.encode(ours)).toBe(hex.encode(theirs));
          expect(schnorr.verify(ls.sig.subarray(0, 64), ours, leafKeyFor(kind))).toBe(true);

          // Finalize: witness [sig, leaf, control block]; weight is exactly the estimate.
          const fin = finalizeWalletSignedReveal(signed);
          const tx = Transaction.fromRaw(hex.decode(fin.hex), OPTS);
          const w = tx.getInput(0).finalScriptWitness!;
          expect(w.length).toBe(3);
          expect(w[0]!.length).toBe(sigLen);
          expect(w[1]).toEqual(commit.leafScript);
          expect(w[2]).toEqual(commit.controlBlock);
          expect(tx.getOutput(0)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
          const est = estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script, commitSighash: mode });
          expect(fin.weight).toBe(est);
          expect(tx.weight).toBe(est);
          expect(fin.vsize).toBe(Math.ceil(est / 4));
          expect(fin.txid).toBe(tx.id);
          if (mode === 'default') expect(est).toBe(estimateResignedRescueWeight({ content: c, recipientScript: RECIPIENT.script }));
          else expect(est).toBe(estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script }));
        });
      }
    }
  }

  it('txid is known before signing (script-path witness is not in the txid)', () => {
    const c = content(50, { parentId: undefined });
    const built = buildUnsignedRevealPsbt(args('output', c));
    const unsigned = Transaction.fromPSBT(base64.decode(built.psbtBase64), OPTS).id;
    const fin = finalizeWalletSignedReveal(walletSign(built.psbtBase64, WALLET.tweakedPriv, 0x00));
    expect(fin.txid).toBe(unsigned);
  });
});

describe('wallet-signed reveal with a parent (0x81): service attaches the parent, exact weight', () => {
  for (const kind of KINDS) {
    for (const finalized of [false, true]) {
      it(`[${kind}] wallet ${finalized ? 'finalizes' : 'leaves tapScriptSig'} -> verify -> attachParent -> signParentInput -> finalizeReveal`, () => {
        const c = content(999);
        const built = buildUnsignedRevealPsbt(withParentArgs(kind, c));
        const signed = walletSign(built.psbtBase64, signerFor(kind), 0x81, finalized);
        expect(
          verifyWalletSignedReveal({
            ...expected(kind, c),
            psbtBase64: signed,
            expectedParentReturnAddress: PARENT.address!,
            expectedParentValue: PARENT_VALUE,
          }),
        ).toEqual({ ok: true });
        // Without the parent expectation the 2-output layout is refused.
        expect(verifyWalletSignedReveal({ ...expected(kind, c), psbtBase64: signed })).toMatchObject({ ok: false, reason: /expected 1 output/ });

        const attached = attachParent({
          network: NETWORK,
          halfSignedPsbtBase64: signed,
          parentOutpoint: PARENT_OUTPOINT,
          parentValue: PARENT_VALUE,
          parentScript: PARENT.script,
          parentReturnAddress: PARENT.address!,
        });
        const parentSigned = signParentInput(attached.psbtBase64, PARENT_PRIV);
        const fin = finalizeReveal(parentSigned.psbtBase64);
        const viaWallet = finalizeWalletSignedReveal(parentSigned.psbtBase64);
        expect(viaWallet.hex).toBe(fin.hex);

        const tx = Transaction.fromRaw(hex.decode(fin.hex), OPTS);
        expect(tx.inputsLength).toBe(2);
        expect(tx.outputsLength).toBe(2);
        const commit = commitAddress(leafKeyFor(kind), c, NETWORK);
        const w = tx.getInput(1).finalScriptWitness!;
        expect(w[0]!.length).toBe(65);
        expect(w[0]![64]).toBe(0x81);
        expect(w[1]).toEqual(commit.leafScript);
        expect(w[2]).toEqual(commit.controlBlock);
        // The 0x81 signature still verifies with the commit at index 1 (ANYONECANPAY: no input index).
        const digest = tx.preimageWitnessV1(1, [PARENT.script, commit.script], 0x81, [PARENT_VALUE, COMMIT_VALUE], undefined, commit.leafScript, 0xc0);
        expect(schnorr.verify(w[0]!.subarray(0, 64), digest, leafKeyFor(kind))).toBe(true);

        const est = estimateRevealWeight({
          content: c,
          withParent: true,
          recipientScript: RECIPIENT.script,
          parentReturnScript: PARENT.script,
          parentInputScript: PARENT.script,
          commitSighash: 'all_anyonecanpay',
        });
        expect(fin.weight).toBe(est);
        expect(tx.weight).toBe(est);
        // Same weight as the K_e half-signed model (65-byte commit signature either way).
        expect(est).toBe(estimateRevealWeight({ content: c, withParent: true, recipientScript: RECIPIENT.script, parentReturnScript: PARENT.script }));
      });
    }
  }

  it('the wallet-signed 0x81 reveal is byte-compatible with the K_e half-signed layout', () => {
    // Same content, same commit params: only the leaf key differs, so the PSBT structure is identical.
    const c = content(321);
    const built = buildUnsignedRevealPsbt(withParentArgs('internal', c));
    const half = buildHalfSignedReveal({
      network: NETWORK,
      revealPrivkey: WALLET.priv,
      content: c,
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: COMMIT_VALUE,
      recipientAddress: RECIPIENT.address!,
      postage: POSTAGE,
      parentReturnAddress: PARENT.address!,
      parentValue: PARENT_VALUE,
    });
    const a = Transaction.fromPSBT(base64.decode(walletSign(built.psbtBase64, WALLET.priv, 0x81)), OPTS);
    const b = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    expect(a.id).toBe(b.id);
    expect(a.getInput(0).witnessUtxo).toEqual(b.getInput(0).witnessUtxo);
    expect(a.getInput(0).tapLeafScript).toEqual(b.getInput(0).tapLeafScript);
  });
});

describe('verifyWalletSignedReveal / finalizeWalletSignedReveal refuse', () => {
  const c = content(2000, { parentId: undefined });
  const built = buildUnsignedRevealPsbt(args('output', c));
  const good = walletSign(built.psbtBase64, WALLET.tweakedPriv, 0x00);
  const exp = expected('output', c);
  const reason = (r: ReturnType<typeof verifyWalletSignedReveal>) => (r.ok ? 'ok' : r.reason);

  it('unsigned PSBT', () => {
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: built.psbtBase64 }))).toMatch(/unsigned/);
    expect(() => finalizeWalletSignedReveal(built.psbtBase64)).toThrow(/unsigned/);
  });

  it('the wallet signed with its other key (internal instead of output)', () => {
    // btc-signer refuses to sign a leaf that does not name the key; a real wallet that ignores the
    // leaf would attach a signature under its own pubkey. Simulate that.
    const tx = Transaction.fromPSBT(base64.decode(built.psbtBase64), OPTS);
    const commit = commitAddress(WALLET.output, c, NETWORK);
    const digest = tx.preimageWitnessV1(0, [commit.script], 0x00, [COMMIT_VALUE], undefined, commit.leafScript, 0xc0);
    const sig = schnorr.sign(digest, WALLET.priv);
    tx.updateInput(0, { tapScriptSig: [[{ pubKey: WALLET.internal, leafHash: commit.tapLeafHash }, sig]] });
    const wrongKey = base64.encode(tx.toPSBT());
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: wrongKey }))).toMatch(/signature is by key .* expected the leaf key .*internal vs tweaked/);
    expect(() => finalizeWalletSignedReveal(wrongKey)).toThrow(/signature is by key/);
    // And the mirror: the leaf names the internal key but the wallet signed with the tweaked key.
    const builtInternal = buildUnsignedRevealPsbt(args('internal', c));
    expect(() => walletSign(builtInternal.psbtBase64, WALLET.tweakedPriv, 0x00)).toThrow(/No taproot scripts signed/);
  });

  it('the wallet forged the pubkey label: signature by another key under the leaf key name', () => {
    const tx = Transaction.fromPSBT(base64.decode(built.psbtBase64), OPTS);
    const commit = commitAddress(WALLET.output, c, NETWORK);
    const digest = tx.preimageWitnessV1(0, [commit.script], 0x00, [COMMIT_VALUE], undefined, commit.leafScript, 0xc0);
    tx.updateInput(0, { tapScriptSig: [[{ pubKey: WALLET.output, leafHash: commit.tapLeafHash }, schnorr.sign(digest, OTHER_PRIV)]] });
    const forged = base64.encode(tx.toPSBT());
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: forged }))).toMatch(/schnorr signature does not verify/);
    expect(() => finalizeWalletSignedReveal(forged)).toThrow(/does not verify for leaf key/);
  });

  it('signature for a different leaf', () => {
    const signedTx = Transaction.fromPSBT(base64.decode(good), OPTS);
    const otherLeaf = commitAddress(WALLET.output, content(3, { parentId: undefined }), NETWORK).tapLeafHash;
    const [[{ pubKey }, sig]] = signedTx.getInput(0).tapScriptSig! as [[{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array]];
    const tx = new Transaction(OPTS);
    tx.addOutput({ script: RECIPIENT.script, amount: POSTAGE });
    tx.addInput({ ...signedTx.getInput(0), tapScriptSig: [[{ pubKey, leafHash: otherLeaf }, sig]] });
    const psbt = base64.encode(tx.toPSBT());
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: psbt }))).toMatch(/different leaf/);
    expect(() => finalizeWalletSignedReveal(psbt)).toThrow(/different leaf/);
  });

  it('finalized witness for a different leaf / wrong control block', () => {
    const tx = Transaction.fromPSBT(base64.decode(walletSign(built.psbtBase64, WALLET.tweakedPriv, 0x00, true)), OPTS);
    const w = tx.getInput(0).finalScriptWitness!;
    const other = commitAddress(WALLET.output, content(3, { parentId: undefined }), NETWORK);
    tx.updateInput(0, { finalScriptWitness: [w[0]!, other.leafScript, w[2]!] }, true);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: base64.encode(tx.toPSBT()) }))).toMatch(/different leaf/);
    // Finalize (no expectation) checks the signature against the leaf actually in the witness.
    expect(() => finalizeWalletSignedReveal(base64.encode(tx.toPSBT()))).toThrow(/does not verify/);
    const badCb = Uint8Array.from(w[2]!);
    badCb[5] = badCb[5]! ^ 1;
    tx.updateInput(0, { finalScriptWitness: [w[0]!, w[1]!, badCb] }, true);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: base64.encode(tx.toPSBT()) }))).toMatch(/internal key is not NUMS/);
    tx.updateInput(0, { finalScriptWitness: [w[0]!, w[1]!] }, true);
    expect(() => finalizeWalletSignedReveal(base64.encode(tx.toPSBT()))).toThrow(/2 items/);
  });

  it('wrong expectations: key kind, content, outpoint, value, recipient, postage', () => {
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, leafPubkey: WALLET.internal }))).toMatch(/commit scriptPubKey mismatch/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, content: content(2001, { parentId: undefined }) }))).toMatch(/scriptPubKey mismatch/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, expectedCommitOutpoint: { ...COMMIT_OUTPOINT, vout: 2 } }))).toMatch(/outpoint/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, expectedCommitValue: COMMIT_VALUE + 1n }))).toMatch(/commit value/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, expectedRecipientAddress: PARENT.address! }))).toMatch(/recipient/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, expectedPostage: POSTAGE + 1n }))).toMatch(/postage/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: 'not a psbt' }))).toMatch(/does not decode/);
  });

  it('wrong sighash: pinned mode, parent expected but signed default, all vs default', () => {
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: good, expectedSighash: 'all' }))).toMatch(/sighash type must be 0x1, got 0x0/);
    const allSigned = walletSign(buildUnsignedRevealPsbt(args('output', c, { sighash: 'all' })).psbtBase64, WALLET.tweakedPriv, 0x01);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: allSigned, expectedSighash: 'default' }))).toMatch(/must be 0x0, got 0x1/);
    expect(verifyWalletSignedReveal({ ...exp, psbtBase64: allSigned })).toEqual({ ok: true });
    // A parent reveal signed with the wrong hash type: the service cannot attach the parent.
    const pc = content(12);
    const pb = buildUnsignedRevealPsbt(withParentArgs('output', pc));
    const tx = Transaction.fromPSBT(base64.decode(pb.psbtBase64), OPTS);
    tx.updateInput(0, { sighashType: 0x00 }, true);
    tx.signIdx(WALLET.tweakedPriv, 0, [0x00]);
    const pe = { ...expected('output', pc), expectedParentReturnAddress: PARENT.address!, expectedParentValue: PARENT_VALUE };
    expect(reason(verifyWalletSignedReveal({ ...pe, psbtBase64: base64.encode(tx.toPSBT()) }))).toMatch(/must be 0x81, got 0x0/);
    expect(reason(verifyWalletSignedReveal({ ...pe, psbtBase64: base64.encode(tx.toPSBT()), expectedSighash: 'default' }))).toMatch(/parent must be signed/);
  });

  it('tampering after signing breaks verification and finalization', () => {
    const tx = Transaction.fromPSBT(base64.decode(good), OPTS);
    const sigs = tx.getInput(0).tapScriptSig!;
    const t = new Transaction(OPTS);
    t.addOutput({ script: RECIPIENT.script, amount: POSTAGE + 1n });
    t.addInput({ ...tx.getInput(0), tapScriptSig: sigs });
    const tampered = base64.encode(t.toPSBT());
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: tampered }))).toMatch(/postage mismatch/);
    expect(reason(verifyWalletSignedReveal({ ...exp, psbtBase64: tampered, expectedPostage: POSTAGE + 1n }))).toMatch(/does not verify/);
    expect(() => finalizeWalletSignedReveal(tampered)).toThrow(/does not verify/);
  });
});

describe('buildUnsignedRescuePsbt: [commit] -> [child], the wallet re-signs any time', () => {
  for (const kind of KINDS) {
    it(`[${kind}] signs with the wallet key, exact weight == re-signed rescue weight, fee = commitValue - postage`, () => {
      const c = content(555);
      const rescue = buildUnsignedRescuePsbt(rescueArgs(kind, c));
      expect(rescue.inputIndex).toBe(0);
      expect(rescue.commitAddress).toBe(commitAddress(leafKeyFor(kind), c, NETWORK).address);
      expect(rescue.fee).toBe(COMMIT_VALUE - POSTAGE);
      expect(rescue.sighashType).toBe(0x00);
      // Same commit as the parent reveal: whichever confirms first wins.
      const reveal = buildUnsignedRevealPsbt(withParentArgs(kind, c));
      expect(reveal.commitAddress).toBe(rescue.commitAddress);

      const signed = walletSign(rescue.psbtBase64, signerFor(kind), 0x00);
      expect(verifyWalletSignedReveal({ ...expected(kind, c), psbtBase64: signed, expectedSighash: 'default' })).toEqual({ ok: true });
      const fin = finalizeWalletSignedReveal(signed);
      const tx = Transaction.fromRaw(hex.decode(fin.hex), OPTS);
      expect(tx.inputsLength).toBe(1);
      expect(tx.outputsLength).toBe(1);
      expect(tx.getOutput(0)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
      expect(tx.getInput(0).finalScriptWitness![0]!.length).toBe(64);
      const est = estimateResignedRescueWeight({ content: c, recipientScript: RECIPIENT.script });
      expect(fin.weight).toBe(est);
      expect(tx.weight).toBe(est);
      expect(est).toBe(estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script, commitSighash: 'default' }));
    });
  }

  it("sighash 'all' for wallets that refuse SIGHASH_DEFAULT: 65-byte signature, weight +1", () => {
    const c = content(555);
    const rescue = buildUnsignedRescuePsbt(rescueArgs('output', c, { sighash: 'all' }));
    expect(rescue.sighashType).toBe(0x01);
    const fin = finalizeWalletSignedReveal(walletSign(rescue.psbtBase64, WALLET.tweakedPriv, 0x01));
    expect(fin.weight).toBe(estimateResignedRescueWeight({ content: c, recipientScript: RECIPIENT.script }) + 1);
    expect(() => buildUnsignedRescuePsbt({ ...rescueArgs('output', c), sighash: 'all_anyonecanpay' as 'all' })).toThrow(/rescue sighash/);
  });

  it('feeRate: refuses an underfunded commit', () => {
    const c = content(555);
    const est = estimateResignedRescueWeight({ content: c, recipientScript: RECIPIENT.script });
    const q = quoteReveal({ revealWeight: est, feeRate: 5, postage: POSTAGE });
    expect(buildUnsignedRescuePsbt({ ...rescueArgs('output', c), commitValue: q.commitValue, feeRate: 5 }).fee).toBe(q.revealFee);
    expect(() => buildUnsignedRescuePsbt({ ...rescueArgs('output', c), commitValue: q.commitValue - 1n, feeRate: 5 })).toThrow(/needed at 5/);
    expect(() => buildUnsignedRescuePsbt({ ...rescueArgs('output', c), commitValue: q.commitValue - 1n })).not.toThrow();
    // 'all' costs one more witness byte, which can tip the vsize.
    const estAll = estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script, commitSighash: 'all' });
    expect(estAll).toBe(est + 1);
  });

  it('validates its inputs', () => {
    expect(() => buildUnsignedRescuePsbt({ ...rescueArgs('output'), leafPubkey: new Uint8Array(31) })).toThrow(/leafPubkey/);
    expect(() => buildUnsignedRescuePsbt({ ...rescueArgs('output'), postage: 1n })).toThrow(/postage/);
    expect(() => buildUnsignedRescuePsbt({ ...rescueArgs('output'), commitValue: POSTAGE })).toThrow(/commitValue/);
  });
});
