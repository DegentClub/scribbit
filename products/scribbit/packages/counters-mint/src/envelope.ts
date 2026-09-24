/**
 * The taproot envelope, rebuilt around a key the minter holds.
 *
 * Counterparty Core composes an inscription by generating a random private
 * key, putting that key's x-only pubkey in the envelope leaf's OP_CHECKSIG,
 * using the SAME key as the commit address's taproot INTERNAL key, and handing
 * back a reveal it has already signed — then discarding the key
 * (`lib/api/composer.py`, `generate_envelope_script`).
 *
 * That construction cannot be funded from a wallet the user controls without
 * trusting Core with the coins, and a stranded commit is unrecoverable because
 * the key is gone. So Core's message bytes are kept and only the key is
 * replaced:
 *
 *   1. the commit's internal key becomes the BIP-341 unspendable NUMS point, so
 *      nobody can key-path spend the commit out from under the inscription;
 *   2. the leaf's OP_CHECKSIG key becomes a key THIS mint holds, so the reveal
 *      can be signed here — and re-signed, as many times as it takes.
 *
 * The leaf is `OP_FALSE OP_IF <data...> OP_ENDIF <32-byte x-only key>
 * OP_CHECKSIG`; swapping a 32-byte key for a 32-byte key leaves the script
 * length — and therefore the reveal's vsize, and therefore the commit value
 * Core computed to pay the reveal's fee — exactly unchanged. Core itself
 * compares envelope scripts with the trailing key and OP_CHECKSIG sliced off
 * (`composer.py`, `check_transaction_sanity`), so the swap is a substitution
 * the protocol already expects.
 *
 * Ported from counters.fun `apps/web/src/lib/inscribe/envelope.ts`.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { OutScript, TAPROOT_UNSPENDABLE_KEY, Address, utils as btcUtils, p2tr } from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { assertBytes, concatBytes, hexToBytes } from './bytes.js';
import { cborEncode, type CborValue } from './cbor.js';
import { networkParams, type Network } from './network.js';

/** Push of a 32-byte x-only key, then OP_CHECKSIG — the last 34 bytes of every envelope leaf. */
const KEY_SUFFIX_LEN = 34;
const OP_PUSH32 = 0x20;
const OP_CHECKSIG = 0xac;
/** BIP342 tapscript leaf version. */
export const LEAF_VERSION = 0xc0;
/** BIP341 NUMS point H (lift_x(sha256(G))): the internal key of every re-keyed commit output. */
export const NUMS_INTERNAL_KEY: Uint8Array = Uint8Array.from(TAPROOT_UNSPENDABLE_KEY);

/* -------------------------------------------------------------------- */
/* Keys                                                                 */
/* -------------------------------------------------------------------- */

/**
 * A fresh 32-byte private key for one mint's leaf. It guards one output, for
 * minutes, and is never sent anywhere; it is kept with the {@link PendingMint}
 * until the reveal is on chain so a failed broadcast is still recoverable.
 */
export function newRevealKey(): Uint8Array {
  return btcUtils.randomPrivateKeyBytes();
}

export function revealKeyFromHex(h: string): Uint8Array {
  const key = hexToBytes(h);
  if (key.length !== 32) throw new Error('a reveal key is 32 bytes');
  return key;
}

/** The x-only public key of a reveal key — what goes in the leaf (`leafKey32`). */
export function xOnlyPubkey(privkey32: Uint8Array): Uint8Array {
  assertBytes(privkey32, 32, 'privkey');
  return schnorr.getPublicKey(privkey32);
}

/* -------------------------------------------------------------------- */
/* Re-keying                                                            */
/* -------------------------------------------------------------------- */

/**
 * Replace the ephemeral key in Core's `envelope_script` with `leafKey32`
 * (an x-only public key).
 *
 * Throws if the script does not end in the expected key push, rather than
 * silently producing a leaf that commits to nothing spendable — a wrong leaf
 * here becomes a commit address whose coins no one can reach.
 */
export function reKeyEnvelope(envelopeScript: Uint8Array, leafKey32: Uint8Array): Uint8Array {
  assertBytes(leafKey32, 32, 'leafKey32');
  if (envelopeScript.length < KEY_SUFFIX_LEN) throw new Error('envelope script is too short to carry a key');
  const suffix = envelopeScript.length - KEY_SUFFIX_LEN;
  if (envelopeScript[suffix] !== OP_PUSH32 || envelopeScript[envelopeScript.length - 1] !== OP_CHECKSIG) {
    throw new Error(
      'envelope script does not end in <32-byte key> OP_CHECKSIG — Counterparty Core built something ' +
        'this library does not recognize, so the key was not swapped',
    );
  }
  const leaf = new Uint8Array(envelopeScript.length);
  leaf.set(envelopeScript.subarray(0, suffix), 0);
  leaf[suffix] = OP_PUSH32;
  leaf.set(leafKey32, suffix + 1);
  leaf[leaf.length - 1] = OP_CHECKSIG;
  return leaf;
}

/** The x-only key a leaf names (Core's ephemeral one, or ours after re-keying). */
export function envelopeLeafKey(envelopeScript: Uint8Array): Uint8Array {
  if (envelopeScript.length < KEY_SUFFIX_LEN) throw new Error('envelope script is too short to carry a key');
  return envelopeScript.subarray(envelopeScript.length - 33, envelopeScript.length - 1);
}

