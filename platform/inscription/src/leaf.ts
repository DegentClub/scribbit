/**
 * Reading a wallet's answer on a script-path (inscription leaf) input. Shared by the wallet-signed
 * reveal helpers (wallet.ts) and the service-side parent attachment (reveal.ts).
 *
 * A wallet returns one of two shapes for the input it signed:
 *   - unfinalized: PSBT_IN_TAP_SCRIPT_SIG `[{ pubKey, leafHash }, sig]` next to the leaf we gave it;
 *   - finalized (UniSat `autoFinalized`, sats-connect `broadcast`, XCP `xcp_signPsbt` on some
 *     builds): PSBT_IN_FINAL_SCRIPTWITNESS `[sig, leafScript, controlBlock]` with every other
 *     field stripped, as BIP174 finalization prescribes.
 * Both are normalised to `LeafSignature`, and every check names exactly what was wrong.
 */
import { hex } from '@scure/base';
import type { Transaction } from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { equalBytes } from './bytes.js';
import { NUMS_INTERNAL_KEY } from './commit.js';
import {
  SIGHASH_ALL,
  SIGHASH_ALL_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_SINGLE_ANYONECANPAY,
  TAPSCRIPT_LEAF_VERSION,
} from './constants.js';

const OP_PUSH32 = 0x20;
const OP_CHECKSIG = 0xac;

/** Hash types a commit-input signature may carry. */
export const LEAF_SIGHASH_TYPES: readonly number[] = Object.freeze([
  SIGHASH_DEFAULT,
  SIGHASH_ALL,
  SIGHASH_ALL_ANYONECANPAY,
  SIGHASH_SINGLE_ANYONECANPAY,
]);

/** The x-only key named by an inscription leaf (`<push32 key> OP_CHECKSIG …`). */
export function leafKeyOf(leafScript: Uint8Array): Uint8Array {
  if (leafScript.length < 34 || leafScript[0] !== OP_PUSH32 || leafScript[33] !== OP_CHECKSIG) {
    throw new Error('leaf script does not start with <32-byte key> OP_CHECKSIG (not an inscription envelope)');
  }
  return leafScript.subarray(1, 33);
}

export interface LeafSignature {
  /** 64 bytes (SIGHASH_DEFAULT) or 65 bytes (hash-type byte appended). */
  sig: Uint8Array;
  /** 0x00, 0x01, 0x81 or 0x83. */
  sighashType: number;
  /** The x-only key the signature is for (the leaf key). */
  pubKey: Uint8Array;
  leafScript: Uint8Array;
  /** 33 bytes: (0xc0 | parity) || internal key. */
  controlBlock: Uint8Array;
  leafHash: Uint8Array;
  source: 'tapScriptSig' | 'finalScriptWitness';
}

function hashTypeOf(sig: Uint8Array, what: string): number {
  if (sig.length === 64) return SIGHASH_DEFAULT;
  if (sig.length === 65) {
    const t = sig[64]!;
    if (!LEAF_SIGHASH_TYPES.includes(t)) throw new Error(`${what}: unsupported hash type 0x${t.toString(16)}`);
    return t;
  }
  throw new Error(`${what}: Schnorr signature must be 64 or 65 bytes, got ${sig.length}`);
}

/** The single leaf a reveal input spends, from its PSBT_IN_TAP_LEAF_SCRIPT. */
export function singleLeafOf(tx: Transaction, idx: number): { leafScript: Uint8Array; controlBlock: Uint8Array; leafHash: Uint8Array } {
  const leaves = tx.getInput(idx).tapLeafScript;
  if (!leaves || leaves.length !== 1) throw new Error(`input ${idx} must carry exactly one tapLeafScript (got ${leaves?.length ?? 0})`);
  const [cb, scriptWithVer] = leaves[0]!;
  const ver = scriptWithVer[scriptWithVer.length - 1]!;
  if (ver !== TAPSCRIPT_LEAF_VERSION) throw new Error(`input ${idx}: leaf version must be 0xc0, got 0x${ver.toString(16)}`);
  if (cb.merklePath.length !== 0) throw new Error(`input ${idx}: control block must have an empty merkle path (single leaf)`);
  const leafScript = scriptWithVer.subarray(0, -1);
  const controlBlock = new Uint8Array(33);
  controlBlock[0] = cb.version;
  controlBlock.set(cb.internalKey, 1);
  return { leafScript, controlBlock, leafHash: tapLeafHash(leafScript, TAPSCRIPT_LEAF_VERSION) };
}

