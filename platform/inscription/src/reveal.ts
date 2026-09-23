import { schnorr } from '@noble/curves/secp256k1.js';
import { p2tr, Transaction } from '@scure/btc-signer';
import { assertBytes, equalBytes } from './bytes.js';
import { commitAddress, addressToScript, NUMS_INTERNAL_KEY } from './commit.js';
import {
  LIMITS,
  REVEAL_LOCKTIME,
  REVEAL_SEQUENCE,
  REVEAL_TX_VERSION,
  revealSighashType,
  SIGHASH_ALL_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_SINGLE_ANYONECANPAY,
  TAPSCRIPT_LEAF_VERSION,
  type RevealSighashMode,
  type RevealSighashType,
} from './constants.js';
import type { InscriptionContent } from './envelope.js';
import { networkParams, type Network } from './network.js';
import { decodePsbt, encodePsbt, inputTxid, rawFacts, TX_OPTS } from './psbt.js';
import { revealCommitSighash, type SighashOutput } from './sighash.js';
import { estimateResignedRescueWeight, quoteReveal } from './sizing.js';

export interface Outpoint {
  txid: string;
  vout: number;
}

function checkOutpoint(o: Outpoint, name: string): void {
  if (!o || typeof o.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(o.txid)) throw new Error(`${name}.txid invalid`);
  if (!Number.isSafeInteger(o.vout) || o.vout < 0 || o.vout > 0xffffffff) throw new Error(`${name}.vout invalid`);
}

function isP2TR(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}

/** The tapscript signature on a commit input (65 bytes for 0x81/0x83, 64 for DEFAULT), or undefined. */
export function commitSignature(tx: Transaction, idx: number): Uint8Array | undefined {
  const sigs = tx.getInput(idx).tapScriptSig;
  if (!sigs || sigs.length !== 1) return undefined;
  return sigs[0]![1];
}

function outputsOf(tx: Transaction): SighashOutput[] {
  const outs: SighashOutput[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new Error(`output ${i} incomplete`);
    outs.push({ script: o.script, value: o.amount });
  }
  return outs;
}

/**
 * Structural checks shared by attachParent / buildRescueReveal. Returns the hash type of the
 * commit signature: 0x83 => [commit] -> [child]; 0x81 => [commit] -> [child] or
 * [commit] -> [parent return, child].
 */
function assertHalfSigned(tx: Transaction): RevealSighashType {
  if (tx.inputsLength !== 1) throw new Error(`half-signed reveal must have exactly 1 input (got ${tx.inputsLength})`);
  if (tx.version !== REVEAL_TX_VERSION || tx.lockTime !== REVEAL_LOCKTIME)
    throw new Error('half-signed reveal must have nVersion=2 and nLockTime=0');
  const sig = commitSignature(tx, 0);
  if (!sig || sig.length !== 65 || (sig[64] !== SIGHASH_SINGLE_ANYONECANPAY && sig[64] !== SIGHASH_ALL_ANYONECANPAY))
    throw new Error('commit input must carry exactly one 65-byte SIGHASH_ALL|ANYONECANPAY or SIGHASH_SINGLE|ANYONECANPAY signature');
  const type = sig[64] as RevealSighashType;
  const maxOutputs = type === SIGHASH_ALL_ANYONECANPAY ? 2 : 1;
  if (tx.outputsLength < 1 || tx.outputsLength > maxOutputs)
    throw new Error(
      `half-signed 0x${type.toString(16)} reveal must have 1${maxOutputs === 2 ? ' or 2' : ''} output(s) (got ${tx.outputsLength})`,
    );
  if ((tx.getInput(0).sequence ?? 0xffffffff) !== REVEAL_SEQUENCE) throw new Error('commit input nSequence mismatch');
  return type;
}

/**
 * Browser side. Builds the reveal in its "half-signed" form with the commit input at index 0.
 *
 *   sighash 'all_anyonecanpay' (0x81, default, ADR-0005):
 *     withParent: [commit] -> [parent return, child]   (needs parentReturnAddress + parentValue)
 *     no parent:  [commit] -> [child]
 *     The signature commits to every output. attachParent may only insert the parent input at
 *     index 0 (ANYONECANPAY omits input_index and the other inputs), so the digest is unchanged.
 *     Rescue = buildResignedRescue with the same K_e.
 *
 *   sighash 'single_anyonecanpay' (0x83, legacy, one release):
 *     [commit] -> [child]; attachParent inserts parent input AND parent return output at index 0.
 *     The half-signed PSBT doubles as the rescue tx (buildRescueReveal).
 *
 * `withParent` defaults to `content.parentId !== undefined`.
 */
