/**
 * PSBT inspection for BIP341 key-path spends. The signer trusts NOTHING the caller says about the input:
 * it re-derives the P2TR output script from the key it holds, checks the input actually pays it, refuses
 * script-path material, and computes the sighash itself from the PSBT's own prevouts.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { base64, hex } from '@scure/base';
import { Address, NETWORK, OutScript, p2tr, TEST_NETWORK, Transaction } from '@scure/btc-signer';
import { SignerError } from './errors.js';

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

const REGTEST = { ...TEST_NETWORK, bech32: 'bcrt' };
export function btcNetwork(n: BitcoinNetwork): typeof NETWORK {
  return n === 'mainnet' ? NETWORK : n === 'regtest' ? REGTEST : TEST_NETWORK;
}

/** BIP341 hash types a key-path signer can be asked for. */
export const SIGHASH_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);

export interface Prevout {
  txid: string;
  vout: number;
  amount: bigint;
  script: string;
}

export interface TaprootInspection {
  tx: Transaction;
  inputIndex: number;
  sighashType: number;
  /** BIP341 sighash the signature must be made over. */
  digest: Uint8Array;
  /** Output (tweaked) key the input's script commits to; signatures verify against it. */
  outputKey: Uint8Array;
  input: Prevout;
  inputs: Prevout[];
  outputs: Array<{ amount: bigint; script: string; address?: string }>;
  version: number;
  lockTime: number;
  fee: bigint;
}

const PSBT_OPTS = { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true } as const;

export function parsePsbt(psbtBase64: string): Transaction {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(psbtBase64);
  } catch (e) {
    throw new SignerError('psbt_invalid', 'psbtBase64 is not valid base64', { cause: e });
  }
  try {
    return Transaction.fromPSBT(bytes, PSBT_OPTS);
  } catch (e) {
    throw new SignerError('psbt_invalid', `not a valid PSBT: ${(e as Error).message}`, { cause: e });
  }
}

function prevoutOf(tx: Transaction, i: number): Prevout {
  const inp = tx.getInput(i);
  if (!inp.txid || inp.index === undefined) throw new SignerError('psbt_invalid', `input ${i} has no outpoint`);
  const txid = hex.encode(inp.txid);
  if (inp.witnessUtxo) return { txid, vout: inp.index, amount: inp.witnessUtxo.amount, script: hex.encode(inp.witnessUtxo.script) };
  const prev = inp.nonWitnessUtxo?.outputs?.[inp.index];
  if (prev) return { txid, vout: inp.index, amount: prev.amount, script: hex.encode(prev.script) };
  throw new SignerError('psbt_invalid', `input ${i} has neither witnessUtxo nor nonWitnessUtxo; BIP341 needs every prevout`);
}

function addressOf(script: Uint8Array, network: BitcoinNetwork): string | undefined {
  try {
    return Address(btcNetwork(network)).encode(OutScript.decode(script));
  } catch {
    return undefined;
  }
}

/**
 * Verify that `inputIndex` is a key-path spend of `xOnlyInternalKey` (no script tree) and compute its
 * BIP341 sighash. Throws `input_mismatch` for any other input, `already_signed` when the input already
 * carries a key-path signature or final witness, `psbt_invalid` for malformed PSBTs.
 */
export function inspectTaprootKeyPath(
  psbtBase64: string,
  inputIndex: number,
  xOnlyInternalKey: Uint8Array,
  network: BitcoinNetwork = 'mainnet',
): TaprootInspection {
  if (!Number.isInteger(inputIndex) || inputIndex < 0) throw new SignerError('invalid_request', 'inputIndex must be a non-negative integer');
  const tx = parsePsbt(psbtBase64);
  if (inputIndex >= tx.inputsLength) throw new SignerError('invalid_request', `inputIndex ${inputIndex} out of range (${tx.inputsLength} inputs)`);

  const inputs: Prevout[] = [];
  for (let i = 0; i < tx.inputsLength; i++) inputs.push(prevoutOf(tx, i));
  const input = inputs[inputIndex]!;
  const target = tx.getInput(inputIndex);

  const expected = p2tr(xOnlyInternalKey, undefined, btcNetwork(network));
  if (input.script !== hex.encode(expected.script))
    throw new SignerError('input_mismatch', `input ${inputIndex} does not pay the key-path P2TR output of this key`);
  if (target.tapInternalKey && hex.encode(target.tapInternalKey) !== hex.encode(xOnlyInternalKey))
    throw new SignerError('input_mismatch', `input ${inputIndex} declares a different tapInternalKey`);
  if (target.tapMerkleRoot && target.tapMerkleRoot.length > 0)
    throw new SignerError('input_mismatch', `input ${inputIndex} commits to a script tree; only key-path spends are signed`);
  if (target.tapLeafScript && target.tapLeafScript.length > 0)
    throw new SignerError('input_mismatch', `input ${inputIndex} carries tapLeafScript; only key-path spends are signed`);
  if (target.tapKeySig || target.finalScriptWitness) throw new SignerError('already_signed', `input ${inputIndex} is already signed`);

  const sighashType = target.sighashType ?? 0x00;
  if (!SIGHASH_TYPES.has(sighashType)) throw new SignerError('psbt_invalid', `input ${inputIndex} requests unsupported sighash type ${sighashType}`);

  let digest: Uint8Array;
  try {
    digest = tx.preimageWitnessV1(
      inputIndex,
      inputs.map((p) => hex.decode(p.script)),
      sighashType,
      inputs.map((p) => p.amount),
    );
  } catch (e) {
    throw new SignerError('psbt_invalid', `cannot compute sighash: ${(e as Error).message}`, { cause: e });
  }

  const outputs: TaprootInspection['outputs'] = [];
  let outSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new SignerError('psbt_invalid', `output ${i} is incomplete`);
    outSum += o.amount;
    const address = addressOf(o.script, network);
    outputs.push({ amount: o.amount, script: hex.encode(o.script), ...(address ? { address } : {}) });
  }
  const inSum = inputs.reduce((a, p) => a + p.amount, 0n);

  return {
    tx,
    inputIndex,
    sighashType,
    digest,
    outputKey: expected.tweakedPubkey,
    input,
    inputs,
    outputs,
    version: tx.version,
    lockTime: tx.lockTime,
    fee: inSum - outSum,
  };
}

/** Attach a key-path signature (64 bytes + sighash byte unless DEFAULT) to the input; optionally finalize. */
export function attachKeyPathSignature(insp: TaprootInspection, sig64: Uint8Array, finalize: boolean): { psbtBase64: string; txid?: string } {
  if (sig64.length !== 64) throw new SignerError('signature_invalid', 'key provider returned a signature that is not 64 bytes');
  if (!schnorr.verify(sig64, insp.digest, insp.outputKey))
    throw new SignerError('signature_invalid', 'signature does not verify against the tweaked output key');
  const tapKeySig = insp.sighashType === 0x00 ? sig64 : new Uint8Array([...sig64, insp.sighashType]);
  insp.tx.updateInput(insp.inputIndex, { tapKeySig }, true);
  let txid: string | undefined;
  if (finalize) {
    insp.tx.finalizeIdx(insp.inputIndex);
    // Only complete transactions have a txid worth reporting.
    try {
      txid = insp.tx.id;
    } catch {
      txid = undefined;
    }
  }
  return { psbtBase64: base64.encode(insp.tx.toPSBT()), ...(txid ? { txid } : {}) };
}
