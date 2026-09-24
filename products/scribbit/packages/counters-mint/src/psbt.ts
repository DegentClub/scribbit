/**
 * Transaction surgery on Counterparty's composed commit/reveal pair.
 *
 * Ported from counters.fun `apps/web/src/lib/inscribe/psbt.ts`, where every one
 * of these safeguards was learned expensively. The logic is asset-shape
 * agnostic — it operates on whatever `compose/*` returned — so it serves a
 * counter, a reinscription and a fairminter deploy alike.
 *
 * PSBTs are exchanged as base64 (BIP174's interchange form; counters.fun used
 * hex because its wallets did).
 */

import { base64 } from '@scure/base';
import { RawTx, SigHash, Transaction } from '@scure/btc-signer';
import { bytesToHex, compactSizeLen, equalBytes, hexToBytes } from './bytes.js';
import { type ComposeResult, requireTaprootCompose } from './compose.js';
import { type CommitEnvelope, LEAF_VERSION, NUMS_INTERNAL_KEY, commitEnvelope, coreCommitScript, reKeyEnvelope } from './envelope.js';
import { addressToScript, type Network } from './network.js';

/** Counterparty's dust threshold for the outputs it composes. */
export const REGULAR_DUST = 546;
/** The segwit dust floor Core applies to the commit output. */
export const SEGWIT_DUST = 330;

