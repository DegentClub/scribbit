import { sha256 } from '@noble/hashes/sha2.js';
import { compactSize, concatBytes, i32le, txidToInternal, u32le, u64le, utf8 } from './bytes.js';
import {
  REVEAL_LOCKTIME,
  REVEAL_SEQUENCE,
  REVEAL_TX_VERSION,
  SIGHASH_ALL_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_SINGLE_ANYONECANPAY,
} from './constants.js';

const TAG = sha256(utf8('TapSighash'));

function taggedHash(msg: Uint8Array): Uint8Array {
  return sha256(concatBytes(TAG, TAG, msg));
}

export interface SighashOutput {
  script: Uint8Array;
  value: bigint;
}

const serializeOutput = (o: SighashOutput) => concatBytes(u64le(o.value), compactSize(o.script.length), o.script);

/**
 * Independent BIP341/BIP342 signature hash for the commit input (script-path spend, no annex, no
 * OP_CODESEPARATOR) for one of three hash types:
 *
 *   0x83 (SINGLE|ANYONECANPAY, `childScript`/`childValue`): commits to the commit input and to the
 *        output at the input's index only. Neither the input index nor the other inputs/outputs are
 *        arguments, which is why the same signature validates with the commit input at index 0
 *        (rescue layout) or index 1 (parent layout) as long as the child output sits at that index.
 *   0x81 (ALL|ANYONECANPAY, `outputs`): commits to the commit input and to ALL outputs in order.
 *        Still no input index and no other inputs, so inserting the parent input at index 0 leaves
 *        the digest unchanged; adding, removing or editing any output breaks it.
 *   0x00 (SIGHASH_DEFAULT, `outputs`): commits to everything of a single-input transaction
 *        `[commit] -> outputs` (used by the re-signed rescue; input index 0).
 *
 * `sighashType` defaults to 0x83 when `childScript` is given and to 0x81 when `outputs` is given.
 */
export function revealCommitSighash(args: {
  commitOutpoint: { txid: string; vout: number };
  commitValue: bigint;
  commitScript: Uint8Array;
  tapLeafHash: Uint8Array;
  /** 0x83: the output at the commit input's index. */
  childScript?: Uint8Array;
  childValue?: bigint;
  /** 0x81 / 0x00: every output of the transaction, in order. */
  outputs?: SighashOutput[];
  sighashType?: number;
  version?: number;
  lockTime?: number;
  sequence?: number;
}): Uint8Array {
  const version = args.version ?? REVEAL_TX_VERSION;
  const lockTime = args.lockTime ?? REVEAL_LOCKTIME;
  const sequence = args.sequence ?? REVEAL_SEQUENCE;
  const sighashType = args.sighashType ?? (args.outputs ? SIGHASH_ALL_ANYONECANPAY : SIGHASH_SINGLE_ANYONECANPAY);

  const prevout = concatBytes(txidToInternal(args.commitOutpoint.txid), u32le(args.commitOutpoint.vout));
  const amount = u64le(args.commitValue);
  const scriptPubKey = concatBytes(compactSize(args.commitScript.length), args.commitScript);
  const nSequence = u32le(sequence);
  const ext = concatBytes(args.tapLeafHash, Uint8Array.of(0x00) /* key_version */, u32le(0xffffffff) /* codesep_pos */);
  const head = concatBytes(Uint8Array.of(0x00) /* epoch */, Uint8Array.of(sighashType), i32le(version), u32le(lockTime));
  const spendType = Uint8Array.of(0x02); // ext_flag(1)*2 + annex_present(0)

  if (sighashType === SIGHASH_SINGLE_ANYONECANPAY) {
    if (!args.childScript || args.childValue === undefined) throw new Error('0x83 needs childScript and childValue');
    const shaSingleOutput = sha256(serializeOutput({ script: args.childScript, value: args.childValue }));
    // ANYONECANPAY: no sha_prevouts / sha_amounts / sha_scriptpubkeys / sha_sequences. SINGLE: no sha_outputs.
    return taggedHash(concatBytes(head, spendType, prevout, amount, scriptPubKey, nSequence, shaSingleOutput, ext));
  }

  if (!args.outputs || args.outputs.length === 0) throw new Error(`0x${sighashType.toString(16)} needs outputs`);
  const shaOutputs = sha256(concatBytes(...args.outputs.map(serializeOutput)));

  if (sighashType === SIGHASH_ALL_ANYONECANPAY) {
    // ANYONECANPAY: no sha_prevouts / sha_amounts / sha_scriptpubkeys / sha_sequences. ALL: sha_outputs.
    return taggedHash(concatBytes(head, shaOutputs, spendType, prevout, amount, scriptPubKey, nSequence, ext));
  }

  if (sighashType === SIGHASH_DEFAULT) {
    // Single-input transaction: the per-input hashes cover exactly the commit input, input_index = 0.
    return taggedHash(
      concatBytes(
        head,
        sha256(prevout),
        sha256(amount),
        sha256(scriptPubKey),
        sha256(nSequence),
        shaOutputs,
        spendType,
        u32le(0), // input_index
        ext,
      ),
    );
  }
  throw new Error(`unsupported sighash type 0x${sighashType.toString(16)}`);
}
