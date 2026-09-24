import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { RawTx, SigHash, Transaction, TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '../src/bytes.js';
import { commitEnvelope, newRevealKey, reKeyEnvelope, xOnlyPubkey } from '../src/envelope.js';
import {
  buildCommitPsbt,
  buildPlainPsbt,
  buildRevealPsbt,
  commitTopUp,
  coreCommitOutput,
  finalize,
  revealOutputTotal,
  revealWeightOf,
  signRevealLocally,
  unsignedRevealTxid,
} from '../src/psbt.js';
import { CNTRPRTY_OP_RETURN, CORE_ENVELOPE, ORD_ENVELOPE, SOURCE_ADDRESS, SOURCE_SCRIPT, makeCompose, rawWeight } from './fixtures.js';

const psbt = (b64: string) => Transaction.fromPSBT(base64.decode(b64), { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });

describe('reading the compose', () => {
  it("finds Core's commit output by identity and reads the reveal outputs", () => {
    const fx = makeCompose({ envelope: hexToBytes(CORE_ENVELOPE) });
    expect(coreCommitOutput(fx.compose)).toEqual({ index: 0, value: fx.coreCommitValue });
    expect(revealOutputTotal(fx.compose)).toBe(0);
    const ord = makeCompose({ envelope: hexToBytes(ORD_ENVELOPE) });
    expect(revealOutputTotal(ord.compose)).toBe(546);
  });

  it("reveal weight is Core's plus the SIGHASH_ALL byte", () => {
    const fx = makeCompose({ body: new Uint8Array(3000), mimeType: 'image/png' });
    const coreWeight = rawWeight(fx.compose.signed_reveal_rawtransaction!);
    expect(revealWeightOf(fx.compose, 'default')).toBe(coreWeight);
    expect(revealWeightOf(fx.compose)).toBe(coreWeight + 1);
  });

  it('refuses a compose without the taproot pair', () => {
    expect(() => coreCommitOutput({ rawtransaction: '00' })).toThrow(/no commit\/reveal pair/);
  });
});

describe('commitTopUp', () => {
  it('covers the one witness byte Core does not price, never a reduction', () => {
    const fx = makeCompose({ body: new Uint8Array(3000), mimeType: 'image/png', feeRate: 2 });
    const coreWeight = rawWeight(fx.compose.signed_reveal_rawtransaction!);
    const vsize64 = Math.ceil(coreWeight / 4);
    const vsize65 = Math.ceil((coreWeight + 1) / 4);
    const expected = Math.max(0, Math.ceil(vsize65 * 2) - Math.max(Math.ceil(vsize64 * 2), 330));
    expect(commitTopUp(fx.compose, 2)).toBe(expected);
    expect(expected === 0 || expected === 2).toBe(true);
  });

  it('is 0 when the 330-sat floor already overpays the reveal', () => {
    const fx = makeCompose({ envelope: hexToBytes(CORE_ENVELOPE), feeRate: 0.5 });
    expect(fx.coreCommitValue).toBe(330);
    expect(commitTopUp(fx.compose, 0.5)).toBe(0);
  });

  it('rounds a fractional rate up, never below the rate claimed', () => {
    const fx = makeCompose({ body: new Uint8Array(5000), mimeType: 'image/png', feeRate: 1 });
    const w = rawWeight(fx.compose.signed_reveal_rawtransaction!);
    const up = commitTopUp(fx.compose, 1.37);
    expect(up).toBe(Math.ceil(Math.ceil((w + 1) / 4) * 1.37) - fx.coreCommitValue);
    expect(() => commitTopUp(fx.compose, 0)).toThrow(/positive/);
  });
});

describe('buildCommitPsbt', () => {
  const key = newRevealKey();
  const pub = xOnlyPubkey(key);

  it("reuses Core's inputs when no UTXOs are given, moving the top-up out of change", () => {
    const fx = makeCompose({ body: new Uint8Array(3000), mimeType: 'image/png' });
    const topUp = 7;
    const out = buildCommitPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, utxos: [], changeAddress: SOURCE_ADDRESS, feeRate: 2, topUpSats: topUp });
    const tx = psbt(out.psbtBase64);
    expect(out.commitVout).toBe(0);
    expect(out.commitValue).toBe(fx.coreCommitValue + topUp);
    expect(out.inputsToSign).toEqual([0]);
    expect(out.fee).toBe(fx.compose.btc_fee);
    const input = tx.getInput(0);
    expect(bytesToHex(input.witnessUtxo!.script)).toBe(fx.sourceUtxo.scriptPubKey);
    expect(input.witnessUtxo!.amount).toBe(BigInt(fx.sourceUtxo.value));
    expect(input.sighashType).toBe(SigHash.ALL);
    // Commit output pays OUR address (NUMS + re-keyed leaf), not Core's.
    const expected = commitEnvelope(reKeyEnvelope(fx.envelope, pub), 'mainnet');
    expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(expected.script));
    expect(tx.getOutput(0).amount).toBe(BigInt(fx.coreCommitValue + topUp));
    expect(tx.getOutput(1).amount).toBe(BigInt(fx.compose.btc_change! - topUp));
    expect(bytesToHex(tx.getOutput(1).script!)).toBe(bytesToHex(SOURCE_SCRIPT));
    expect(out.commit.address).toBe(expected.address);
  });

  it('funds from given UTXOs with change and a fee at the rate', () => {
    const fx = makeCompose({ body: new Uint8Array(3000), mimeType: 'image/png' });
    const utxos = [
      { txid: 'a'.repeat(64), vout: 0, value: 20_000, scriptPubKey: bytesToHex(SOURCE_SCRIPT) },
      { txid: 'b'.repeat(64), vout: 3, value: 5_000, scriptPubKey: bytesToHex(SOURCE_SCRIPT) },
    ];
    const out = buildCommitPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, utxos, changeAddress: SOURCE_ADDRESS, feeRate: 3, topUpSats: 2 });
    const tx = psbt(out.psbtBase64);
    expect(tx.inputsLength).toBe(1); // largest-first covers it
    expect(out.inputsToSign).toEqual([0]);
    expect(bytesToHex(tx.getInput(0).txid!)).toBe('a'.repeat(64));
    expect(tx.getOutput(0).amount).toBe(BigInt(fx.coreCommitValue + 2));
    expect(out.commitVout).toBe(0);
    // 1 P2TR in, 2 P2TR out: 10.5 + 57.5 + 43 + 43 = 154 vB → 462 sat at 3 sat/vB
    expect(out.fee).toBe(462);
    expect(tx.getOutput(1).amount).toBe(BigInt(20_000 - out.commitValue - 462));
  });

  it('refuses insufficient funds and unknown coin types', () => {
    const fx = makeCompose({ body: new Uint8Array(3000), mimeType: 'image/png' });
    const small = [{ txid: 'a'.repeat(64), vout: 0, value: 100, scriptPubKey: bytesToHex(SOURCE_SCRIPT) }];
    expect(() => buildCommitPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, utxos: small, changeAddress: SOURCE_ADDRESS, feeRate: 1 })).toThrow(/Insufficient/);
    const legacy = [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, scriptPubKey: '76a914' + '00'.repeat(20) + '88ac' }];
    expect(() => buildCommitPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, utxos: legacy, changeAddress: SOURCE_ADDRESS, feeRate: 1 })).toThrow(/P2TR/);
  });
});

