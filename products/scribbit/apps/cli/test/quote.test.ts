import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { p2tr } from '@scure/btc-signer';
import { attachParent, buildHalfSignedReveal, commitAddress, finalizeReveal, signParentInput } from '@bsh/inscription';
import { describe, expect, it } from 'vitest';
import { bytes, cli, fakeFetch, FIXTURES, PARENT_ID } from './helpers.js';

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const REVEAL_PRIV = hex.decode('01'.repeat(32));
const PARENT_PRIV = hex.decode('02'.repeat(32));
const PARENT = p2tr(schnorr.getPublicKey(PARENT_PRIV), undefined, REGTEST);
const RECIPIENT = p2tr(schnorr.getPublicKey(hex.decode('03'.repeat(32))), undefined, REGTEST).address!;

const MEMPOOL = 'https://mempool.test';
const recommended = { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1 };
const fullBlock = { blockSize: 1_600_000, blockVSize: 998_000, nTx: 3000, totalFees: 9_980_000, medianFee: 9, feeRange: [8, 9, 30] };
const mempoolFetch = (over: Record<string, unknown> = {}) =>
  fakeFetch({
    [`${MEMPOOL}/api/v1/fees/recommended`]: recommended,
    [`${MEMPOOL}/api/v1/fees/mempool-blocks`]: [fullBlock, { ...fullBlock, medianFee: 4, feeRange: [3, 4] }],
    ...over,
  });

describe('scribbit quote: sizes match the @bsh/inscription README table', () => {
  it.each([
    [1, 974, 572, 'standard'],
    [1_000, 1_980, 1_578, 'standard'],
    [390_000, 393_226, 392_824, 'standard'],
    [400_000, 403_285, 402_883, 'block'],
  ])('%i-byte image/webp with parent -> %i WU (rescue %i WU), %s lane', async (size, weight, rescueWeight, lane) => {
    const r = await cli(['quote', 'a.webp', '--parent', PARENT_ID, '--fee-rate', '2', '--json'], { files: { 'a.webp': bytes(size, size + 7) } });
    expect(r.code).toBe(0);
    const q = r.json();
    expect(q).toMatchObject({ ok: true, command: 'quote', contentType: 'image/webp', bodyBytes: size, parentId: PARENT_ID, recipient: 'p2tr (assumed)' });
    expect(q.reveal).toEqual({ layout: 'parent', weight, vsize: Math.ceil(weight / 4), lane });
    expect(q.rescue).toEqual({ weight: rescueWeight, vsize: Math.ceil(rescueWeight / 4), lane });
    expect(q.fees.revealFee).toBe(Math.ceil(weight / 4) * 2);
    expect(q.fees.commitValue).toBe(q.fees.revealFee + 546);
  });

  it('fractional fee rates are exact (1.1 × 1000 vB = 1100, not 1101)', async () => {
    // A body giving exactly 4000 WU (1000 vB) without parent: find it by probing envelope sizes.
    let found = false;
    for (let n = 3_300; n < 3_800 && !found; n++) {
      const probe = (await cli(['quote', 'x.bin', '--content-type', 'application/octet-stream', '--fee-rate', '1.1', '--json'], { files: { 'x.bin': bytes(n) } })).json();
      if (probe.reveal.vsize === 1000) {
        found = true;
        expect(probe.fees.revealFee).toBe(1100);
      }
    }
    expect(found).toBe(true);
  });
});

