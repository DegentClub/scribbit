import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { SigHash } from '@scure/btc-signer';
import { InMemoryAuditLog, InMemoryKeyProvider, Signer, SignerError, attachKeyPathSignature, inspectTaprootKeyPath } from '../src/index.js';
import {
  P2TR_A,
  P2TR_B,
  PRIV_A,
  RECIPIENT,
  XONLY_A,
  XONLY_B,
  bip341KeyPathSighash,
  fromPsbt,
  keyPathPsbt,
  outputsOf,
  prevoutsOf,
} from './helpers.js';

const signer = () =>
  new Signer({
    keys: new InMemoryKeyProvider([['a', PRIV_A]]),
    audit: new InMemoryAuditLog(),
    allowedPurposes: [],
    allowedSighashTypes: [0x00, 0x01, 0x81, 0x83],
    network: 'signet',
  });

describe('BIP341 key-path sighash', () => {
  it.each([
    ['DEFAULT', 0x00],
    ['ALL', 0x01],
    ['ALL|ANYONECANPAY', 0x81],
    ['SINGLE|ANYONECANPAY', 0x83],
  ])('%s: matches an independent implementation of the BIP text and btc-signer preimageWitnessV1', (_n, hashType) => {
    const { psbtBase64 } = keyPathPsbt({ sighashType: hashType === 0 ? undefined : hashType, extraInputs: 1 });
    const insp = inspectTaprootKeyPath(psbtBase64, 0, XONLY_A, 'signet');
    expect(insp.sighashType).toBe(hashType);

    const tx = fromPsbt(psbtBase64);
    const prevouts = prevoutsOf(tx);
    const independent = bip341KeyPathSighash({ version: tx.version, lockTime: tx.lockTime, outputs: outputsOf(tx) }, prevouts, 0, hashType);
    const viaBtcSigner = tx.preimageWitnessV1(0, prevouts.map((p) => p.script), hashType, prevouts.map((p) => p.amount));
    expect(hex.encode(insp.digest)).toBe(hex.encode(independent));
    expect(hex.encode(insp.digest)).toBe(hex.encode(viaBtcSigner));
  });

  it('exposes prevouts, outputs with signet addresses, and the fee to policies', () => {
    const { psbtBase64 } = keyPathPsbt({ amount: 50_000n, outputs: [{ address: RECIPIENT, amount: 48_500n }] });
    const insp = inspectTaprootKeyPath(psbtBase64, 0, XONLY_A, 'signet');
    expect(insp.input).toMatchObject({ vout: 0, amount: 50_000n, script: hex.encode(P2TR_A.script) });
    expect(insp.outputs).toEqual([{ amount: 48_500n, script: hex.encode(P2TR_B.script), address: RECIPIENT }]);
    expect(insp.fee).toBe(1_500n);
    expect(hex.encode(insp.outputKey)).toBe(hex.encode(P2TR_A.tweakedPubkey));
  });
});