/**
 * Extract the leaf signature on `idx`. `expected` pins the leaf (and optionally the key) the
 * signature must be for; when omitted the leaf comes from the input itself. Throws with the
 * precise reason: no signature, signature for another leaf, signature by another key (the
 * classic internal-vs-tweaked wallet mistake), or a malformed finalized witness.
 */
export function extractLeafSignature(
  tx: Transaction,
  idx: number,
  expected?: { leafScript: Uint8Array; controlBlock: Uint8Array; leafHash: Uint8Array; leafPubkey?: Uint8Array },
): LeafSignature {
  const input = tx.getInput(idx);
  const w = input.finalScriptWitness;
  if (w && w.length) {
    if (w.length !== 3) throw new Error(`input ${idx}: finalized witness has ${w.length} items, expected [sig, leafScript, controlBlock]`);
    const [sig, leafScript, controlBlock] = w as [Uint8Array, Uint8Array, Uint8Array];
    if (controlBlock.length !== 33) throw new Error(`input ${idx}: finalized control block must be 33 bytes (single leaf), got ${controlBlock.length}`);
    if ((controlBlock[0]! & 0xfe) !== TAPSCRIPT_LEAF_VERSION) throw new Error(`input ${idx}: finalized control block leaf version is not 0xc0`);
    if (!equalBytes(controlBlock.subarray(1), NUMS_INTERNAL_KEY)) throw new Error(`input ${idx}: finalized control block internal key is not NUMS`);
    if (expected) {
      if (!equalBytes(leafScript, expected.leafScript)) throw new Error(`input ${idx}: finalized witness spends a different leaf than the inscription envelope`);
      if (!equalBytes(controlBlock, expected.controlBlock)) throw new Error(`input ${idx}: finalized witness control block mismatch`);
    }
    const pubKey = leafKeyOf(leafScript);
    if (expected?.leafPubkey && !equalBytes(pubKey, expected.leafPubkey)) {
      throw new Error(`input ${idx}: finalized leaf names key ${hex.encode(pubKey)}, expected ${hex.encode(expected.leafPubkey)}`);
    }
    const sighashType = hashTypeOf(sig, `input ${idx}: finalized witness`);
    return {
      sig,
      sighashType,
      pubKey,
      leafScript,
      controlBlock,
      leafHash: tapLeafHash(leafScript, TAPSCRIPT_LEAF_VERSION),
      source: 'finalScriptWitness',
    };
  }

  const leaf = expected ?? singleLeafOf(tx, idx);
  const leafPubkey = expected?.leafPubkey ?? leafKeyOf(leaf.leafScript);
  const sigs = input.tapScriptSig ?? [];
  if (sigs.length === 0) {
    throw new Error(`input ${idx} is unsigned: no tapScriptSig for the inscription leaf and no finalized witness`);
  }
  const forLeaf = sigs.filter(([k]) => equalBytes(k.leafHash, leaf.leafHash));
  if (forLeaf.length === 0) {
    const other = hex.encode(sigs[0]![0].leafHash);
    throw new Error(`input ${idx}: signature is for a different leaf (leaf hash ${other}, expected ${hex.encode(leaf.leafHash)})`);
  }
  const mine = forLeaf.find(([k]) => equalBytes(k.pubKey, leafPubkey));
  if (!mine) {
    const other = hex.encode(forLeaf[0]![0].pubKey);
    throw new Error(
      `input ${idx}: signature is by key ${other}, expected the leaf key ${hex.encode(leafPubkey)} ` +
        '(the wallet signed with its other key: untweaked internal vs tweaked output key)',
    );
  }
  const sig = mine[1];
  const sighashType = hashTypeOf(sig, `input ${idx}: tapScriptSig`);
  return {
    sig,
    sighashType,
    pubKey: leafPubkey,
    leafScript: leaf.leafScript,
    controlBlock: leaf.controlBlock,
    leafHash: leaf.leafHash,
    source: 'tapScriptSig',
  };
}

/** Control-block struct of btc-signer for a 33-byte single-leaf control block. */
export function controlBlockStruct(controlBlock: Uint8Array): { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] } {
  return { version: controlBlock[0]!, internalKey: controlBlock.subarray(1, 33), merklePath: [] };
}
