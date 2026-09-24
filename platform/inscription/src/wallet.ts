/**
 * "Just PSBTs" inscriptions: the reveal is signed by the USER'S WALLET, not by an ephemeral key.
 *
 * The commit output is P2TR(NUMS internal key, single leaf) exactly as in the K_e model
 * (`commitAddress`), but the leaf's OP_CHECKSIG key is a key the wallet controls: either its
 * untweaked internal x-only key (`LeafKeyKind = 'internal'`) or its tweaked taproot output key —
 * the 32-byte program of its bc1p address (`'output'`). The reveal PSBT carries everything a
 * tapscript-capable wallet needs (witnessUtxo, tapInternalKey = NUMS, tapLeafScript,
 * tapMerkleRoot, sighashType), the wallet signs the script path, and this module turns its
 * answer into the raw transaction or refuses it with a precise reason.
 *
 * Why NUMS + the signer's own key: XCP Wallet's inscription gate demands both (the commit cannot
 * be key-path spent by anyone; the committed coins are spendable by the signer alone), and every
 * other wallet is at least as happy with it. Because the leaf names the user's key, a reveal that
 * never broadcast can be rebuilt (`buildUnsignedRescuePsbt`) and re-signed at any time: no
 * recovery bundle, nothing to keep but the order parameters.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { assertBytes, equalBytes } from './bytes.js';
import { addressToScript, commitAddress, NUMS_INTERNAL_KEY, type CommitInfo } from './commit.js';
import {
  LIMITS,
  REVEAL_LOCKTIME,
  REVEAL_SEQUENCE,
  REVEAL_TX_VERSION,
  SIGHASH_ALL,
  SIGHASH_ALL_ANYONECANPAY,
  SIGHASH_DEFAULT,
  TAPSCRIPT_LEAF_VERSION,
} from './constants.js';
import type { InscriptionContent } from './envelope.js';
import { controlBlockStruct, extractLeafSignature, leafKeyOf, singleLeafOf, type LeafSignature } from './leaf.js';
import type { Network } from './network.js';
import { decodePsbt, encodePsbt, inputTxid, rawFacts, TX_OPTS } from './psbt.js';
import { type Outpoint } from './reveal.js';
import { revealCommitSighash, type SighashOutput } from './sighash.js';
import { estimateRevealWeight, quoteReveal } from './sizing.js';
import type { VerifyResult } from './verify.js';

/**
 * Which wallet key sits in the leaf's OP_CHECKSIG.
 *   'internal': the untweaked x-only key (the `publicKey` wallets report for a p2tr account, x-only);
 *               the wallet must sign with the raw key (UniSat/OKX `disableTweakSigner: true`).
 *   'output':   the tweaked taproot output key, i.e. the 32-byte witness program of the bc1p address;
 *               the wallet signs with the tweaked private key (its default for p2tr inputs; XCP Wallet).
 */
export type LeafKeyKind = 'internal' | 'output';

/**
 * Sighash the wallet is asked to use on the commit input.
 *   'default'          0x00, 64-byte signature. No parent (the tx is complete as built).
 *   'all'              0x01, 65-byte signature, same digest as 'default'. For wallets that refuse 0x00 (XCP Wallet).
 *   'all_anyonecanpay' 0x81, 65-byte signature. Required with a parent: the service inserts the parent input.
 */
export type WalletRevealSighash = 'default' | 'all' | 'all_anyonecanpay';

export function walletRevealSighashType(mode: WalletRevealSighash): number {
  switch (mode) {
    case 'default':
      return SIGHASH_DEFAULT;
    case 'all':
      return SIGHASH_ALL;
    case 'all_anyonecanpay':
      return SIGHASH_ALL_ANYONECANPAY;
    default:
      throw new Error(`unknown wallet reveal sighash: ${String(mode)}`);
  }
}

function checkOutpoint(o: Outpoint, name: string): void {
  if (!o || typeof o.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(o.txid)) throw new Error(`${name}.txid invalid`);
  if (!Number.isSafeInteger(o.vout) || o.vout < 0 || o.vout > 0xffffffff) throw new Error(`${name}.vout invalid`);
}