describe('signTaprootKeyPath', () => {
  it('produces a signature that verifies against the tweaked output key and that btc-signer accepts', async () => {
    const { psbtBase64 } = keyPathPsbt();
    const res = await signer().signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' });
    expect(res.sighashType).toBe(0);
    expect(res.signature).toHaveLength(128);
    expect(schnorr.verify(hex.decode(res.signature), hex.decode(res.digest), P2TR_A.tweakedPubkey)).toBe(true);
    // It is NOT a signature by the untweaked key.
    expect(schnorr.verify(hex.decode(res.signature), hex.decode(res.digest), XONLY_A)).toBe(false);

    const signed = fromPsbt(res.psbtBase64);
    expect(hex.encode(signed.getInput(0).tapKeySig!)).toBe(res.signature);
    // btc-signer finalizes it as a valid key-path spend and extracts a transaction with a 64-byte witness.
    signed.finalizeIdx(0);
    const raw = signed.extract();
    expect(raw.length).toBeGreaterThan(100);
    expect(signed.getInput(0).finalScriptWitness).toHaveLength(1);
    expect(signed.getInput(0).finalScriptWitness![0]).toHaveLength(64);
  });

  it('cross-check: btc-signer signing the same PSBT itself verifies against the signer digest', async () => {
    const { psbtBase64 } = keyPathPsbt({ sighashType: SigHash.ALL });
    const ours = await signer().signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' });
    const theirs = fromPsbt(psbtBase64);
    expect(theirs.signIdx(PRIV_A, 0, [SigHash.ALL])).toBe(true);
    const theirSig = theirs.getInput(0).tapKeySig!;
    expect(theirSig).toHaveLength(65);
    expect(theirSig[64]).toBe(0x01);
    expect(schnorr.verify(theirSig.subarray(0, 64), hex.decode(ours.digest), P2TR_A.tweakedPubkey)).toBe(true);
    expect(ours.sighashType).toBe(1);
    expect(fromPsbt(ours.psbtBase64).getInput(0).tapKeySig).toHaveLength(65);
  });

  it('finalize: true returns a finalized input and a txid', async () => {
    const { psbtBase64 } = keyPathPsbt();
    const res = await signer().signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a', finalize: true });
    expect(res.txid).toMatch(/^[0-9a-f]{64}$/);
    const signed = fromPsbt(res.psbtBase64);
    expect(signed.getInput(0).finalScriptWitness).toHaveLength(1);
    expect(signed.id).toBe(res.txid);
  });

  it('rejects an input that pays a different key (script mismatch)', async () => {
    const { psbtBase64 } = keyPathPsbt({ payTo: P2TR_B });
    await expect(signer().signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' })).rejects.toMatchObject({ code: 'input_mismatch', status: 422 });
  });

  it('rejects a PSBT whose tapInternalKey disagrees with the key even when the script matches', () => {
    const { psbtBase64 } = keyPathPsbt({ tapInternalKey: XONLY_B, disableScriptCheck: true });
    // btc-signer already refuses the inconsistent commitment at parse time; either way the signer never signs it.
    expect(() => inspectTaprootKeyPath(psbtBase64, 0, XONLY_A)).toThrow(/tapInternalKey|Taproot commitment/);
  });

  it('rejects script-path spends (merkle root) and already-signed inputs', async () => {
    const { psbtBase64: scriptPath } = keyPathPsbt({ tapMerkleRoot: new Uint8Array(32).fill(9), disableScriptCheck: true });
    expect(() => inspectTaprootKeyPath(scriptPath, 0, XONLY_A)).toThrow(/script tree|Taproot commitment/);

    const { psbtBase64 } = keyPathPsbt();
    const once = await signer().signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' });
    await expect(signer().signTaprootKeyPath({ psbtBase64: once.psbtBase64, inputIndex: 0, keyId: 'a' })).rejects.toMatchObject({ code: 'already_signed' });
  });

  it('rejects out-of-range, non-integer indexes, unknown keys and garbage PSBTs', async () => {
    const { psbtBase64 } = keyPathPsbt();
    const s = signer();
    await expect(s.signTaprootKeyPath({ psbtBase64, inputIndex: 1, keyId: 'a' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(s.signTaprootKeyPath({ psbtBase64, inputIndex: 0.5, keyId: 'a' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(s.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'nope' })).rejects.toMatchObject({ code: 'unknown_key', status: 404 });
    await expect(s.signTaprootKeyPath({ psbtBase64: 'not base64!!', inputIndex: 0, keyId: 'a' })).rejects.toMatchObject({ code: 'psbt_invalid' });
    await expect(s.signTaprootKeyPath({ psbtBase64: 'AAAA', inputIndex: 0, keyId: 'a' })).rejects.toMatchObject({ code: 'psbt_invalid' });
  });

  it('refuses to attach a signature that does not verify (a misbehaving key provider)', () => {
    const { psbtBase64 } = keyPathPsbt();
    const insp = inspectTaprootKeyPath(psbtBase64, 0, XONLY_A);
    expect(() => attachKeyPathSignature(insp, new Uint8Array(64), false)).toThrow(/does not verify/);
    expect(() => attachKeyPathSignature(insp, new Uint8Array(63), false)).toThrow(/not 64 bytes/);
  });

  it('a key provider that ignores the tweak yields a signature the signer refuses to return', async () => {
    const untweaked = new InMemoryKeyProvider([['a', PRIV_A]]);
    const raw = untweaked.sign.bind(untweaked);
    untweaked.sign = (id, msg) => raw(id, msg, {}); // drops opts.tweak
    const s = new Signer({ keys: untweaked, audit: new InMemoryAuditLog(), allowedPurposes: [] });
    const { psbtBase64 } = keyPathPsbt();
    await expect(s.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' })).rejects.toMatchObject({ code: 'signature_invalid' });
  });
});