export function buildHalfSignedReveal(args: {
  network: Network;
  revealPrivkey: Uint8Array;
  content: InscriptionContent;
  commitOutpoint: Outpoint;
  commitValue: bigint;
  recipientAddress: string;
  postage: bigint;
  sighash?: RevealSighashMode;
  withParent?: boolean;
  /** 0x81 + withParent: the collection address the parent returns to (output 0). */
  parentReturnAddress?: string;
  /** 0x81 + withParent: value of the parent UTXO == value of output 0 (child sat placement). */
  parentValue?: bigint;
}): { psbtBase64: string; signature: Uint8Array; sighashType: RevealSighashType } {
  assertBytes(args.revealPrivkey, 32, 'revealPrivkey');
  checkOutpoint(args.commitOutpoint, 'commitOutpoint');
  if (typeof args.postage !== 'bigint' || args.postage < LIMITS.DUST_P2TR)
    throw new Error(`postage must be a bigint >= ${LIMITS.DUST_P2TR}`);
  if (typeof args.commitValue !== 'bigint' || args.commitValue <= args.postage)
    throw new Error('commitValue must exceed postage (fee = commitValue - postage)');
  const sighashType = revealSighashType(args.sighash);
  const withParent = args.withParent ?? args.content.parentId !== undefined;

  const revealPubkey = schnorr.getPublicKey(args.revealPrivkey);
  const commit = commitAddress(revealPubkey, args.content, args.network);
  const recipientScript = addressToScript(args.recipientAddress, args.network);

  const outputs: SighashOutput[] = [];
  if (sighashType === SIGHASH_ALL_ANYONECANPAY && withParent) {
    if (typeof args.parentReturnAddress !== 'string')
      throw new Error('parentReturnAddress is required for sighash all_anyonecanpay with a parent');
    if (typeof args.parentValue !== 'bigint' || args.parentValue <= 0n)
      throw new Error('parentValue must be a positive bigint for sighash all_anyonecanpay with a parent');
    outputs.push({ script: addressToScript(args.parentReturnAddress, args.network), value: args.parentValue });
  }
  outputs.push({ script: recipientScript, value: args.postage });

  const tx = new Transaction(TX_OPTS);
  for (const o of outputs) tx.addOutput({ script: o.script, amount: o.value });
  tx.addInput({
    txid: args.commitOutpoint.txid,
    index: args.commitOutpoint.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: commit.script, amount: args.commitValue },
    tapInternalKey: NUMS_INTERNAL_KEY,
    tapLeafScript: [
      [
        { version: commit.controlBlock[0]!, internalKey: NUMS_INTERNAL_KEY, merklePath: [] },
        new Uint8Array([...commit.leafScript, TAPSCRIPT_LEAF_VERSION]),
      ],
    ],
    sighashType,
  });
  tx.signIdx(args.revealPrivkey, 0, [sighashType]);
  const signature = commitSignature(tx, 0);
  if (!signature || signature.length !== 65 || signature[64] !== sighashType)
    throw new Error('internal: commit input was not signed');

  // Defence in depth: the signature must verify against our independent BIP341 digest.
  const digest = revealCommitSighash({
    commitOutpoint: args.commitOutpoint,
    commitValue: args.commitValue,
    commitScript: commit.script,
    tapLeafHash: commit.tapLeafHash,
    sighashType,
    childScript: recipientScript,
    childValue: args.postage,
    outputs,
  });
  if (!schnorr.verify(signature.subarray(0, 64), digest, revealPubkey))
    throw new Error('internal: signature does not verify against independent sighash');

  return { psbtBase64: encodePsbt(tx), signature: Uint8Array.from(signature), sighashType };
}

/**
 * Service side. Returns [parent, commit] -> [parent return, child]. The parent return carries
 * exactly `parentValue`: ord puts the new inscription on the first sat of the commit input, i.e.
 * at offset `parentValue`, which must be the first sat of output 1 (the child).
 *
 *   0x83 half-signed ([commit] -> [child]): inserts the parent input and the parent return output.
 *   0x81 half-signed ([commit] -> [parent return, child]): inserts only the parent input; output 0
 *        must already be the parent return for this address and value (it is signed).
 */