function checkAmounts(postage: bigint, commitValue: bigint): void {
  if (typeof postage !== 'bigint' || postage < LIMITS.DUST_P2TR) throw new Error(`postage must be a bigint >= ${LIMITS.DUST_P2TR}`);
  if (typeof commitValue !== 'bigint' || commitValue <= postage) throw new Error('commitValue must exceed postage (fee = commitValue - postage)');
}

function addCommitInput(
  tx: Transaction,
  commit: CommitInfo,
  commitOutpoint: Outpoint,
  commitValue: bigint,
  sighashType: number,
): void {
  tx.addInput({
    txid: commitOutpoint.txid,
    index: commitOutpoint.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: commit.script, amount: commitValue },
    tapInternalKey: NUMS_INTERNAL_KEY,
    // Single leaf: merkle root == leaf hash. Lets a wallet re-derive the commit scriptPubKey from
    // (NUMS, root) and compare it with witnessUtxo before signing.
    tapMerkleRoot: commit.tapLeafHash,
    tapLeafScript: [[controlBlockStruct(commit.controlBlock), new Uint8Array([...commit.leafScript, TAPSCRIPT_LEAF_VERSION])]],
    // PSBT_IN_SIGHASH_TYPE is omitted for SIGHASH_DEFAULT (absent == DEFAULT for taproot inputs;
    // some wallets reject an explicit 0).
    ...(sighashType === SIGHASH_DEFAULT ? {} : { sighashType }),
  });
}

/**
 * Build the reveal for the wallet to sign. Commit input at `inputIndex` (0), outputs
 * `[parent return, child]` when `withParent` (sighash must be 'all_anyonecanpay'; the service
 * attaches the parent input with `attachParent` after `verifyWalletSignedReveal`), else `[child]`.
 *
 * `leafPubkey` is the wallet key that will sign (see LeafKeyKind). `commitAddress` in the result
 * is the address the user must fund with exactly `commitValue`; it equals
 * `commitAddress(leafPubkey, content, network).address`.
 */
export function buildUnsignedRevealPsbt(args: {
  network: Network;
  leafPubkey: Uint8Array;
  content: InscriptionContent;
  commitOutpoint: Outpoint;
  commitValue: bigint;
  recipientAddress: string;
  postage: bigint;
  withParent?: boolean;
  parentReturnAddress?: string;
  parentValue?: bigint;
  sighash?: WalletRevealSighash;
}): {
  psbtBase64: string;
  inputIndex: number;
  leafScript: Uint8Array;
  controlBlock: Uint8Array;
  tapLeafHash: Uint8Array;
  commitAddress: string;
  sighashType: number;
} {
  assertBytes(args.leafPubkey, 32, 'leafPubkey');
  checkOutpoint(args.commitOutpoint, 'commitOutpoint');
  checkAmounts(args.postage, args.commitValue);
  const withParent = args.withParent ?? args.content.parentId !== undefined;
  const sighash: WalletRevealSighash = args.sighash ?? (withParent ? 'all_anyonecanpay' : 'default');
  if (withParent && sighash !== 'all_anyonecanpay') {
    throw new Error(`sighash '${sighash}' cannot take a parent: the service could not insert the parent input; use 'all_anyonecanpay'`);
  }
  const sighashType = walletRevealSighashType(sighash);

  const commit = commitAddress(args.leafPubkey, args.content, args.network);
  const recipientScript = addressToScript(args.recipientAddress, args.network);
  const outputs: SighashOutput[] = [];
  if (withParent) {
    if (typeof args.parentReturnAddress !== 'string') throw new Error('parentReturnAddress is required with a parent');
    if (typeof args.parentValue !== 'bigint' || args.parentValue <= 0n) throw new Error('parentValue must be a positive bigint with a parent');
    outputs.push({ script: addressToScript(args.parentReturnAddress, args.network), value: args.parentValue });
  }
  outputs.push({ script: recipientScript, value: args.postage });

  const tx = new Transaction(TX_OPTS);
  for (const o of outputs) tx.addOutput({ script: o.script, amount: o.value });
  addCommitInput(tx, commit, args.commitOutpoint, args.commitValue, sighashType);

  return {
    psbtBase64: encodePsbt(tx),
    inputIndex: 0,
    leafScript: commit.leafScript,
    controlBlock: commit.controlBlock,
    tapLeafHash: commit.tapLeafHash,
    commitAddress: commit.address,
    sighashType,
  };
}

