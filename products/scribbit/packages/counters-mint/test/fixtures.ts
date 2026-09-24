/**
 * Compose responses in Counterparty Core v11's documented shape
 * (`lib/api/composer.py`, `construct` + `compose_transaction` with
 * `verbose=true`), built here without a node.
 *
 * Two real envelopes captured from a live `encoding=taproot` compose on
 * counters.fun ("hello counters", text/plain, asset TESTBH): one native, one
 * with `inscription=true`. Larger fixtures synthesise the envelope with the
 * library's own `buildCoreEnvelope` around an ephemeral key, exactly as Core's
 * `generate_envelope_script` does, and sign Core's reveal with that key so the
 * fixture reveal is a REAL script-path spend Core would have produced.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { RawTx, Transaction, p2tr, utils as btcUtils } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '../src/bytes.js';
import { type ComposeResult } from '../src/compose.js';
import { LEAF_VERSION, MESSAGE_TYPE, buildCoreEnvelope, coreCommitScript, envelopeLeafKey } from '../src/envelope.js';
import { assetId } from '../src/assetnames.js';
import { fairminterMessageFields, type FairminterParams } from '../src/fairminter.js';
import { xcp69Params } from '../src/xcp69.js';
import { type CborValue } from '../src/cbor.js';

/** A v11 native envelope from Core, ending in `<ephemeral key> OP_CHECKSIG`. */
export const CORE_ENVELOPE =
  '00632516871a0d95873d00f5f4f46a746578742f706c61696e4e68656c6c6f20636f756e74657273' +
  '68' +
  '2047a2a087d277149825acfe4485802dfd86f88668c058eba017a5716710f8905fac';

/** The same compose with `inscription=true`: Core's envelope inside an ord one. */
export const ORD_ENVELOPE =
  '0063036f726401070378637001010a746578742f706c61696e' +
  '01050b86161a0d95873d00f5f4f4' +
  '000e68656c6c6f20636f756e7465727368' +
  '207b02f4fb55ea1c56ff99e70be4a454049ec43b1c296babfadd74bffb187d93cfac';

/** Asset id 0x0d95873d, as the real envelope carries it. */
export const CORE_ENVELOPE_ASSET = 'TESTBH';
export const CORE_ENVELOPE_BODY = new TextEncoder().encode('hello counters');

export const CNTRPRTY_OP_RETURN = hexToBytes('6a08434e545250525459');

/** Deterministic keys for fixtures. */
export function testKey(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`scribbit-counters:${label}`));
}

export const SOURCE_KEY = testKey('source');
export const SOURCE_PUBKEY = schnorr.getPublicKey(SOURCE_KEY);
export const SOURCE_P2TR = p2tr(SOURCE_PUBKEY);
export const SOURCE_ADDRESS = SOURCE_P2TR.address!;
export const SOURCE_SCRIPT = SOURCE_P2TR.script;

export const SEGWIT_DUST = 330;
export const REGULAR_DUST = 546;

export interface FixtureArgs {
  /** Use these envelope bytes verbatim (a real Core envelope). The reveal's signature is then a dummy 64 bytes. */
  envelope?: Uint8Array;
  /** Or synthesise one around the fixture's ephemeral key. */
  body?: Uint8Array;
  mimeType?: string;
  asset?: string;
  quantity?: bigint;
  ordWrapper?: boolean;
  kind?: 'counter' | 'reinscription' | 'fairminter';
  fairminter?: FairminterParams;
  feeRate?: number;
  /** Source funds, sat. */
  sourceUtxoValue?: number;
}

export interface Fixture {
  compose: ComposeResult;
  envelope: Uint8Array;
  ephemeralKey: Uint8Array | null;
  coreCommitValue: number;
  revealOutputs: number;
  feeRate: number;
  sourceUtxo: { txid: string; vout: number; value: number; scriptPubKey: string };
}

/** Weight of a raw tx from its bytes: 3 × stripped + full. */
export function rawWeight(rawHex: string): number {
  const tx = Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  const full = tx.toBytes(true, true);
  const stripped = tx.toBytes(true, false);
  return stripped.length * 3 + full.length;
}