/** An ord envelope opens `OP_FALSE OP_IF "ord"`; Core's native one goes straight to its data. */
export function detectOrdEnvelope(envelopeScript: Uint8Array): boolean {
  return (
    envelopeScript.length > 6 &&
    envelopeScript[0] === 0x00 &&
    envelopeScript[1] === 0x63 &&
    envelopeScript[2] === 0x03 &&
    envelopeScript[3] === 0x6f &&
    envelopeScript[4] === 0x72 &&
    envelopeScript[5] === 0x64
  );
}

/* -------------------------------------------------------------------- */
/* Commit output                                                        */
/* -------------------------------------------------------------------- */

export interface CommitEnvelope {
  /** bech32m address the commit must pay. */
  address: string;
  /** scriptPubKey of that address (OP_1 <32-byte output key>). */
  script: Uint8Array;
  /** 33 bytes: (0xc0 | parity) || NUMS internal key — single leaf, empty merkle path. */
  controlBlock: Uint8Array;
  tapLeafHash: Uint8Array;
  /** The leaf the commit was derived from. */
  leaf: Uint8Array;
  /** The NUMS internal key. */
  internalKey: Uint8Array;
}

/**
 * Derive the commit output for a (re-keyed) leaf: a single-leaf taproot tree
 * under the NUMS point.
 *
 * The control block's parity bit is not a detail to assume: it comes out of
 * the tweak and differs per envelope, and a control block carrying the wrong
 * bit describes a different output key than the one the commit pays.
 */
export function commitEnvelope(envelopeScript: Uint8Array, network: Network): CommitEnvelope {
  const leafHash = tapLeafHash(envelopeScript, LEAF_VERSION);
  const [outputKey, parity] = btcUtils.taprootTweakPubkey(NUMS_INTERNAL_KEY, leafHash);
  const script = OutScript.encode({ type: 'tr', pubkey: outputKey });
  const address = Address(networkParams(network)).encode({ type: 'tr', pubkey: outputKey });
  const controlBlock = concatBytes(Uint8Array.of(LEAF_VERSION | parity), NUMS_INTERNAL_KEY);
  return { address, script, controlBlock, tapLeafHash: leafHash, leaf: envelopeScript, internalKey: NUMS_INTERNAL_KEY };
}

/**
 * Re-derive the commit script Core built, so its output is found by identity
 * rather than by position. Core's internal key is the same ephemeral key its
 * leaf names.
 */
export function coreCommitScript(envelopeScript: Uint8Array): Uint8Array {
  const ephemeral = envelopeLeafKey(envelopeScript);
  return p2tr(ephemeral, { script: envelopeScript, leafVersion: LEAF_VERSION }, undefined, true).script;
}

/* -------------------------------------------------------------------- */
/* Rebuilding Core's envelope (for sizing before compose)               */
/* -------------------------------------------------------------------- */

/** Minimal data push, as python-bitcoinutils' `Script` emits it. */
export function pushData(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n <= 75) return concatBytes(Uint8Array.of(n), data);
  if (n <= 0xff) return concatBytes(Uint8Array.of(0x4c, n), data);
  if (n <= 0xffff) return concatBytes(Uint8Array.of(0x4d, n & 0xff, n >> 8), data);
  throw new Error('push too large');
}

function chunks(data: Uint8Array, size = 520): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

/** Counterparty message type ids (`messages/issuance.py`, `messages/fairminter.py`). */
export const MESSAGE_TYPE = Object.freeze({
  /** Standard issuance and every reissuance (`issuance_backwards_compatibility` on). */
  LR_ISSUANCE: 22,
  /** Initial subasset issuance. */
  LR_SUBASSET: 23,
  FAIRMINTER: 90,
});

/**
 * Core's envelope for a message `[typeId, ...fields, mime_type, content]`,
 * with a placeholder leaf key. `wrapOrd` reproduces
 * `generate_ordinal_envelope_script`; otherwise the native one. The bytes
 * match Core's construction so the LENGTH is exact — the leaf that goes on
 * chain is always Core's own, re-keyed.
 */
export function buildCoreEnvelope(args: {
  typeId: number;
  fields: CborValue[];
  mimeType: string;
  content: Uint8Array;
  wrapOrd: boolean;
  leafKey?: Uint8Array;
}): Uint8Array {
  const key = args.leafKey ?? NUMS_INTERNAL_KEY;
  assertBytes(key, 32, 'leafKey');
  const parts: Uint8Array[] = [Uint8Array.of(0x00, 0x63)]; // OP_FALSE OP_IF
  if (args.wrapOrd) {
    const metadata = cborEncode([args.typeId, ...args.fields]);
    parts.push(pushData(new TextEncoder().encode('ord')));
    parts.push(pushData(Uint8Array.of(0x07)), pushData(new TextEncoder().encode('xcp')));
    parts.push(pushData(Uint8Array.of(0x01)), pushData(new TextEncoder().encode(args.mimeType || 'text/plain')));
    for (const chunk of chunks(metadata)) parts.push(pushData(Uint8Array.of(0x05)), pushData(chunk));
    parts.push(Uint8Array.of(0x00)); // OP_0: body tag
    for (const chunk of chunks(args.content)) parts.push(pushData(chunk));
  } else {
    const typeByte = Uint8Array.of(args.typeId);
    const data = concatBytes(typeByte, cborEncode([...args.fields, args.mimeType, args.content]));
    for (const chunk of chunks(data)) parts.push(pushData(chunk));
  }
  parts.push(Uint8Array.of(0x68)); // OP_ENDIF
  parts.push(Uint8Array.of(OP_PUSH32), key, Uint8Array.of(OP_CHECKSIG));
  return concatBytes(...parts);
}
