import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { base64, hex } from '@scure/base';
import { p2tr, Transaction } from '@scure/btc-signer';
import {
  attachParent,
  buildHalfSignedReveal,
  buildRescueReveal,
  commitAddress,
  finalizeReveal,
  inscriptionIdFromReveal,
  sha256Hex,
  signParentInput,
  type RevealSighashMode,
} from '../src/index.js';
import {
  buildAll,
  COMMIT_OUTPOINT,
  content,
  NETWORK,
  PARENT,
  PARENT_OUTPOINT,
  PARENT_PRIV,
  PARENT_VALUE,
  POSTAGE,
  RECIPIENT,
  RECIPIENT_PRIV,
  REVEAL_PRIV,
  REVEAL_PUB,
} from './helpers.js';

const OPTS = { allowUnknownInputs: true } as const;
const COMMIT_VALUE = 20_000n;

describe.each<RevealSighashMode>(['all_anyonecanpay', 'single_anyonecanpay'])('parent co-signing and finalization (%s)', (mode) => {
  const c = content(5000);
  const commit = commitAddress(REVEAL_PUB, c, NETWORK);
  const { half, attached, signed, final } = buildAll(c, COMMIT_VALUE, mode);

  it('attachParent yields [parent, commit] -> [parent return, child] with input 0 unsigned', () => {
    const tx = Transaction.fromPSBT(base64.decode(attached.psbtBase64), OPTS);
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(2);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(PARENT_OUTPOINT.txid);
    expect(tx.getInput(0).tapKeySig).toBeUndefined();
    expect(hex.encode(tx.getInput(1).txid!)).toBe(COMMIT_OUTPOINT.txid);
    expect(tx.getInput(1).tapScriptSig![0]![1]).toEqual(half.signature);
    expect(tx.getOutput(0)).toMatchObject({ script: PARENT.script, amount: PARENT_VALUE });
    expect(tx.getOutput(1)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
    expect(tx.fee).toBe(COMMIT_VALUE - POSTAGE);
  });

  it('finalizeReveal throws while the parent input is unsigned', () => {
    expect(() => finalizeReveal(attached.psbtBase64)).toThrow(/input 0 is unsigned/);
  });

  it('parent key-path signature verifies against the tweaked collection key (BIP341, SIGHASH_DEFAULT)', () => {
    const tx = Transaction.fromRaw(hex.decode(final.hex), OPTS);
    const w = tx.getInput(0).finalScriptWitness!;
    expect(w.length).toBe(1);
    expect(w[0]!.length).toBe(64);
    const msg = tx.preimageWitnessV1(0, [PARENT.script, commit.script], 0x00, [PARENT_VALUE, COMMIT_VALUE]);
    const tweaked = p2tr(schnorr.getPublicKey(PARENT_PRIV)).tweakedPubkey;
    expect(schnorr.verify(w[0]!, msg, tweaked)).toBe(true);
    expect(schnorr.verify(w[0]!, msg, schnorr.getPublicKey(PARENT_PRIV))).toBe(false); // untweaked key must NOT verify
    expect(final.txid).toBe(tx.id);
    expect(final.hex).toBe(hex.encode(tx.toBytes(true, true)));
    expect(inscriptionIdFromReveal(final.txid)).toBe(`${final.txid}i0`);
  });

  it('signParentInput refuses a key that does not control input 0', () => {
    expect(() => signParentInput(attached.psbtBase64, RECIPIENT_PRIV)).toThrow(/does not control/);
  });

  it('signParentInput refuses a half-signed (1-in/1-out) PSBT', () => {
    expect(() => signParentInput(half.psbtBase64, PARENT_PRIV)).toThrow();
  });

  it('attachParent validates its inputs', () => {
    const base = {
      network: NETWORK,
      halfSignedPsbtBase64: half.psbtBase64,
      parentOutpoint: PARENT_OUTPOINT,
      parentValue: PARENT_VALUE,
      parentScript: PARENT.script,
      parentReturnAddress: PARENT.address!,
    };
    expect(() => attachParent({ ...base, parentScript: hex.decode('0014' + '11'.repeat(20)) })).toThrow(/P2TR/);
    expect(() => attachParent({ ...base, parentOutpoint: COMMIT_OUTPOINT })).toThrow(/equals commit/);
    expect(() => attachParent({ ...base, halfSignedPsbtBase64: attached.psbtBase64 })).toThrow(/exactly 1 input/);
    expect(() => attachParent({ ...base, halfSignedPsbtBase64: signed.psbtBase64 })).toThrow(/exactly 1 input/);
    expect(() => attachParent({ ...base, parentReturnAddress: 'bc1pv8dk4eanpvmxhmxrfsutnl9uv2epyexfnpuh78apmehyddud3ruqxa5cuq' })).toThrow();
  });

  it('signed PSBT finalizes to the same tx as finalizeReveal', () => {
    const tx = Transaction.fromPSBT(base64.decode(signed.psbtBase64), OPTS);
    tx.finalize();
    expect(tx.id).toBe(final.txid);
  });
});

describe('attachParent in 0x81 mode (parent return output pre-committed by the browser)', () => {
  const c = content(2000);
  const base = {
    network: NETWORK,
    revealPrivkey: REVEAL_PRIV,
    content: c,
    commitOutpoint: COMMIT_OUTPOINT,
    commitValue: COMMIT_VALUE,
    recipientAddress: RECIPIENT.address!,
    postage: POSTAGE,
  };
  const half = buildHalfSignedReveal({ ...base, parentReturnAddress: PARENT.address!, parentValue: PARENT_VALUE });
  const attachArgs = {
    network: NETWORK,
    halfSignedPsbtBase64: half.psbtBase64,
    parentOutpoint: PARENT_OUTPOINT,
    parentValue: PARENT_VALUE,
    parentScript: PARENT.script,
    parentReturnAddress: PARENT.address!,
  };

  it('buildHalfSignedReveal requires parentReturnAddress and parentValue when a parent is expected', () => {
    expect(() => buildHalfSignedReveal(base)).toThrow(/parentReturnAddress/);
    expect(() => buildHalfSignedReveal({ ...base, parentReturnAddress: PARENT.address! })).toThrow(/parentValue/);
    expect(() => buildHalfSignedReveal({ ...base, parentReturnAddress: PARENT.address!, parentValue: 0n })).toThrow(/parentValue/);
    expect(() => buildHalfSignedReveal({ ...base, parentReturnAddress: 'bc1pv8dk4eanpvmxhmxrfsutnl9uv2epyexfnpuh78apmehyddud3ruqxa5cuq', parentValue: 1n })).toThrow();
    // 0x83 never needs them (parent return is added by the service).
    expect(Transaction.fromPSBT(base64.decode(buildHalfSignedReveal({ ...base, sighash: 'single_anyonecanpay' }).psbtBase64), OPTS).outputsLength).toBe(1);
  });

  it('does not add a second parent return output; output 0 is the one the browser signed', () => {
    const tx = Transaction.fromPSBT(base64.decode(attachParent(attachArgs).psbtBase64), OPTS);
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(2);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(PARENT_OUTPOINT.txid);
    expect(hex.encode(tx.getInput(1).txid!)).toBe(COMMIT_OUTPOINT.txid);
    expect(tx.getInput(1).tapScriptSig![0]![1]).toEqual(half.signature);
    expect(tx.getOutput(0)).toMatchObject({ script: PARENT.script, amount: PARENT_VALUE });
    expect(tx.getOutput(1)).toMatchObject({ script: RECIPIENT.script, amount: POSTAGE });
    expect(tx.fee).toBe(COMMIT_VALUE - POSTAGE);
  });

  it('refuses a parent return address or value that differs from the signed output 0', () => {
    expect(() => attachParent({ ...attachArgs, parentReturnAddress: RECIPIENT.address! })).toThrow(/output 0 is not the parent return address/);
    expect(() => attachParent({ ...attachArgs, parentValue: PARENT_VALUE + 1n })).toThrow(/output 0 value/);
  });

  it('refuses a 0x81 reveal built without a parent return output', () => {
    const noParent = buildHalfSignedReveal({ ...base, withParent: false });
    expect(() => attachParent({ ...attachArgs, halfSignedPsbtBase64: noParent.psbtBase64 })).toThrow(/without a parent return output/);
  });

  it('buildRescueReveal refuses to replay a 0x81 reveal that pre-committed a parent return, but replays a no-parent one', () => {
    expect(() => buildRescueReveal({ network: NETWORK, halfSignedPsbtBase64: half.psbtBase64 })).toThrow(/buildResignedRescue/);
    const noParent = buildHalfSignedReveal({ ...base, withParent: false });
    const r = buildRescueReveal({ network: NETWORK, halfSignedPsbtBase64: noParent.psbtBase64 });
    const tx = Transaction.fromRaw(hex.decode(r.hex), OPTS);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getInput(0).finalScriptWitness![0]).toEqual(noParent.signature);
    expect(noParent.signature[64]).toBe(0x81);
  });

  it('utilities', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(() => inscriptionIdFromReveal('xyz')).toThrow();
    expect(inscriptionIdFromReveal('AB'.repeat(32), 3)).toBe(`${'ab'.repeat(32)}i3`);
  });
});