describe('buildRevealPsbt → signRevealLocally → finalize', () => {
  const key = newRevealKey();
  const pub = xOnlyPubkey(key);

  it.each([
    ['native', CORE_ENVELOPE],
    ['ord', ORD_ENVELOPE],
  ])('%s: script-path input with witnessUtxo, tapLeafScript and the NUMS internal key', (_style, envelopeHex) => {
    const fx = makeCompose({ envelope: hexToBytes(envelopeHex), feeRate: 2 });
    const commit = buildCommitPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, utxos: [], changeAddress: SOURCE_ADDRESS, feeRate: 2, topUpSats: commitTopUp(fx.compose, 2) });
    const commitTxid = unsignedRevealTxid(commit.psbtBase64); // txid of the unsigned commit == signed (segwit)
    const reveal = buildRevealPsbt({
      network: 'mainnet',
      compose: fx.compose,
      leafKey32: pub,
      commitOutpoint: { txid: commitTxid, vout: commit.commitVout },
      commitValue: commit.commitValue,
      destinationAddress: SOURCE_ADDRESS,
    });
    const tx = psbt(reveal.psbtBase64);
    expect(reveal.inputIndex).toBe(0);
    const input = tx.getInput(0);
    expect(bytesToHex(input.txid!)).toBe(commitTxid);
    expect(input.index).toBe(commit.commitVout);
    expect(bytesToHex(input.witnessUtxo!.script)).toBe(bytesToHex(commit.commit.script));
    expect(input.witnessUtxo!.amount).toBe(BigInt(commit.commitValue));
    expect(bytesToHex(input.tapInternalKey!)).toBe(bytesToHex(TAPROOT_UNSPENDABLE_KEY));
    expect(input.tapLeafScript).toHaveLength(1);
    const [control, script] = input.tapLeafScript![0]!;
    expect(bytesToHex(control.internalKey)).toBe(bytesToHex(TAPROOT_UNSPENDABLE_KEY));
    expect(control.merklePath).toHaveLength(0);
    expect(bytesToHex(script.subarray(0, script.length - 1))).toBe(bytesToHex(reKeyEnvelope(fx.envelope, pub)));
    // Outputs are Core's, verbatim: OP_RETURN CNTRPRTY first.
    expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(CNTRPRTY_OP_RETURN));
    expect(tx.getOutput(0).amount).toBe(0n);
    expect(tx.outputsLength).toBe(envelopeHex === ORD_ENVELOPE ? 2 : 1);

    // Local sign → finalize: a 3-item witness, and the txid predicted before signing.
    const predicted = unsignedRevealTxid(reveal.psbtBase64);
    const signed = signRevealLocally(reveal.psbtBase64, key);
    const final = finalize(signed);
    expect(final.txid).toBe(predicted);
    const raw = RawTx.decode(hexToBytes(final.hex));
    const witness = raw.witnesses![0]!;
    expect(witness).toHaveLength(3);
    expect(witness[0]).toHaveLength(65);
    expect(witness[0]![64]).toBe(SigHash.ALL);
    expect(bytesToHex(witness[1]!)).toBe(bytesToHex(reKeyEnvelope(fx.envelope, pub)));
    expect(witness[2]).toHaveLength(33);
    expect(bytesToHex(witness[2]!.subarray(1))).toBe(bytesToHex(TAPROOT_UNSPENDABLE_KEY));
    expect(final.weight).toBe(rawWeight(final.hex));
    expect(final.vsize).toBe(Math.ceil(final.weight / 4));
    // Same shape as Core's reveal, one byte heavier (the sighash flag).
    expect(final.weight).toBe(revealWeightOf(fx.compose));
    // The reveal is funded at or above the rate asked.
    const fee = commit.commitValue - revealOutputTotal(fx.compose);
    expect(fee).toBeGreaterThanOrEqual(Math.ceil(final.vsize * 2));
  });

  it('signs SIGHASH_DEFAULT when asked, and matches Core weight exactly', () => {
    const fx = makeCompose({ body: new Uint8Array(1200), mimeType: 'image/png' });
    const reveal = buildRevealPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, commitOutpoint: { txid: 'c'.repeat(64), vout: 0 }, commitValue: fx.coreCommitValue, destinationAddress: SOURCE_ADDRESS, sighash: 'default' });
    const final = finalize(signRevealLocally(reveal.psbtBase64, key));
    expect(RawTx.decode(hexToBytes(final.hex)).witnesses![0]![0]).toHaveLength(64);
    expect(final.weight).toBe(revealWeightOf(fx.compose, 'default'));
  });

  it('refuses a key that does not open this envelope', () => {
    const fx = makeCompose({ envelope: hexToBytes(CORE_ENVELOPE) });
    const reveal = buildRevealPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, commitOutpoint: { txid: 'c'.repeat(64), vout: 0 }, commitValue: 1000, destinationAddress: SOURCE_ADDRESS });
    expect(() => signRevealLocally(reveal.psbtBase64, newRevealKey())).toThrow(/does not match/);
    expect(() => finalize(reveal.psbtBase64)).toThrow(/unsigned/);
  });

  it('re-points the ord postage to the destination but never the marker', () => {
    const fx = makeCompose({ envelope: hexToBytes(ORD_ENVELOPE) });
    const other = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
    const reveal = buildRevealPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, commitOutpoint: { txid: 'c'.repeat(64), vout: 0 }, commitValue: 1000, destinationAddress: other });
    const tx = psbt(reveal.psbtBase64);
    expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(CNTRPRTY_OP_RETURN));
    expect(tx.getOutput(1).amount).toBe(546n);
    expect(bytesToHex(tx.getOutput(1).script!)).not.toBe(bytesToHex(SOURCE_SCRIPT));
    // A different script type would change the reveal's size Core funded.
    const p2wpkh = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    expect(() => buildRevealPsbt({ network: 'mainnet', compose: fx.compose, leafKey32: pub, commitOutpoint: { txid: 'c'.repeat(64), vout: 0 }, commitValue: 1000, destinationAddress: p2wpkh })).toThrow(/same script type/);
  });
});

describe('buildPlainPsbt', () => {
  it("turns Core's raw transaction into a signable PSBT with its prevouts", () => {
    const fx = makeCompose({ envelope: hexToBytes(CORE_ENVELOPE) });
    const tx = psbt(buildPlainPsbt(fx.compose, 'mainnet'));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getInput(0).witnessUtxo!.amount).toBe(BigInt(fx.sourceUtxo.value));
    expect(tx.getInput(0).sighashType).toBe(SigHash.ALL);
    expect(() => buildPlainPsbt({ rawtransaction: fx.compose.rawtransaction }, 'mainnet')).toThrow(/verbose=true/);
  });
});
