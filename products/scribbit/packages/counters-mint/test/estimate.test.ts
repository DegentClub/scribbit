import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../src/bytes.js';
import { newRevealKey, xOnlyPubkey } from '../src/envelope.js';
import { STANDARD_WITNESS_LIMIT_WU, estimateMint, revealWeightFor } from '../src/estimate.js';
import { buildRevealPsbt, commitTopUp, coreCommitOutput, finalize, revealWeightOf, signRevealLocally } from '../src/psbt.js';
import { xcp69Params } from '../src/xcp69.js';
import { CORE_ENVELOPE, CORE_ENVELOPE_ASSET, CORE_ENVELOPE_BODY, ORD_ENVELOPE, SOURCE_ADDRESS, makeCompose } from './fixtures.js';

const key = newRevealKey();
const pub = xOnlyPubkey(key);

/** Sign the fixture's reveal for real and return the finalized weight. */
function realRevealWeight(compose: Parameters<typeof buildRevealPsbt>[0]['compose'], sighash: 'all' | 'default' = 'all'): number {
  const reveal = buildRevealPsbt({ network: 'mainnet', compose, leafKey32: pub, commitOutpoint: { txid: 'c'.repeat(64), vout: 0 }, commitValue: 100_000, destinationAddress: SOURCE_ADDRESS, sighash });
  return finalize(signRevealLocally(reveal.psbtBase64, key)).weight;
}

describe('estimateMint is exact against real signed reveals', () => {
  it.each([
    ['native', CORE_ENVELOPE, false],
    ['ord', ORD_ENVELOPE, true],
  ])('%s: the real "hello counters" envelope from Core', (_s, envelopeHex, ord) => {
    const fx = makeCompose({ envelope: hexToBytes(envelopeHex), feeRate: 2 });
    const est = estimateMint({ bytes: CORE_ENVELOPE_BODY.length, feeRate: 2, kind: 'counter', assetName: CORE_ENVELOPE_ASSET, hasOrdWrapper: ord, mimeType: 'text/plain' });
    expect(est.envelopeBytes).toBe(fx.envelope.length);
    expect(est.revealWeight).toBe(realRevealWeight(fx.compose));
    expect(est.revealWeight).toBe(revealWeightOf(fx.compose));
    expect(est.revealVsize).toBe(Math.ceil(est.revealWeight / 4));
    expect(est.coreCommitValue).toBe(coreCommitOutput(fx.compose).value);
    expect(est.commitValue).toBe(fx.coreCommitValue + commitTopUp(fx.compose, 2));
    expect(est.revealOutputs).toBe(ord ? 546 : 0);
    expect(est.revealFee).toBe(est.commitValue - est.revealOutputs);
    expect(est.xcpBurn).toBe(50_000_000n);
    expect(est.standardRelay).toBe(true);
  });

  const sizes = [0, 1, 75, 76, 255, 256, 519, 520, 521, 1040, 1041, 10_000, 99_000];
  it.each(sizes.flatMap((n) => [[n, false], [n, true]] as const))('%i-byte body, ord=%s', (bytes, ord) => {
    const fx = makeCompose({ body: new Uint8Array(bytes).fill(7), mimeType: 'image/png', asset: 'A95428956661682177', ordWrapper: ord, quantity: 1000n, feeRate: 1.5 });
    const est = estimateMint({ bytes, feeRate: 1.5, kind: 'counter', assetName: 'A95428956661682177', hasOrdWrapper: ord, mimeType: 'image/png', quantity: 1000n });
    expect(est.envelopeBytes).toBe(fx.envelope.length);
    expect(est.revealWeight).toBe(realRevealWeight(fx.compose));
    expect(est.coreCommitValue).toBe(fx.coreCommitValue);
    expect(est.commitValue).toBe(fx.coreCommitValue + commitTopUp(fx.compose, 1.5));
    expect(est.xcpBurn).toBe(0n);
  });

  it('a reinscription (quantity 0 on an existing asset) and a fairminter deploy', () => {
    const re = makeCompose({ body: new Uint8Array(2000), mimeType: 'image/webp', asset: 'MEMENOME', kind: 'reinscription' });
    const reEst = estimateMint({ bytes: 2000, feeRate: 2, kind: 'reinscription', assetName: 'MEMENOME', mimeType: 'image/webp' });
    expect(reEst.revealWeight).toBe(realRevealWeight(re.compose));
    expect(reEst.xcpBurn).toBe(0n);

    const params = xcp69Params(961_500, 'A95428956661682177');
    const fm = makeCompose({ body: new Uint8Array(2000), mimeType: 'image/webp', asset: 'MEMENOME', kind: 'fairminter', fairminter: params, ordWrapper: true });
    const fmEst = estimateMint({ bytes: 2000, feeRate: 2, kind: 'fairminter', assetName: 'MEMENOME', mimeType: 'image/webp', fairminter: params, hasOrdWrapper: true });
    expect(fmEst.revealWeight).toBe(realRevealWeight(fm.compose));
    expect(fmEst.xcpBurn).toBe(50_000_000n);
  });

  it('SIGHASH_DEFAULT is one weight unit lighter, which is what Core prices', () => {
    const fx = makeCompose({ body: new Uint8Array(500), mimeType: 'image/png' });
    expect(realRevealWeight(fx.compose, 'default')).toBe(realRevealWeight(fx.compose) - 1);
  });
});

describe('estimateMint boundaries and maths', () => {
  it('lands on the 330-sat floor for small reveals at low rates', () => {
    const est = estimateMint({ bytes: 14, feeRate: 0.5, kind: 'counter', assetName: 'TESTBH' });
    expect(est.coreCommitValue).toBe(330);
    expect(est.commitValue).toBe(330);
    expect(est.revealFee).toBe(330);
  });

  it('flags the standard relay cap', () => {
    const under = estimateMint({ bytes: 99_000, feeRate: 1, kind: 'counter' });
    expect(under.revealWeight).toBeLessThanOrEqual(STANDARD_WITNESS_LIMIT_WU);
    expect(under.standardRelay).toBe(true);
    const over = estimateMint({ bytes: 400_000, feeRate: 1, kind: 'counter' });
    expect(over.standardRelay).toBe(false);
    expect(STANDARD_WITNESS_LIMIT_WU).toBe(400_000);
  });

  it('revealWeightFor arithmetic: 1-byte leaf, one OP_RETURN', () => {
    // base: 4+1+41+1+(8+1+10)+4 = 70 → 280; witness: 2+1+66+1+1+34 = 105 → 385
    expect(revealWeightFor(1, [10], 65)).toBe(385);
    expect(revealWeightFor(1, [10], 64)).toBe(384);
  });

  it('validates inputs', () => {
    expect(() => estimateMint({ bytes: -1, feeRate: 1, kind: 'counter' })).toThrow();
    expect(() => estimateMint({ bytes: 1, feeRate: 0, kind: 'counter' })).toThrow();
  });
});
