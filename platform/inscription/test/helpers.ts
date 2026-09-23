import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { p2tr } from '@scure/btc-signer';
import type { InscriptionContent, Network, RevealSighashMode } from '../src/index.js';

export type Op = { opcode: number; data?: Uint8Array };

/** Minimal independent script decoder (does NOT reuse src). */
export function decodeScript(script: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  while (i < script.length) {
    const opcode = script[i++]!;
    let len = -1;
    if (opcode === 0) len = 0;
    else if (opcode <= 75) len = opcode;
    else if (opcode === 0x4c) len = script[i++]!;
    else if (opcode === 0x4d) {
      len = script[i]! | (script[i + 1]! << 8);
      i += 2;
    } else if (opcode === 0x4e) {
      len = script[i]! | (script[i + 1]! << 8) | (script[i + 2]! << 16) | (script[i + 3]! << 24);
      i += 4;
    }
    if (len >= 0) {
      if (i + len > script.length) throw new Error('truncated push');
      ops.push({ opcode, data: script.slice(i, i + len) });
      i += len;
    } else ops.push({ opcode });
  }
  return ops;
}

/** Expected minimal push opcode for a data length. */
export const pushOpcodeFor = (n: number) => (n === 0 ? 0 : n <= 75 ? n : n <= 255 ? 0x4c : 0x4d);

/** Deterministic pseudo-random bytes (xorshift), fast enough for multi-MB bodies. */
export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed | 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export const REVEAL_PRIV = hex.decode('0101010101010101010101010101010101010101010101010101010101010101');
export const REVEAL_PUB = schnorr.getPublicKey(REVEAL_PRIV);
export const PARENT_PRIV = hex.decode('0202020202020202020202020202020202020202020202020202020202020202');
export const PARENT_INTERNAL = schnorr.getPublicKey(PARENT_PRIV);
export const RECIPIENT_PRIV = hex.decode('0303030303030303030303030303030303030303030303030303030303030303');

export const NETWORK: Network = 'regtest';
export const net = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
export const PARENT = p2tr(PARENT_INTERNAL, undefined, net);
export const RECIPIENT = p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, net);

export const COMMIT_OUTPOINT = { txid: 'aa'.repeat(31) + '01', vout: 1 };
export const PARENT_OUTPOINT = { txid: 'bb'.repeat(31) + '02', vout: 0 };
export const PARENT_ID = `${'cc'.repeat(32)}i0`;
export const PARENT_VALUE = 546n;
export const POSTAGE = 546n;

export function content(size: number, extra: Partial<InscriptionContent> = {}): InscriptionContent {
  return { contentType: 'image/webp', body: bytes(size, size + 7), parentId: PARENT_ID, ...extra };
}

import {
  attachParent,
  buildHalfSignedReveal,
  buildRescueReveal,
  buildResignedRescue,
  finalizeReveal,
  quoteReveal,
  signParentInput,
} from '../src/index.js';

/**
 * Full flow in either sighash mode. `rescue` is the replay rescue (buildRescueReveal) for 0x83 and
 * the re-signed rescue (buildResignedRescue, K_e) for 0x81: the two self-rescue paths.
 */
export function buildAll(c: InscriptionContent, commitValue = 100_000n, sighash: RevealSighashMode = 'all_anyonecanpay') {
  const half = buildHalfSignedReveal({
    network: NETWORK,
    revealPrivkey: REVEAL_PRIV,
    content: c,
    commitOutpoint: COMMIT_OUTPOINT,
    commitValue,
    recipientAddress: RECIPIENT.address!,
    postage: POSTAGE,
    sighash,
    withParent: true,
    parentReturnAddress: PARENT.address!,
    parentValue: PARENT_VALUE,
  });
  const attached = attachParent({
    network: NETWORK,
    halfSignedPsbtBase64: half.psbtBase64,
    parentOutpoint: PARENT_OUTPOINT,
    parentValue: PARENT_VALUE,
    parentScript: PARENT.script,
    parentReturnAddress: PARENT.address!,
  });
  const signed = signParentInput(attached.psbtBase64, PARENT_PRIV);
  const final = finalizeReveal(signed.psbtBase64);
  const rescue =
    sighash === 'single_anyonecanpay'
      ? buildRescueReveal({ network: NETWORK, halfSignedPsbtBase64: half.psbtBase64 })
      : buildResignedRescue({
          network: NETWORK,
          revealPrivkey: REVEAL_PRIV,
          content: c,
          commitOutpoint: COMMIT_OUTPOINT,
          commitValue,
          recipientAddress: RECIPIENT.address!,
          postage: POSTAGE,
        });
  return { half, attached, signed, final, rescue };
}
export { quoteReveal };