const TX_OPTS = Object.freeze({ allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
const RAW_OPTS = Object.freeze({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });

export interface Outpoint {
  txid: string;
  vout: number;
}

/** A coin the wallet offers to fund the commit with. */
export interface Utxo {
  txid: string;
  vout: number;
  /** Satoshis. */
  value: number;
  /** scriptPubKey, hex. Needed for `witnessUtxo`; a wallet's UTXO listing has it. */
  scriptPubKey: string;
  /** Optional x-only internal key of a P2TR coin, for wallets that want it in the PSBT. */
  tapInternalKey?: string;
}

export type RevealSighash = 'default' | 'all';

function decodePsbt(psbtBase64: string): Transaction {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(psbtBase64);
  } catch {
    throw new Error('PSBT is not valid base64');
  }
  return Transaction.fromPSBT(bytes, TX_OPTS);
}

function encodePsbt(tx: Transaction): string {
  return base64.encode(tx.toPSBT());
}

/* -------------------------------------------------------------------- */
/* Reading Core's pair                                                  */
/* -------------------------------------------------------------------- */

/** Core's commit output (index and value), found by the address Core's own leaf derives to. */
export function coreCommitOutput(compose: ComposeResult): { index: number; value: number } {
  const c = requireTaprootCompose(compose);
  const core = RawTx.decode(hexToBytes(c.rawtransaction));
  const script = coreCommitScript(hexToBytes(c.envelope_script));
  let index = -1;
  core.outputs.forEach((o, i) => {
    if (!equalBytes(o.script, script)) return;
    if (index !== -1) throw new Error('Core composed more than one commit output');
    index = i;
  });
  if (index === -1) throw new Error('Could not find the commit output in the composed transaction. Nothing was signed.');
  return { index, value: Number(core.outputs[index]!.amount) };
}

/** What Core's reveal pays out (0 native, 546 ord) — everything above it in the commit is fee. */
export function revealOutputTotal(compose: ComposeResult): number {
  const c = requireTaprootCompose(compose);
  return RawTx.decode(hexToBytes(c.signed_reveal_rawtransaction)).outputs.reduce((sum, o) => sum + Number(o.amount), 0);
}

/**
 * The reveal's weight, known before anything is signed.
 *
 * Core's `signed_reveal_rawtransaction` is a complete reveal with its own
 * (discarded) key's signature, and the re-keyed reveal has the same shape —
 * only the 32-byte key inside the leaf changes, never the length. The one
 * byte of difference is the sighash flag: Core signs SIGHASH_DEFAULT (64-byte
 * signature); a SIGHASH_ALL reveal carries 65. Exact, not an estimate.
 */
export function revealWeightOf(compose: ComposeResult, sighash: RevealSighash = 'all'): number {
  const c = requireTaprootCompose(compose);
  const tx = Transaction.fromRaw(hexToBytes(c.signed_reveal_rawtransaction), RAW_OPTS);
  return tx.weight + (sighash === 'all' ? 1 : 0);
}

/**
 * How many more satoshis the commit needs than Core funded.
 *
 * Core signs its own reveal with SIGHASH_DEFAULT, whose schnorr signature is 64
 * bytes. A SIGHASH_ALL reveal (what browser wallets produce, and what this
 * engine signs by default so a wallet-signed reveal costs the same) carries a
 * trailing flag byte and is 65. That one witness byte is not in Core's
 * arithmetic, and a reveal paying under the rate it claimed can sit
 * unconfirmed indefinitely.
 *
 * Reads Core's OWN leaf from the compose rather than taking one as an
 * argument: locating the funded output derives an address from the leaf's
 * trailing key, so a re-keyed leaf would find nothing, read `funded` as 0 and
 * return the entire commit value as a "top-up" — silently doubling the mint.
 */
export function commitTopUp(compose: ComposeResult, feeRate: number): number {
  if (!(feeRate > 0) || !Number.isFinite(feeRate)) throw new Error('fee rate must be a positive number');
  const outputsValue = revealOutputTotal(compose);
  const vsize = Math.ceil(revealWeightOf(compose, 'all') / 4);
  // `ceil` on both sides: a fractional rate never rounds the reveal below the
  // rate it claimed. It may round a satoshi above; that is the cheap side.
  const needed = outputsValue + Math.ceil(vsize * feeRate);
  const funded = coreCommitOutput(compose).value;
  // Never a reduction: underpaying strands the commit, overpaying costs a few satoshis.
  return Math.max(0, needed - funded);
}

/* -------------------------------------------------------------------- */
/* Commit                                                               */
/* -------------------------------------------------------------------- */

export interface CommitPsbtArgs {
  network: Network;
  compose: ComposeResult;
  /** x-only public key the leaf is re-keyed to (`xOnlyPubkey(newRevealKey())`). */
  leafKey32: Uint8Array;
  /**
   * Coins to fund the commit with. Empty → Core's own inputs and change are
   * reused (the compose already selected and priced them), with the top-up
   * moved from Core's change into the commit so the miner fee is unchanged.
   */
  utxos: Utxo[];
  changeAddress: string;
  /** sat/vB for the commit when funded from `utxos`; ignored when Core's inputs are reused. */
  feeRate: number;
  /** Extra satoshis into the commit on top of Core's value — normally `commitTopUp(compose, feeRate)`. */
  topUpSats?: number;
}

export interface CommitPsbt {
  psbtBase64: string;
  /** Satoshis in the commit output: Core's value plus the top-up. */
  commitValue: number;
  /** Index of the commit output in the commit transaction. */
  commitVout: number;
  /** Input indexes the wallet must sign (all of them). */
  inputsToSign: number[];
  /** The re-keyed leaf's commit output. */
  commit: CommitEnvelope;
  /** Commit fee in satoshis (Core's when its inputs are reused). */
  fee: number;
}

/** Weight units one input of this scriptPubKey adds, with a fully-signed witness (upper bound for ECDSA). */
function inputWeight(script: Uint8Array): number {
  const base = 41 * 4; // outpoint + empty scriptSig + sequence
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return base + 1 + 1 + 64; // P2TR key path
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return base + 1 + 1 + 72 + 1 + 33; // P2WPKH
  if (script.length === 23 && script[0] === 0xa9) return base + 23 * 4 + 1 + 1 + 72 + 1 + 33; // P2SH-P2WPKH
  throw new Error('only P2TR, P2WPKH and P2SH-P2WPKH coins can fund a commit (Core refuses legacy inputs for reveals)');
}

function outputWeight(script: Uint8Array): number {
  return (8 + compactSizeLen(script.length) + script.length) * 4;
}

/**
 * Build the commit PSBT: Core's commit with its output redirected to the
 * re-keyed leaf's address.
 *
 * With `utxos`, the commit is funded from the caller's coins: largest-first
 * selection, change to `changeAddress`, fee `ceil(vsize × feeRate)`. Without
 * them, Core's inputs, change and fee are reused untouched and `topUpSats`
 * moves satoshis from Core's change into the commit.
 */
export function buildCommitPsbt(args: CommitPsbtArgs): CommitPsbt {
  const compose = requireTaprootCompose(args.compose);
  const topUp = args.topUpSats ?? 0;
  if (!Number.isInteger(topUp) || topUp < 0) throw new Error('topUpSats must be a non-negative integer');
  const leaf = reKeyEnvelope(hexToBytes(compose.envelope_script), args.leafKey32);
  const commit = commitEnvelope(leaf, args.network);
  const { index: coreIndex, value: coreValue } = coreCommitOutput(compose);
  const commitValue = coreValue + topUp;
  const core = RawTx.decode(hexToBytes(compose.rawtransaction));

  if (args.utxos.length === 0) {
    // counters.fun path: Core's arithmetic untouched, top-up out of Core's change.
    const tx = new Transaction({ allowUnknownOutputs: true, version: core.version, lockTime: core.lockTime });
    core.inputs.forEach((input, i) => {
      const script = compose.lock_scripts?.[i];
      const value = compose.inputs_values?.[i];
      if (script === undefined || value === undefined) {
        throw new Error(`Core returned no prevout for input ${i}, so the commit cannot be signed safely (compose with verbose=true).`);
      }
      tx.addInput({
        txid: input.txid,
        index: input.index,
        sequence: input.sequence,
        witnessUtxo: { script: hexToBytes(script), amount: BigInt(value) },
        sighashType: SigHash.ALL,
      });
    });
    let changeIndex = -1;
    if (topUp > 0) {
      for (let i = core.outputs.length - 1; i >= 0; i--) if (i !== coreIndex) { changeIndex = i; break; }
      if (changeIndex === -1) throw new Error('This envelope needs more in the commit than Core funded, and there is no change output.');
    }
    core.outputs.forEach((output, i) => {
      if (i === coreIndex) {
        tx.addOutput({ script: commit.script, amount: BigInt(commitValue) });
      } else if (i === changeIndex) {
        const change = Number(output.amount) - topUp;
        if (change < REGULAR_DUST) throw new Error('Topping up the commit would push the change below dust.');
        tx.addOutput({ script: output.script, amount: BigInt(change) });
      } else {
        tx.addOutput({ script: output.script, amount: output.amount });
      }
    });
    return {
      psbtBase64: encodePsbt(tx),
      commitValue,
      commitVout: coreIndex,
      inputsToSign: core.inputs.map((_, i) => i),
      commit,
      fee: compose.btc_fee ?? 0,
    };
  }

  if (!(args.feeRate > 0) || !Number.isFinite(args.feeRate)) throw new Error('fee rate must be a positive number');
  const changeScript = addressToScript(args.changeAddress, args.network);
  const sorted = [...args.utxos].sort((a, b) => b.value - a.value);
  const tx = new Transaction({ allowUnknownOutputs: true, version: 2, lockTime: 0 });
  tx.addOutput({ script: commit.script, amount: BigInt(commitValue) });

  let weight = (4 + 1 + 1 + 4) * 4 + 2 + outputWeight(commit.script) + outputWeight(changeScript);
  let funded = 0;
  const chosen: Utxo[] = [];
  let fee = 0;
  for (const utxo of sorted) {
    const script = hexToBytes(utxo.scriptPubKey);
    chosen.push(utxo);
    funded += utxo.value;
    weight += inputWeight(script);
    fee = Math.ceil(Math.ceil(weight / 4) * args.feeRate);
    if (funded >= commitValue + fee) break;
  }
  if (funded < commitValue + fee) {
    throw new Error(`Insufficient funds: the commit needs ${commitValue + fee} sat (${commitValue} commit + ${fee} fee), coins hold ${funded}.`);
  }
  for (const utxo of chosen) {
    const script = hexToBytes(utxo.scriptPubKey);
    tx.addInput({
      txid: hexToBytes(utxo.txid),
      index: utxo.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script, amount: BigInt(utxo.value) },
      ...(utxo.tapInternalKey ? { tapInternalKey: hexToBytes(utxo.tapInternalKey) } : {}),
      sighashType: SigHash.ALL,
    });
  }
  const change = funded - commitValue - fee;
  if (change >= REGULAR_DUST) tx.addOutput({ script: changeScript, amount: BigInt(change) });
  else fee += change; // below dust: the remainder goes to the miner
  return { psbtBase64: encodePsbt(tx), commitValue, commitVout: 0, inputsToSign: chosen.map((_, i) => i), commit, fee };
}