describe('scribbit quote: predictions equal real signed transactions', () => {
  it.each([1, 520, 521, 10_000, 400_000])('%i-byte body: parent layout, rescue layout and fee', async (size) => {
    const body = bytes(size, size);
    const content = { contentType: 'image/png', body, parentId: PARENT_ID };
    const r = await cli(['quote', 'art.png', '--parent', PARENT_ID, '--fee-rate', '3.3', '--network', 'regtest', '--recipient', RECIPIENT, '--json'], {
      files: { 'art.png': body },
    });
    expect(r.code).toBe(0);
    const q = r.json();
    expect(q.recipient).toBe('p2tr');

    const commit = commitAddress(schnorr.getPublicKey(REVEAL_PRIV), content, 'regtest');
    const half = buildHalfSignedReveal({
      network: 'regtest',
      revealPrivkey: REVEAL_PRIV,
      content,
      commitOutpoint: { txid: 'ab'.repeat(32), vout: 0 },
      commitValue: BigInt(q.fees.commitValue),
      recipientAddress: RECIPIENT,
      postage: 546n,
      sighash: 'single_anyonecanpay', // the CLI `rescue` command replays legacy 0x83 PSBTs
    });
    // Rescue layout, built by the CLI itself.
    const rescue = await cli(['rescue', '--psbt', half.psbtBase64, '--network', 'regtest', '--json']);
    expect(rescue.code).toBe(0);
    expect(rescue.json().weight).toBe(q.rescue.weight);
    // Parent layout.
    const withParent = attachParent({
      network: 'regtest',
      halfSignedPsbtBase64: half.psbtBase64,
      parentOutpoint: { txid: 'cd'.repeat(32), vout: 0 },
      parentValue: 546n,
      parentScript: PARENT.script,
      parentReturnAddress: PARENT.address!,
    });
    const final = finalizeReveal(signParentInput(withParent.psbtBase64, PARENT_PRIV).psbtBase64);
    expect(final.weight).toBe(q.reveal.weight);
    expect(final.vsize).toBe(q.reveal.vsize);
    // The fee the reveal actually pays is the quoted fee, at >= the requested rate.
    expect(q.fees.commitValue - 546).toBe(q.fees.revealFee);
    expect(q.fees.revealFee / final.vsize).toBeGreaterThanOrEqual(3.3);
    expect(commit.address.startsWith('bcrt1p')).toBe(true);
  });
});

describe('scribbit quote: fee sources (injected, no network)', () => {
  it('aggregates recommended + mempool-blocks and uses standard.normal by default', async () => {
    const r = await cli(['quote', `${FIXTURES}hello.txt`, '--fee-source', MEMPOOL, '--json'], { fetch: mempoolFetch() });
    expect(r.code).toBe(0);
    const q = r.json();
    // Two sources: per-target mean. target 1: (12 + 9) / 2, target 3: (8 + 4) / 2, target 144: (2 + 3) / 2.
    expect(q.feeMarket).toEqual({ minFeeRate: 1, standard: { slow: 2.5, normal: 6, fast: 10.5 }, block: { min: 1, recommended: 10 } });
    expect(q.feeRate).toBe(6);
    expect(q.feeSource).toMatchObject({ kind: 'mempool', url: MEMPOOL, pick: 'standard.normal', stale: false });
    expect(q.fees.revealFee).toBe(q.reveal.vsize * 6);
  });

  it('honours --tier', async () => {
    const r = await cli(['quote', `${FIXTURES}hello.txt`, '--fee-source', MEMPOOL, '--tier', 'fast', '--json'], { fetch: mempoolFetch() });
    expect(r.json().feeRate).toBe(10.5);
  });

  it('prices block-lane reveals at block.recommended (displacement rate of the next block)', async () => {
    const r = await cli(['quote', 'big.webp', '--fee-source', MEMPOOL, '--json'], { files: { 'big.webp': bytes(500_000) }, fetch: mempoolFetch() });
    expect(r.code).toBe(0);
    const q = r.json();
    expect(q.reveal.lane).toBe('block');
    expect(q.feeSource.pick).toBe('block.recommended');
    expect(q.feeRate).toBe(10); // 9,980,000 sat / 998,000 vB of projected block 1
    expect(q.warnings).toContain('block lane: the reveal is non-standard (> 400,000 WU) and needs a Libre Relay / Slipstream broadcaster');
  });

  it('talks to a scribb.it fee server when the URL ends in /v1/fees', async () => {
    const fees = {
      network: 'signet',
      minFeeRate: 1,
      standard: { slow: 1, normal: 1.5, fast: 3 },
      block: { min: 1, recommended: 2 },
      fetchedAt: '2026-09-23T00:00:00Z',
      stale: true,
      sources: ['x'],
    };
    const r = await cli(['quote', `${FIXTURES}hello.txt`, '--network', 'signet', '--fee-source', 'http://fees.local/v1/fees', '--json'], {
      fetch: fakeFetch({ 'http://fees.local/v1/fees?network=signet': fees }),
    });
    expect(r.code).toBe(0);
    const q = r.json();
    expect(q.feeRate).toBe(1.5);
    expect(q.feeSource).toMatchObject({ kind: 'scribbit-fee-server', stale: true });
    expect(q.warnings[0]).toMatch(/stale/);
  });

  it('defaults to public mempool.space for the network', async () => {
    const r = await cli(['quote', `${FIXTURES}hello.txt`, '--network', 'signet', '--json'], {
      fetch: fakeFetch({ 'https://mempool.space/signet/api/v1/fees/recommended': recommended }),
    });
    expect(r.code).toBe(0);
    expect(r.fetchCalls).toContain('https://mempool.space/signet/api/v1/fees/recommended');
    expect(r.json().feeRate).toBe(8);
  });

  it('exit 1 when the fee source fails; exit 2 on regtest without a rate', async () => {
    const down = await cli(['quote', `${FIXTURES}hello.txt`, '--fee-source', MEMPOOL], {
      fetch: fakeFetch({}),
    });
    expect(down.code).toBe(1);
    expect(down.stderr).toMatch(/fee source https:\/\/mempool\.test failed/);
    const reg = await cli(['quote', `${FIXTURES}hello.txt`, '--network', 'regtest']);
    expect(reg.code).toBe(2);
    expect(reg.stderr).toMatch(/no public fee source for regtest/);
  });
});