/**
 * Self-rescue without a parent: `[commit] -> [child]`, child gets `postage`, the rest of
 * `commitValue` is the fee. The wallet re-signs it at any time (the leaf names its own key), so
 * nothing needs to be kept but the order parameters. With `feeRate`, refuses a commit that would
 * pay less than `ceil(vsize × feeRate)`.
 */
export function buildUnsignedRescuePsbt(args: {
  network: Network;
  leafPubkey: Uint8Array;
  content: InscriptionContent;
  commitOutpoint: Outpoint;
  commitValue: bigint;
  recipientAddress: string;
  postage: bigint;
  feeRate?: number;
  /** Default 'default' (0x00). 'all' (0x01) for wallets that refuse SIGHASH_DEFAULT. */
  sighash?: 'default' | 'all';
}): { psbtBase64: string; inputIndex: number; commitAddress: string; fee: bigint; sighashType: number } {
  assertBytes(args.leafPubkey, 32, 'leafPubkey');
  checkOutpoint(args.commitOutpoint, 'commitOutpoint');
  checkAmounts(args.postage, args.commitValue);
  const sighash = args.sighash ?? 'default';
  if (sighash !== 'default' && sighash !== 'all') throw new Error(`rescue sighash must be 'default' or 'all', got ${String(sighash)}`);
  const sighashType = walletRevealSighashType(sighash);
  const commit = commitAddress(args.leafPubkey, args.content, args.network);
  const recipientScript = addressToScript(args.recipientAddress, args.network);
  const fee = args.commitValue - args.postage;
  if (args.feeRate !== undefined) {
    const weight = estimateRevealWeight({ content: args.content, withParent: false, recipientScript, commitSighash: sighash });
    const required = quoteReveal({ revealWeight: weight, feeRate: args.feeRate, postage: 0n }).revealFee;
    if (fee < required) throw new Error(`commit funds ${fee} sat of fee; ${required} needed at ${args.feeRate} sat/vB`);
  }
  const tx = new Transaction(TX_OPTS);
  tx.addOutput({ script: recipientScript, amount: args.postage });
  addCommitInput(tx, commit, args.commitOutpoint, args.commitValue, sighashType);
  return { psbtBase64: encodePsbt(tx), inputIndex: 0, commitAddress: commit.address, fee, sighashType };
}

/** Schnorr-verify a leaf signature against btc-signer's BIP341 digest for this transaction. */
function assertLeafSignatureValid(tx: Transaction, idx: number, ls: LeafSignature): void {
  const scripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const prev = tx.getInput(i).witnessUtxo;
    if (!prev) throw new Error(`input ${i} has no witnessUtxo`);
    scripts.push(prev.script);
    amounts.push(prev.amount);
  }
  const digest = tx.preimageWitnessV1(idx, scripts, ls.sighashType, amounts, undefined, ls.leafScript, TAPSCRIPT_LEAF_VERSION);
  if (!schnorr.verify(ls.sig.subarray(0, 64), digest, ls.pubKey)) {
    throw new Error(
      `input ${idx}: signature does not verify for leaf key ${hex.encode(ls.pubKey)} ` +
        `with hash type 0x${ls.sighashType.toString(16)} (wrong key, wrong sighash, or the transaction changed after signing)`,
    );
  }
}

/**
 * Turn a wallet-signed reveal PSBT into the raw transaction. Accepts, per input, a tapscript
 * signature for the input's single leaf (PSBT_IN_TAP_SCRIPT_SIG), a finalized witness
 * `[sig, leafScript, controlBlock]`, or (parent input) a key-path signature. Every leaf signature
 * is Schnorr-verified over the BIP341 digest before the witness is assembled, so a wallet that
 * signed with the wrong key or for another leaf is refused with the reason, never broadcast.
 */