/* -------------------------------------------------------------------- */
/* Reveal                                                               */
/* -------------------------------------------------------------------- */

export interface RevealPsbtArgs {
  network: Network;
  compose: ComposeResult;
  /** The same x-only key the commit was built with. */
  leafKey32: Uint8Array;
  commitOutpoint: Outpoint;
  commitValue: number;
  /**
   * Where the ord wrapper's 546-sat output goes (Core sends it to the source's
   * change address). Ignored for the native envelope, whose only output is the
   * OP_RETURN marker. Must be the same script type as Core's so the commit
   * still funds the reveal.
   */
  destinationAddress: string;
  /** `'all'` (default; 65-byte signature, what `commitTopUp` funds) or `'default'` (64-byte, Core's own arithmetic). */
  sighash?: RevealSighash;
}

/**
 * Build the reveal PSBT: spend the commit through the re-keyed leaf,
 * reproducing Core's outputs.
 *
 * Core's own reveal is discarded — its witness is signed by a key nobody has
 * any more — but its OUTPUTS are consensus-relevant and are copied verbatim:
 * the OP_RETURN holding only the literal `CNTRPRTY` marker is what makes the
 * reveal a counter (build reference v3 §4).
 */
export function buildRevealPsbt(args: RevealPsbtArgs): { psbtBase64: string; inputIndex: number; commit: CommitEnvelope } {
  const compose = requireTaprootCompose(args.compose);
  if (!/^[0-9a-fA-F]{64}$/.test(args.commitOutpoint.txid)) throw new Error('commitOutpoint.txid must be a 64-hex txid');
  if (!Number.isInteger(args.commitValue) || args.commitValue <= 0) throw new Error('commitValue must be a positive integer');
  const leaf = reKeyEnvelope(hexToBytes(compose.envelope_script), args.leafKey32);
  const commit = commitEnvelope(leaf, args.network);
  const coreReveal = RawTx.decode(hexToBytes(compose.signed_reveal_rawtransaction));
  const sighashType = (args.sighash ?? 'all') === 'all' ? SigHash.ALL : SigHash.DEFAULT;

  const tx = new Transaction({ allowUnknownOutputs: true, version: coreReveal.version, lockTime: coreReveal.lockTime });
  tx.addInput({
    // NOT reversed: btc-signer takes a txid in display order and serialises it itself.
    txid: hexToBytes(args.commitOutpoint.txid),
    index: args.commitOutpoint.vout,
    sequence: coreReveal.inputs[0]?.sequence,
    witnessUtxo: { script: commit.script, amount: BigInt(args.commitValue) },
    tapInternalKey: NUMS_INTERNAL_KEY,
    tapLeafScript: [[{ version: commit.controlBlock[0]!, internalKey: NUMS_INTERNAL_KEY, merklePath: [] }, new Uint8Array([...leaf, LEAF_VERSION])]],
    sighashType,
  });

  const destination = addressToScript(args.destinationAddress, args.network);
  for (const output of coreReveal.outputs) {
    if (output.amount > 0n && output.script[0] !== 0x6a) {
      if (destination.length !== output.script.length) {
        throw new Error('destinationAddress must be the same script type as the address Core composed the reveal output to.');
      }
      tx.addOutput({ script: destination, amount: output.amount });
    } else {
      tx.addOutput({ script: output.script, amount: output.amount });
    }
  }
  return { psbtBase64: encodePsbt(tx), inputIndex: 0, commit };
}

