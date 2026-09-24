import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Address, TAPROOT_UNSPENDABLE_KEY, p2tr } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '../src/bytes.js';
import {
  LEAF_VERSION,
  NUMS_INTERNAL_KEY,
  buildCoreEnvelope,
  commitEnvelope,
  coreCommitScript,
  detectOrdEnvelope,
  envelopeLeafKey,
  newRevealKey,
  reKeyEnvelope,
  revealKeyFromHex,
  xOnlyPubkey,
  MESSAGE_TYPE,
} from '../src/envelope.js';
import { CORE_ENVELOPE, ORD_ENVELOPE, CORE_ENVELOPE_BODY } from './fixtures.js';

describe('reKeyEnvelope', () => {
  const key = newRevealKey();
  const pub = xOnlyPubkey(key);

  it.each([
    ['native', CORE_ENVELOPE],
    ['ord', ORD_ENVELOPE],
  ])('preserves length and message bytes for the %s envelope', (_style, hexEnvelope) => {
    const core = hexToBytes(hexEnvelope);
    const leaf = reKeyEnvelope(core, pub);
    expect(leaf).toHaveLength(core.length);
    expect(bytesToHex(leaf.subarray(0, leaf.length - 34))).toBe(bytesToHex(core.subarray(0, core.length - 34)));
    expect(leaf[leaf.length - 34]).toBe(0x20);
    expect(leaf[leaf.length - 1]).toBe(0xac);
    expect(bytesToHex(envelopeLeafKey(leaf))).toBe(bytesToHex(pub));
    expect(bytesToHex(envelopeLeafKey(core))).not.toBe(bytesToHex(pub));
  });

  it('refuses a key of the wrong size and a script without the key suffix', () => {
    expect(() => reKeyEnvelope(hexToBytes(CORE_ENVELOPE), new Uint8Array(33))).toThrow(/32 bytes/);
    expect(() => reKeyEnvelope(hexToBytes('006368'), pub)).toThrow(/too short/);
    const bad = hexToBytes(CORE_ENVELOPE);
    bad[bad.length - 1] = 0xad;
    expect(() => reKeyEnvelope(bad, pub)).toThrow(/does not end in/);
  });
});

describe('commitEnvelope', () => {
  const key = newRevealKey();
  const pub = xOnlyPubkey(key);
  const core = hexToBytes(CORE_ENVELOPE);
  const leaf = reKeyEnvelope(core, pub);

  it('commits under the NUMS internal key with a single leaf', () => {
    const commit = commitEnvelope(leaf, 'mainnet');
    expect(bytesToHex(commit.controlBlock.subarray(1))).toBe(bytesToHex(TAPROOT_UNSPENDABLE_KEY));
    expect(bytesToHex(NUMS_INTERNAL_KEY)).toBe(bytesToHex(TAPROOT_UNSPENDABLE_KEY));
    expect(commit.controlBlock).toHaveLength(33);
    expect(commit.controlBlock[0]! & 0xfe).toBe(LEAF_VERSION);
    expect(Address().decode(commit.address).type).toBe('tr');
    expect(commit.script).toHaveLength(34);
    expect(commit.script[0]).toBe(0x51);
    // Cross-check against btc-signer's own p2tr derivation.
    const ref = p2tr(NUMS_INTERNAL_KEY, { script: leaf, leafVersion: LEAF_VERSION }, undefined, true);
    expect(commit.address).toBe(ref.address);
    expect(bytesToHex(commit.script)).toBe(bytesToHex(ref.script));
  });

  it("differs from Core's commit only by the key", () => {
    // Core: internal key = leaf key = ephemeral. Ours: internal = NUMS, leaf key = ours.
    const coreScript = coreCommitScript(core);
    const ours = commitEnvelope(leaf, 'mainnet');
    expect(bytesToHex(ours.script)).not.toBe(bytesToHex(coreScript));
    // Put Core's ephemeral key back into the leaf under NUMS: still not Core's script (Core's
    // internal key is the ephemeral one), proving both key positions matter and nothing else does.
    const ephemeral = envelopeLeafKey(core);
    const sameLeafUnderNums = commitEnvelope(core, 'mainnet');
    expect(bytesToHex(sameLeafUnderNums.script)).not.toBe(bytesToHex(coreScript));
    const coreUnderItsOwnKey = p2tr(ephemeral, { script: core, leafVersion: LEAF_VERSION }, undefined, true);
    expect(bytesToHex(coreUnderItsOwnKey.script)).toBe(bytesToHex(coreScript));
    // And re-keying with the same key is idempotent for the address.
    expect(commitEnvelope(reKeyEnvelope(leaf, pub), 'mainnet').address).toBe(ours.address);
  });

  it('encodes per network', () => {
    expect(commitEnvelope(leaf, 'mainnet').address.startsWith('bc1p')).toBe(true);
    expect(commitEnvelope(leaf, 'testnet').address.startsWith('tb1p')).toBe(true);
    expect(commitEnvelope(leaf, 'signet').address.startsWith('tb1p')).toBe(true);
    expect(commitEnvelope(leaf, 'regtest').address.startsWith('bcrt1p')).toBe(true);
  });
});