export function attachParent(args: {
  network: Network;
  halfSignedPsbtBase64: string;
  parentOutpoint: Outpoint;
  parentValue: bigint;
  parentScript: Uint8Array;
  parentReturnAddress: string;
}): { psbtBase64: string } {
  checkOutpoint(args.parentOutpoint, 'parentOutpoint');
  assertBytes(args.parentScript, undefined, 'parentScript');
  if (!isP2TR(args.parentScript)) throw new Error('parentScript must be a P2TR scriptPubKey');
  if (typeof args.parentValue !== 'bigint' || args.parentValue <= 0n) throw new Error('parentValue must be a positive bigint');

  const half = decodePsbt(args.halfSignedPsbtBase64);
  const type = assertHalfSigned(half);
  const commitIn = half.getInput(0);
  if (
    inputTxid(half, 0) === args.parentOutpoint.txid.toLowerCase() &&
    commitIn.index === args.parentOutpoint.vout
  )
    throw new Error('parent outpoint equals commit outpoint');
  const parentReturnScript = addressToScript(args.parentReturnAddress, args.network);

  let outputs: SighashOutput[];
  if (type === SIGHASH_SINGLE_ANYONECANPAY) {
    outputs = [{ script: parentReturnScript, value: args.parentValue }, ...outputsOf(half)];
  } else {
    outputs = outputsOf(half);
    if (outputs.length !== 2)
      throw new Error('0x81 half-signed reveal was built without a parent return output (withParent=false); it cannot take a parent');
    const ret = outputs[0]!;
    if (!equalBytes(ret.script, parentReturnScript))
      throw new Error('0x81 half-signed reveal output 0 is not the parent return address (signed, cannot change)');
    if (ret.value !== args.parentValue)
      throw new Error(`0x81 half-signed reveal output 0 value ${ret.value} != parentValue ${args.parentValue} (signed, cannot change)`);
  }

  const tx = new Transaction(TX_OPTS);
  // Outputs first: once a signed input is present btc-signer (correctly) forbids adding outputs
  // its signature covers.
  for (const o of outputs) tx.addOutput({ script: o.script, amount: o.value });
  tx.addInput({
    txid: args.parentOutpoint.txid,
    index: args.parentOutpoint.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: args.parentScript, amount: args.parentValue },
  });
  tx.addInput(commitIn);
  return { psbtBase64: encodePsbt(tx) };
}

/**
 * Service/policy signer. Key-path (SIGHASH_DEFAULT, 64-byte sig) spend of input 0, whose
 * scriptPubKey must be the BIP86-style P2TR of `parentPrivkey` (tweaked, no script tree).
 */
export function signParentInput(psbtBase64: string, parentPrivkey: Uint8Array): { psbtBase64: string } {
  assertBytes(parentPrivkey, 32, 'parentPrivkey');
  const tx = decodePsbt(psbtBase64);
  if (tx.inputsLength !== 2 || tx.outputsLength !== 2) throw new Error('parent reveal must have 2 inputs and 2 outputs');
  const parentIn = tx.getInput(0);
  const prev = parentIn.witnessUtxo;
  if (!prev) throw new Error('parent input has no witnessUtxo');
  const out0 = tx.getOutput(0);
  if (out0.amount !== prev.amount)
    throw new Error('parent return value must equal parent input value (child sat placement)');
  const internal = schnorr.getPublicKey(parentPrivkey);
  if (!equalBytes(p2tr(internal).script, prev.script)) throw new Error('parentPrivkey does not control input 0');
  if (!commitSignature(tx, 1)) throw new Error('commit input (index 1) is not signed');
  tx.updateInput(0, { tapInternalKey: internal });
  tx.signIdx(parentPrivkey, 0);
  return { psbtBase64: encodePsbt(tx) };
}

function finalizeAll(tx: Transaction): void {
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const signed =
      !!inp.tapKeySig ||
      !!(inp.tapScriptSig && inp.tapScriptSig.length) ||
      !!(inp.finalScriptWitness && inp.finalScriptWitness.length);
    if (!signed) throw new Error(`input ${i} is unsigned`);
  }
  tx.finalize();
}

/** Finalize to raw hex. Throws if any input is unsigned. */
export function finalizeReveal(psbtBase64: string): { hex: string; txid: string; weight: number; vsize: number } {
  const tx = decodePsbt(psbtBase64);
  finalizeAll(tx);
  return rawFacts(tx);
}