describe('scribbit quote: errors', () => {
  it('exit 3 with details when too large for any lane', async () => {
    const r = await cli(['quote', 'huge.webp', '--fee-rate', '1', '--json'], { files: { 'huge.webp': bytes(3_970_000) } });
    expect(r.code).toBe(3);
    const e = r.json();
    expect(e).toMatchObject({ ok: false, command: 'quote', exitCode: 3, error: { code: 'too_large' } });
    expect(e.error.details.reveal.lane).toBeNull();
    expect(e.error.details.reveal.weight).toBeGreaterThan(3_990_000);
  });

  it.each([
    [['quote'], /missing <file>/],
    [['quote', 'a.unknownext', '--fee-rate', '1'], /cannot infer the content type/],
    [['quote', 'a.txt', '--fee-rate', '0'], /--fee-rate must be a positive number/],
    [['quote', 'a.txt', '--fee-rate', 'abc'], /--fee-rate must be a positive number/],
    [['quote', 'a.txt', '--fee-rate', '1', '--fee-source', 'http://x'], /mutually exclusive/],
    [['quote', 'a.txt', '--fee-rate', '1', '--parent', 'nope'], /invalid --parent/],
    [['quote', 'a.txt', '--fee-rate', '1', '--network', 'litecoin'], /invalid --network/],
    [['quote', 'a.txt', '--fee-rate', '1', '--tier', 'ludicrous'], /invalid --tier/],
    [['quote', 'a.txt', '--fee-rate', '1', '--postage', '100'], /below the P2TR dust limit/],
    [['quote', 'a.txt', '--fee-rate', '1', '--recipient', 'bc1qnotanaddress'], /invalid --recipient/],
    [['quote', 'a.txt', '--fee-source', 'ftp://x'], /must be http/],
    [['quote', 'a.txt', 'b.txt', '--fee-rate', '1'], /unexpected argument "b.txt"/],
    [['quote', 'a.txt', '--fee-rate'], /--fee-rate needs a value/],
  ])('usage error (exit 2): %j', async (argv, msg) => {
    const r = await cli(argv as string[], { files: { 'a.txt': 'hi', 'a.unknownext': 'hi' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(msg);
  });

  it('exit 3 when the file cannot be read', async () => {
    const r = await cli(['quote', '/definitely/missing.txt', '--fee-rate', '1']);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/cannot read file \/definitely\/missing\.txt \(ENOENT\)/);
  });
});