export function finalizeWalletSignedReveal(psbtBase64: string): { hex: string; txid: string; weight: number; vsize: number } {
  const tx = decodePsbt(psbtBase64);
  if (tx.inputsLength < 1) throw new Error('reveal has no inputs');
  if (tx.version !== REVEAL_TX_VERSION || tx.lockTime !== REVEAL_LOCKTIME) throw new Error('reveal must have nVersion=2 and nLockTime=0');
  for (let idx = 0; idx < tx.inputsLength; idx++) {
    const input = tx.getInput(idx);
    const w = input.finalScriptWitness;
    if (w && w.length) {
      if (w.length === 1) continue; // key-path (parent) already finalized
      assertLeafSignatureValid(tx, idx, extractLeafSignature(tx, idx));
      continue;
    }
    if (input.tapLeafScript && input.tapLeafScript.length) {
      const ls = extractLeafSignature(tx, idx);
      assertLeafSignatureValid(tx, idx, ls);
      tx.updateInput(idx, { finalScriptWitness: [ls.sig, ls.leafScript, ls.controlBlock] }, true);
      continue;
    }
    if (input.tapKeySig) {
      tx.finalizeIdx(idx);
      continue;
    }
    throw new Error(`input ${idx} is unsigned`);
  }
  return rawFacts(tx);
}

/**
 * Service side: everything the wallet's signature commits to is recomputed from the order's
 * expected values; nothing is trusted from the PSBT but the signature. Accepts the unfinalized
 * (tapScriptSig) and finalized (witness) shapes.
 *
 * Sighash: with `expectedParentReturnAddress` the signature must be 0x81; without a parent it
 * may be 0x00, 0x01 or 0x81 unless `expectedSighash` pins one.
 */