/* -------------------------------------------------------------------- */
/* Plain transactions, signing, finalizing                              */
/* -------------------------------------------------------------------- */

/**
 * A PSBT from a plain Counterparty compose — no envelope, no surgery. The
 * prevouts come from the compose's own `lock_scripts` and `inputs_values`
 * (which is why every compose asks for `verbose=true`).
 */
export function buildPlainPsbt(compose: ComposeResult, _network: Network): string {
  if (!compose.rawtransaction) throw new Error('Core returned no rawtransaction.');
  const core = RawTx.decode(hexToBytes(compose.rawtransaction));
  const tx = new Transaction({ allowUnknownOutputs: true, version: core.version, lockTime: core.lockTime });
  core.inputs.forEach((input, i) => {
    const script = compose.lock_scripts?.[i];
    const value = compose.inputs_values?.[i];
    if (script === undefined || value === undefined) {
      throw new Error(`Core returned no prevout for input ${i}; the transaction cannot be signed safely (compose with verbose=true).`);
    }
    tx.addInput({
      txid: input.txid,
      index: input.index,
      sequence: input.sequence,
      witnessUtxo: { script: hexToBytes(script), amount: BigInt(value) },
      sighashType: SigHash.ALL,
    });
  });
  for (const output of core.outputs) tx.addOutput({ script: output.script, amount: output.amount });
  return encodePsbt(tx);
}