/**
 * Self-rescue by replay: finalize the half-signed PSBT as-is, no parent. Works for 0x83 (always)
 * and for a 0x81 reveal built with `withParent: false`. A 0x81 reveal that pre-committed a parent
 * return output cannot be replayed without the parent (its fee would be wrong and the parent
 * return output would be unfunded): use buildResignedRescue with K_e instead.
 */
export function buildRescueReveal(args: { network: Network; halfSignedPsbtBase64: string }): {
  hex: string;
  txid: string;
  weight: number;
  vsize: number;
} {
  const tx = decodePsbt(args.halfSignedPsbtBase64);
  const type = assertHalfSigned(tx);
  networkParams(args.network); // validates the network name
  if (type === SIGHASH_ALL_ANYONECANPAY && tx.outputsLength !== 1)
    throw new Error('0x81 half-signed reveal commits to a parent return output; rescue with buildResignedRescue (K_e) instead');
  finalizeAll(tx);
  return rawFacts(tx);
}

/**
 * Self-rescue by re-signing (0x81 model, ADR-0005). The user holds K_e in their recovery bundle
 * and signs a fresh `[commit] -> [child]` with SIGHASH_DEFAULT: the child gets `postage`, the
 * remainder of `commitValue` is the fee (no change output). When `feeRate` is given the rescue is
 * refused if the fee falls below `ceil(vsize × feeRate)`, and `overpay` reports how many sats are
 * paid above that rate (the commit was funded for the heavier parent layout, so some overpay is
 * normal; a service-less user has no parent return to absorb it).
 */
export function buildResignedRescue(args: {
  network: Network;
  revealPrivkey: Uint8Array;
  content: InscriptionContent;
  commitOutpoint: Outpoint;
  commitValue: bigint;
  recipientAddress: string;
  postage: bigint;
  feeRate?: number;
}): { hex: string; txid: string; weight: number; vsize: number; fee: bigint; overpay?: bigint } {
  assertBytes(args.revealPrivkey, 32, 'revealPrivkey');
  checkOutpoint(args.commitOutpoint, 'commitOutpoint');
  if (typeof args.postage !== 'bigint' || args.postage < LIMITS.DUST_P2TR)
    throw new Error(`postage must be a bigint >= ${LIMITS.DUST_P2TR}`);
  if (typeof args.commitValue !== 'bigint' || args.commitValue <= args.postage)
    throw new Error('commitValue must exceed postage (fee = commitValue - postage)');

  const revealPubkey = schnorr.getPublicKey(args.revealPrivkey);
  const commit = commitAddress(revealPubkey, args.content, args.network);
  const recipientScript = addressToScript(args.recipientAddress, args.network);
  const fee = args.commitValue - args.postage;

  let overpay: bigint | undefined;
  if (args.feeRate !== undefined) {
    const weight = estimateResignedRescueWeight({ content: args.content, recipientScript });
    const required = quoteReveal({ revealWeight: weight, feeRate: args.feeRate, postage: 0n }).revealFee;
    if (fee < required) throw new Error(`commit funds ${fee} sat of fee; ${required} needed at ${args.feeRate} sat/vB`);
    overpay = fee - required;
  }

  const tx = new Transaction(TX_OPTS);
  tx.addOutput({ script: recipientScript, amount: args.postage });
  tx.addInput({
    txid: args.commitOutpoint.txid,
    index: args.commitOutpoint.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: commit.script, amount: args.commitValue },
    tapInternalKey: NUMS_INTERNAL_KEY,
    tapLeafScript: [
      [
        { version: commit.controlBlock[0]!, internalKey: NUMS_INTERNAL_KEY, merklePath: [] },
        new Uint8Array([...commit.leafScript, TAPSCRIPT_LEAF_VERSION]),
      ],
    ],
  });
  tx.signIdx(args.revealPrivkey, 0, [SIGHASH_DEFAULT]);
  const signature = commitSignature(tx, 0);
  if (!signature || signature.length !== 64) throw new Error('internal: commit input was not signed with SIGHASH_DEFAULT');
  const digest = revealCommitSighash({
    commitOutpoint: args.commitOutpoint,
    commitValue: args.commitValue,
    commitScript: commit.script,
    tapLeafHash: commit.tapLeafHash,
    sighashType: SIGHASH_DEFAULT,
    outputs: [{ script: recipientScript, value: args.postage }],
  });
  if (!schnorr.verify(signature, digest, revealPubkey))
    throw new Error('internal: signature does not verify against independent sighash');

  finalizeAll(tx);
  const facts = rawFacts(tx);
  return overpay === undefined ? { ...facts, fee } : { ...facts, fee, overpay };
}