/** A Core-style compose response for a counter mint. */
export function makeCompose(args: FixtureArgs = {}): Fixture {
  const feeRate = args.feeRate ?? 2;
  const ordWrapper = args.ordWrapper ?? false;
  const ephemeralKey = args.envelope ? null : testKey('core-ephemeral');
  let envelope: Uint8Array;
  if (args.envelope) {
    envelope = args.envelope;
  } else {
    const body = args.body ?? CORE_ENVELOPE_BODY;
    const mimeType = args.mimeType ?? 'text/plain';
    const asset = args.asset ?? CORE_ENVELOPE_ASSET;
    const kind = args.kind ?? 'counter';
    let typeId: number;
    let fields: CborValue[];
    if (kind === 'fairminter') {
      typeId = MESSAGE_TYPE.FAIRMINTER;
      fields = fairminterMessageFields(args.fairminter ?? xcp69Params(1_000_000), assetId(asset), 0n);
    } else {
      typeId = MESSAGE_TYPE.LR_ISSUANCE;
      fields = [assetId(asset), kind === 'reinscription' ? 0n : (args.quantity ?? 0n), true, false, false];
    }
    envelope = buildCoreEnvelope({ typeId, fields, mimeType, content: body, wrapOrd: ordWrapper, leafKey: schnorr.getPublicKey(ephemeralKey!) });
  }

  // Core's reveal outputs: OP_RETURN CNTRPRTY, plus 546 to the source's change address for the ord wrapper.
  const revealOutputs: { script: Uint8Array; amount: bigint }[] = [{ script: CNTRPRTY_OP_RETURN, amount: 0n }];
  const isOrd = envelope[2] === 0x03 && envelope[3] === 0x6f;
  if (isOrd) revealOutputs.push({ script: SOURCE_SCRIPT, amount: BigInt(REGULAR_DUST) });
  const outputsValue = revealOutputs.reduce((s, o) => s + Number(o.amount), 0);

  // Core's commit output, under the ephemeral key as internal key.
  const commitScript = coreCommitScript(envelope);
  const ephemeralPub = envelopeLeafKey(envelope);
  const payment = p2tr(ephemeralPub, { script: envelope, leafVersion: LEAF_VERSION }, undefined, true);

  // Dummy-signed reveal to size the commit, as get_reveal_transaction_vsize_and_value does.
  // Core sizes with a 330-sat dummy input; btc-signer refuses outputs > inputs, and the value does not change the weight.
  const dummyReveal = buildSignedReveal('f'.repeat(64), 0, 1_000_000, envelope, payment, revealOutputs, ephemeralKey);
  const revealVsize = Math.ceil(rawWeight(dummyReveal) / 4);
  const coreCommitValue = Math.max(Math.ceil(revealVsize * feeRate) + outputsValue, SEGWIT_DUST);

  // The commit: one P2TR input from the source, commit at 0, change last.
  const sourceUtxoValue = args.sourceUtxoValue ?? 1_000_000;
  const sourceUtxo = { txid: bytesToHex(sha256(new TextEncoder().encode('funding'))), vout: 1, value: sourceUtxoValue, scriptPubKey: bytesToHex(SOURCE_SCRIPT) };
  const commitVsize = 155; // one P2TR input, two P2TR outputs — Core's adjusted_vsize for this shape
  const commitFee = Math.ceil(commitVsize * feeRate);
  const change = sourceUtxoValue - coreCommitValue - commitFee;
  const commitRaw = RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: hexToBytes(sourceUtxo.txid), index: sourceUtxo.vout, finalScriptSig: new Uint8Array(), sequence: 0xffffffff }],
    outputs: [
      { amount: BigInt(coreCommitValue), script: commitScript },
      { amount: BigInt(change), script: SOURCE_SCRIPT },
    ],
    witnesses: undefined,
    lockTime: 0,
  });
  const commitTxid = Transaction.fromRaw(commitRaw, { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id;
  const signedReveal = buildSignedReveal(commitTxid, 0, coreCommitValue, envelope, payment, revealOutputs, ephemeralKey);

  const compose: ComposeResult = {
    rawtransaction: bytesToHex(commitRaw),
    btc_in: sourceUtxoValue,
    btc_out: coreCommitValue,
    btc_change: change,
    btc_fee: commitFee,
    data: '434e545250525459' + bytesToHex(envelope.subarray(3, 3 + Math.min(40, envelope.length - 37))),
    lock_scripts: [sourceUtxo.scriptPubKey],
    inputs_values: [sourceUtxoValue],
    signed_tx_estimated_size: { vsize: commitVsize, adjusted_vsize: commitVsize, sigops_count: 1 },
    signed_reveal_rawtransaction: signedReveal,
    envelope_script: bytesToHex(envelope),
    psbt: '',
    params: { source: SOURCE_ADDRESS, encoding: 'taproot', sat_per_vbyte: feeRate },
    name: args.kind === 'fairminter' ? 'fairminter' : 'issuance',
  };
  return { compose, envelope, ephemeralKey, coreCommitValue, revealOutputs: outputsValue, feeRate, sourceUtxo };
}

/** Core's reveal: one script-path input, a 64-byte SIGHASH_DEFAULT signature (real when the key is known). */
function buildSignedReveal(
  commitTxid: string,
  vout: number,
  commitValue: number,
  envelope: Uint8Array,
  payment: ReturnType<typeof p2tr>,
  outputs: { script: Uint8Array; amount: bigint }[],
  ephemeralKey: Uint8Array | null,
): string {
  const tapLeaf = payment.tapLeafScript![0]!;
  const controlBlock = hex.decode(bytesToHex(new Uint8Array([LEAF_VERSION | (tapLeaf[0].version & 1), ...tapLeaf[0].internalKey])));
  if (ephemeralKey) {
    const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 2, lockTime: 0 });
    tx.addInput({
      txid: hexToBytes(commitTxid),
      index: vout,
      sequence: 0xffffffff,
      witnessUtxo: { script: payment.script, amount: BigInt(commitValue) },
      // No tapInternalKey: btc-signer would otherwise key-path sign with the same key. Core's reveal is a script-path spend.
      tapLeafScript: [[tapLeaf[0], tapLeaf[1]]],
    });
    for (const o of outputs) tx.addOutput(o);
    tx.signIdx(ephemeralKey, 0);
    tx.finalize();
    return bytesToHex(tx.extract());
  }
  const dummySig = new Uint8Array(64).fill(0xaa);
  return bytesToHex(
    RawTx.encode({
      version: 2,
      segwitFlag: true,
      inputs: [{ txid: hexToBytes(commitTxid), index: vout, finalScriptSig: new Uint8Array(), sequence: 0xffffffff }],
      outputs,
      witnesses: [[dummySig, envelope, controlBlock]],
      lockTime: 0,
    }),
  );
}

export const randomKey = (): Uint8Array => btcUtils.randomPrivateKeyBytes();