/** Finalize a PSBT that is signed but deliberately left unfinalized. Throws if any input is unsigned. */
export function finalize(signedPsbtBase64: string): { hex: string; txid: string; weight: number; vsize: number } {
  const tx = decodePsbt(signedPsbtBase64);
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const signed =
      !!inp.tapKeySig ||
      !!(inp.tapScriptSig && inp.tapScriptSig.length) ||
      !!(inp.partialSig && inp.partialSig.length) ||
      !!(inp.finalScriptWitness && inp.finalScriptWitness.length);
    if (!signed) throw new Error(`input ${i} is unsigned`);
  }
  tx.finalize();
  const full = tx.toBytes(true, true);
  const stripped = tx.toBytes(true, false);
  const weight = stripped.length * 3 + full.length;
  return { hex: bytesToHex(full), txid: tx.id, weight, vsize: Math.ceil(weight / 4) };
}

/**
 * The txid the reveal will have once signed.
 *
 * A taproot script-path spend commits to nothing in the txid but its inputs
 * and outputs — the witness is not part of it — so this is exact, not a guess,
 * and can be shown before either half is broadcast.
 */
export function unsignedRevealTxid(psbtBase64: string): string {
  return decodePsbt(psbtBase64).id;
}

/**
 * Sign the reveal here, with the private key whose x-only pubkey the leaf
 * names. The reveal is a script-path spend, and whoever holds that key can
 * produce the signature — no wallet, no dialog. Returns the signed PSBT.
 */
export function signRevealLocally(psbtBase64: string, privkey: Uint8Array): string {
  const tx = decodePsbt(psbtBase64);
  let signed = false;
  try {
    // The allowed sighashes have to be spelled out: btc-signer permits
    // SIGHASH_DEFAULT alone by default and silently signs nothing when the
    // input asks for ALL. "Nothing signed" and "wrong key" then look identical.
    signed = tx.signIdx(privkey, 0, [SigHash.DEFAULT, SigHash.ALL]);
  } catch (cause) {
    throw new Error('The reveal key does not match the envelope it is meant to open.', { cause });
  }
  if (!signed) throw new Error('The reveal key does not match the envelope it is meant to open.');
  return encodePsbt(tx);
}