describe('detectOrdEnvelope', () => {
  it('is ord-shaped only in the ord style, before and after re-keying', () => {
    const pub = xOnlyPubkey(newRevealKey());
    expect(detectOrdEnvelope(hexToBytes(ORD_ENVELOPE))).toBe(true);
    expect(detectOrdEnvelope(hexToBytes(CORE_ENVELOPE))).toBe(false);
    expect(detectOrdEnvelope(reKeyEnvelope(hexToBytes(ORD_ENVELOPE), pub))).toBe(true);
    expect(detectOrdEnvelope(reKeyEnvelope(hexToBytes(CORE_ENVELOPE), pub))).toBe(false);
  });
});

describe('reveal keys', () => {
  it('round-trip through hex and derive the x-only key', () => {
    const key = newRevealKey();
    expect(key).toHaveLength(32);
    const restored = revealKeyFromHex(bytesToHex(key));
    expect(bytesToHex(restored)).toBe(bytesToHex(key));
    expect(bytesToHex(xOnlyPubkey(key))).toBe(bytesToHex(schnorr.getPublicKey(key)));
    expect(() => revealKeyFromHex('abcd')).toThrow(/32 bytes/);
  });
});

describe('buildCoreEnvelope reproduces Core byte-for-byte', () => {
  it('rebuilds the real native envelope (message bytes) from its parts', () => {
    const core = hexToBytes(CORE_ENVELOPE);
    const rebuilt = buildCoreEnvelope({
      typeId: MESSAGE_TYPE.LR_ISSUANCE,
      fields: [0x0d95873dn, 0n, true, false, false],
      mimeType: 'text/plain',
      content: CORE_ENVELOPE_BODY,
      wrapOrd: false,
      leafKey: envelopeLeafKey(core),
    });
    expect(bytesToHex(rebuilt)).toBe(CORE_ENVELOPE);
  });

  it('rebuilds the real ord-wrapped envelope from its parts', () => {
    const core = hexToBytes(ORD_ENVELOPE);
    const rebuilt = buildCoreEnvelope({
      typeId: MESSAGE_TYPE.LR_ISSUANCE,
      fields: [0x0d95873dn, 0n, true, false, false],
      mimeType: 'text/plain',
      content: CORE_ENVELOPE_BODY,
      wrapOrd: true,
      leafKey: envelopeLeafKey(core),
    });
    expect(bytesToHex(rebuilt)).toBe(ORD_ENVELOPE);
  });

  it('chunks at 520 bytes with PUSHDATA2 and the remainder minimally', () => {
    const content = new Uint8Array(1041);
    const leaf = buildCoreEnvelope({ typeId: 22, fields: [1n, 0n, true, false, false], mimeType: 'image/png', content, wrapOrd: true });
    // Body: OP_0, then 520 (0x4d 0x08 0x02), 520, and a 1-byte push (0x01).
    const idx = leaf.indexOf(0x4d);
    expect(idx).toBeGreaterThan(0);
    expect([leaf[idx + 1], leaf[idx + 2]]).toEqual([0x08, 0x02]);
  });
});