export function verifyWalletSignedReveal(args: {
  network: Network;
  psbtBase64: string;
  leafPubkey: Uint8Array;
  content: InscriptionContent;
  expectedCommitOutpoint: Outpoint;
  expectedCommitValue: bigint;
  expectedRecipientAddress: string;
  expectedPostage: bigint;
  expectedParentReturnAddress?: string;
  expectedParentValue?: bigint;
  expectedSighash?: WalletRevealSighash;
}): VerifyResult {
  const fail = (reason: string): VerifyResult => ({ ok: false, reason });
  try {
    assertBytes(args.leafPubkey, 32, 'leafPubkey');
    if (args.expectedPostage < LIMITS.DUST_P2TR) return fail(`expected postage below dust (${LIMITS.DUST_P2TR})`);
    if (args.expectedCommitValue <= args.expectedPostage) return fail('commit value does not exceed postage');
    const expectParent = args.expectedParentReturnAddress !== undefined;
    if (expectParent && (typeof args.expectedParentValue !== 'bigint' || args.expectedParentValue <= 0n))
      return fail('expectedParentValue must be a positive bigint when expectedParentReturnAddress is given');
    if (expectParent && args.expectedSighash !== undefined && args.expectedSighash !== 'all_anyonecanpay')
      return fail("a reveal with a parent must be signed 'all_anyonecanpay'");
    const allowedTypes = expectParent
      ? [SIGHASH_ALL_ANYONECANPAY]
      : args.expectedSighash !== undefined
        ? [walletRevealSighashType(args.expectedSighash)]
        : [SIGHASH_DEFAULT, SIGHASH_ALL, SIGHASH_ALL_ANYONECANPAY];
    const expectedOutputs = expectParent ? 2 : 1;

    let tx: Transaction;
    try {
      tx = decodePsbt(args.psbtBase64);
    } catch (e) {
      return fail(`PSBT does not decode: ${(e as Error).message}`);
    }
    if (tx.inputsLength !== 1) return fail(`expected 1 input, got ${tx.inputsLength}`);
    if (tx.outputsLength !== expectedOutputs) return fail(`expected ${expectedOutputs} output(s), got ${tx.outputsLength}`);
    if (tx.version !== REVEAL_TX_VERSION) return fail(`nVersion must be ${REVEAL_TX_VERSION}`);
    if (tx.lockTime !== REVEAL_LOCKTIME) return fail(`nLockTime must be ${REVEAL_LOCKTIME}`);

    const input = tx.getInput(0);
    const exp = args.expectedCommitOutpoint;
    if (inputTxid(tx, 0) !== exp.txid.toLowerCase() || input.index !== exp.vout) return fail('commit outpoint mismatch');
    if ((input.sequence ?? 0xffffffff) !== REVEAL_SEQUENCE) return fail('commit input nSequence mismatch');

    const commit = commitAddress(args.leafPubkey, args.content, args.network);
    const prev = input.witnessUtxo;
    if (!prev) return fail('commit input has no witnessUtxo');
    if (prev.amount !== args.expectedCommitValue) return fail('commit value mismatch');
    if (!equalBytes(prev.script, commit.script)) return fail('commit scriptPubKey mismatch (content, key or network)');

    // Unfinalized shape: the leaf fields must be exactly ours.
    if (input.tapLeafScript && input.tapLeafScript.length) {
      let leaf;
      try {
        leaf = singleLeafOf(tx, 0);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (!equalBytes(leaf.leafScript, commit.leafScript)) return fail('leaf script does not match the inscription script for this content');
      if (!equalBytes(leaf.controlBlock, commit.controlBlock)) return fail('control block mismatch');
      if (input.tapInternalKey && !equalBytes(input.tapInternalKey, NUMS_INTERNAL_KEY)) return fail('tapInternalKey is not NUMS');
      if (input.tapMerkleRoot && !equalBytes(input.tapMerkleRoot, commit.tapLeafHash)) return fail('tapMerkleRoot mismatch');
    }

    // Outputs, from the expected values.
    let recipientScript: Uint8Array;
    try {
      recipientScript = addressToScript(args.expectedRecipientAddress, args.network);
    } catch (e) {
      return fail(`expected recipient address invalid: ${(e as Error).message}`);
    }
    const outputs: SighashOutput[] = [];
    if (expectParent) {
      let parentReturnScript: Uint8Array;
      try {
        parentReturnScript = addressToScript(args.expectedParentReturnAddress!, args.network);
      } catch (e) {
        return fail(`expected parent return address invalid: ${(e as Error).message}`);
      }
      const ret = tx.getOutput(0);
      if (!ret.script || !equalBytes(ret.script, parentReturnScript)) return fail('parent return output address mismatch');
      if (ret.amount !== args.expectedParentValue) return fail('parent return output value mismatch');
      outputs.push({ script: parentReturnScript, value: args.expectedParentValue! });
    }
    const child = tx.getOutput(expectedOutputs - 1);
    if (!child.script || !equalBytes(child.script, recipientScript)) return fail('child output recipient mismatch');
    if (child.amount !== args.expectedPostage) return fail('child output postage mismatch');
    outputs.push({ script: recipientScript, value: args.expectedPostage });

    // Signature.
    let ls: LeafSignature;
    try {
      ls = extractLeafSignature(tx, 0, {
        leafScript: commit.leafScript,
        controlBlock: commit.controlBlock,
        leafHash: commit.tapLeafHash,
        leafPubkey: args.leafPubkey,
      });
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!allowedTypes.includes(ls.sighashType)) {
      return fail(
        `sighash type must be ${allowedTypes.map((t) => `0x${t.toString(16)}`).join(' or ')}, got 0x${ls.sighashType.toString(16)}`,
      );
    }
    if (input.sighashType !== undefined && input.sighashType !== ls.sighashType)
      return fail(`PSBT sighashType 0x${input.sighashType.toString(16)} does not match the signature's 0x${ls.sighashType.toString(16)}`);
    const digest = revealCommitSighash({
      commitOutpoint: exp,
      commitValue: args.expectedCommitValue,
      commitScript: commit.script,
      tapLeafHash: commit.tapLeafHash,
      sighashType: ls.sighashType,
      outputs,
    });
    if (!schnorr.verify(ls.sig.subarray(0, 64), digest, args.leafPubkey)) return fail('schnorr signature does not verify for the leaf key');
    return { ok: true };
  } catch (e) {
    return fail(`verification error: ${(e as Error).message}`);
  }
}

/** The leaf key of a built reveal PSBT's commit input (what `buildUnsignedRevealPsbt` put there). */
export function leafKeyOfPsbt(psbtBase64: string, inputIndex = 0): Uint8Array {
  const tx = decodePsbt(psbtBase64);
  return Uint8Array.from(leafKeyOf(singleLeafOf(tx, inputIndex).leafScript));
}
