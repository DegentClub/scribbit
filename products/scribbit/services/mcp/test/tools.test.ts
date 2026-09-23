import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ins from '@bsh/inscription';
import { MAX_CONTENT_BYTES, type CommitAddressResult, type EnvelopeResult, type ExplainLanesResult, type QuoteResult, type RescueResult } from '../src/index.js';
import { b64, bytes, connect, expectSchemaError, failingProvider, fakeFees, fakeProvider, halfSignedFixture, hex, PARENT_ID, PUB, PUB_HEX, type ErrBody, type Harness } from './helpers.js';

const P2TR = Uint8Array.from([0x51, 0x20, ...new Uint8Array(32)]);

describe('tool list', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('exposes exactly the six documented tools, all read-only', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['build_envelope', 'commit_address', 'explain_lanes', 'get_fees', 'quote_inscription', 'rescue_tx']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.inputSchema.type).toBe('object');
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
    }
    const quote = tools.find((t) => t.name === 'quote_inscription')!;
    expect(Object.keys(quote.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['contentType', 'contentBase64', 'contentLength', 'parentId', 'feeRate']));
  });

  it('rejects arguments that fail the zod schema before the handler runs', async () => {
    await expectSchemaError(h, 'quote_inscription', { contentType: 'text/plain', contentLength: -1 });
    await expectSchemaError(h, 'commit_address', { network: 'mainnet' });
    await expectSchemaError(h, 'get_fees', { network: 'litecoin' });
  });
});

describe('get_fees', () => {
  it('returns the provider response verbatim', async () => {
    const provider = fakeProvider('mainnet');
    const h = await connect({ fees: { mainnet: provider } });
    const r = await h.call('get_fees', {});
    expect(r.isError).toBe(false);
    expect(r.data).toEqual(fakeFees('mainnet'));
    expect(provider.calls).toBe(1);
    expect(r.result.content[0]).toMatchObject({ type: 'text' });
    await h.close();
  });

  it('fails with fees_unavailable when no provider is configured for the network or it throws', async () => {
    const h = await connect({ fees: { mainnet: failingProvider('mainnet', 'boom') } });
    const none = await h.call<ErrBody>('get_fees', { network: 'signet' });
    expect(none.isError).toBe(true);
    expect(none.data.error).toMatchObject({ code: 'fees_unavailable', details: { network: 'signet' } });
    const down = await h.call<ErrBody>('get_fees', { network: 'mainnet' });
    expect(down.isError).toBe(true);
    expect(down.data.error.code).toBe('fees_unavailable');
    expect(down.data.error.message).toContain('boom');
    await h.close();
  });
});

describe('quote_inscription', () => {
  let h: Harness;
  const provider = fakeProvider('mainnet');
  beforeAll(async () => (h = await connect({ fees: { mainnet: provider } })));
  afterAll(() => h.close());

  it('matches @bsh/inscription exactly for exact bytes with a parent (parent + rescue layouts)', async () => {
    const body = bytes(1000);
    const content = { contentType: 'image/webp', body, parentId: PARENT_ID };
    const r = await h.call<QuoteResult>('quote_inscription', { contentType: 'image/webp', contentBase64: b64(body), parentId: PARENT_ID, feeRate: 2.5 });
    expect(r.isError).toBe(false);
    const wp = ins.estimateRevealWeight({ content, withParent: true, recipientScript: P2TR });
    const rescue = ins.estimateRevealWeight({ content, withParent: false, recipientScript: P2TR });
    const q = ins.quoteReveal({ revealWeight: wp, feeRate: 2.5, postage: ins.LIMITS.DEFAULT_POSTAGE });
    expect(r.data.reveal).toEqual({ layout: 'parent', weight: wp, vsize: ins.vsizeFromWeight(wp), lane: 'standard' });
    expect(r.data.rescue).toEqual({ weight: rescue, vsize: ins.vsizeFromWeight(rescue), lane: 'standard' });
    expect(wp - rescue).toBe(402);
    expect(r.data.fees).toEqual({ revealFee: Number(q.revealFee), postage: 546, commitValue: Number(q.commitValue) });
    expect(r.data.envelope).toEqual({ scriptBytes: ins.inscriptionScriptLength(content), bodyChunks: 2 });
    expect(r.data.contentSha256).toBe(ins.sha256Hex(body));
    expect(r.data.exactContent).toBe(true);
    expect(r.data.feeSource).toEqual({ kind: 'input' });
    expect(r.data.warnings).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  it('size-only quote equals the exact one for the same length and picks the oracle tier', async () => {
    const exact = await h.call<QuoteResult>('quote_inscription', { contentType: 'text/plain', contentBase64: b64(bytes(4321)), tier: 'fast' });
    const sized = await h.call<QuoteResult>('quote_inscription', { contentType: 'text/plain', contentLength: 4321, tier: 'fast' });
    expect(sized.isError).toBe(false);
    expect(sized.data.reveal).toEqual(exact.data.reveal);
    expect(sized.data.reveal.layout).toBe('single');
    expect(sized.data.rescue).toBeNull();
    expect(sized.data.feeRate).toBe(6.2);
    expect(sized.data.feeSource).toMatchObject({ kind: 'oracle', pick: 'standard.fast', stale: false });
    expect(sized.data.feeMarket).toEqual({ minFeeRate: 1, standard: fakeFees().standard, block: fakeFees().block });
    expect(sized.data.exactContent).toBe(false);
    expect(sized.data.contentSha256).toBeNull();
    expect(sized.data.warnings.join(' ')).toMatch(/size-only/);
    const q = ins.quoteReveal({ revealWeight: sized.data.reveal.weight, feeRate: 6.2, postage: 546n });
    expect(sized.data.fees.revealFee).toBe(Number(q.revealFee));
  });

  it('block-lane reveals use block.recommended and carry a broadcaster warning', async () => {
    const r = await h.call<QuoteResult>('quote_inscription', { contentType: 'image/webp', contentLength: 1_000_000, parentId: PARENT_ID });
    expect(r.isError).toBe(false);
    expect(r.data.reveal.lane).toBe('block');
    expect(r.data.reveal.weight).toBe(1_006_746);
    expect(r.data.feeRate).toBe(5.1);
    expect(r.data.feeSource).toMatchObject({ pick: 'block.recommended' });
    expect(r.data.warnings.some((w) => /Libre Relay/.test(w))).toBe(true);
  });

  it('honours recipientAddress, postage and fractional fee rates', async () => {
    const recipient = ins.commitAddress(PUB, { contentType: 'x', body: new Uint8Array(1) }, 'signet').address;
    const r = await h.call<QuoteResult>('quote_inscription', { network: 'signet', contentType: 'text/plain', contentBase64: b64(new Uint8Array(10)), recipientAddress: recipient, postage: 1000, feeRate: 1.1 });
    expect(r.isError).toBe(false);
    expect(r.data.recipient).toBe('p2tr');
    const w = ins.estimateRevealWeight({ content: { contentType: 'text/plain', body: new Uint8Array(10) }, withParent: false, recipientScript: ins.addressToScript(recipient, 'signet') });
    const q = ins.quoteReveal({ revealWeight: w, feeRate: 1.1, postage: 1000n });
    expect(r.data.fees).toEqual({ revealFee: Number(q.revealFee), postage: 1000, commitValue: Number(q.commitValue) });
    expect(r.data.warnings).toEqual([]);
  });

  it.each([
    ['dust postage', { contentType: 'text/plain', contentLength: 1, feeRate: 1, postage: 100 }, 'invalid_input', /dust/],
    ['no content', { contentType: 'text/plain', feeRate: 1 }, 'invalid_input', /contentBase64.*contentLength/],
    ['bad base64', { contentType: 'text/plain', contentBase64: '!!!!', feeRate: 1 }, 'invalid_input', /base64/],
    ['bad parent', { contentType: 'text/plain', contentLength: 1, feeRate: 1, parentId: `${'zz'.repeat(32)}i0` }, 'invalid_input', /parentId/],
    ['empty content type', { contentType: '   ', contentLength: 1, feeRate: 1 }, 'invalid_input', /contentType/],
    ['length mismatch', { contentType: 'text/plain', contentBase64: b64(bytes(10)), contentLength: 11, feeRate: 1 }, 'content_hash_mismatch', /11/],
    ['hash mismatch', { contentType: 'text/plain', contentBase64: b64(bytes(10)), contentSha256: '0'.repeat(64), feeRate: 1 }, 'content_hash_mismatch', /contentSha256/],
    ['bad recipient', { contentType: 'text/plain', contentLength: 1, feeRate: 1, recipientAddress: 'bc1qnotanaddress' }, 'invalid_input', /recipientAddress/],
    ['no oracle for network', { network: 'regtest', contentType: 'text/plain', contentLength: 1 }, 'fee_rate_required', /feeRate/],
  ])('structured error: %s', async (_name, args, code, msg) => {
    const r = await h.call<ErrBody>('quote_inscription', args);
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe(code);
    expect(r.data.error.message).toMatch(msg);
    expect(r.result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(code) });
  });

  it('too_large when nothing fits, with the size facts in details', async () => {
    const r = await h.call<ErrBody>('quote_inscription', { contentType: 'image/webp', contentLength: 3_970_000, parentId: PARENT_ID, feeRate: 1 });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('too_large');
    expect(r.data.error.message).toMatch(/shrink the body by at least/);
    expect(r.data.error.details).toMatchObject({ reveal: { lane: null }, bodyBytes: 3_970_000 });
  });

  it('refuses content over 4 MiB before decoding (string length) and via contentLength', async () => {
    const tooLong = 'A'.repeat(Math.ceil((MAX_CONTENT_BYTES + 3) / 3) * 4);
    const r1 = await h.call<ErrBody>('quote_inscription', { contentType: 'text/plain', contentBase64: tooLong, feeRate: 1 });
    expect(r1.data.error.code).toBe('content_too_large');
    await expectSchemaError(h, 'quote_inscription', { contentType: 'text/plain', contentLength: MAX_CONTENT_BYTES + 1, feeRate: 1 });
    const ok = await h.call<QuoteResult | ErrBody>('quote_inscription', { contentType: 'text/plain', contentLength: MAX_CONTENT_BYTES, feeRate: 1 });
    expect((ok.data as ErrBody).error?.code).toBe('too_large'); // accepted as input, refused by the maths
  });

  it('flags stale fee data', async () => {
    const stale = await connect({ fees: { mainnet: fakeProvider('mainnet', fakeFees('mainnet', { stale: true })) } });
    const r = await stale.call<QuoteResult>('quote_inscription', { contentType: 'text/plain', contentLength: 1 });
    expect(r.data.feeSource).toMatchObject({ stale: true });
    expect(r.data.warnings.some((w) => /stale/.test(w))).toBe(true);
    await stale.close();
  });
});

describe('build_envelope', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('matches buildInscriptionScript: size, chunks, sha256 and hex preview', async () => {
    const body = bytes(1041);
    const content = { contentType: 'text/plain', body, parentId: PARENT_ID };
    const script = ins.buildInscriptionScript(PUB, content);
    const r = await h.call<EnvelopeResult>('build_envelope', { contentType: 'text/plain', contentBase64: b64(body), parentId: PARENT_ID, revealPubkey: PUB_HEX });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      scriptBytes: script.length,
      bodyBytes: 1041,
      metadataBytes: 0,
      overheadBytes: script.length - 1041,
      scriptSha256: ins.sha256Hex(script),
      body: { chunks: 3, fullChunks: 2, lastChunkBytes: 1 },
      parentTagHex: hex(ins.encodeParentId(PARENT_ID)),
      pubkeyPlaceholder: false,
      revealPubkey: PUB_HEX,
    });
    expect(r.data.hexPreview.head).toBe(hex(script.subarray(0, 64)));
    expect(r.data.hexPreview.tail).toBe(hex(script.subarray(script.length - 16)));
    expect(JSON.stringify(r.data)).not.toContain(hex(script.subarray(64, 200)));
  });

  it('size-only: same size as exact, placeholder key, no hash', async () => {
    const r = await h.call<EnvelopeResult>('build_envelope', { contentType: 'image/png', contentLength: 520 });
    expect(r.data.scriptBytes).toBe(ins.inscriptionScriptLength({ contentType: 'image/png', body: new Uint8Array(520) }));
    expect(r.data.body).toEqual({ chunks: 1, fullChunks: 1, lastChunkBytes: 520 });
    expect(r.data.pubkeyPlaceholder).toBe(true);
    expect(r.data.scriptSha256).toBeNull();
    const empty = await h.call<EnvelopeResult>('build_envelope', { contentType: 'text/plain', contentLength: 0 });
    expect(empty.data.body).toEqual({ chunks: 0, fullChunks: 0, lastChunkBytes: 0 });
  });

  it('accepts metadata and refuses oversized metadata', async () => {
    const meta = bytes(600);
    const r = await h.call<EnvelopeResult>('build_envelope', { contentType: 'text/plain', contentLength: 5, metadataBase64: b64(meta) });
    expect(r.data.metadataBytes).toBe(600);
    expect(r.data.metadata).toEqual({ chunks: 2 });
    expect(r.data.scriptBytes).toBe(ins.inscriptionScriptLength({ contentType: 'text/plain', body: new Uint8Array(5), metadata: meta }));
    const big = await h.call<ErrBody>('build_envelope', { contentType: 'text/plain', contentLength: 5, metadataBase64: 'A'.repeat(1_400_000) });
    expect(big.data.error.code).toBe('content_too_large');
  });

  it('rejects a malformed pubkey', async () => {
    const r = await h.call<ErrBody>('build_envelope', { contentType: 'text/plain', contentLength: 5, revealPubkey: 'zz'.repeat(32) });
    expect(r.data.error).toMatchObject({ code: 'invalid_input', details: { field: 'revealPubkey' } });
  });
});

describe('commit_address', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it.each(['mainnet', 'testnet', 'signet', 'regtest'] as const)('matches commitAddress on %s', async (network) => {
    const body = bytes(700, 3);
    const content = { contentType: 'image/webp', body, parentId: PARENT_ID };
    const expected = ins.commitAddress(PUB, content, network);
    const r = await h.call<CommitAddressResult>('commit_address', { network, revealPubkey: PUB_HEX, contentType: 'image/webp', contentBase64: b64(body), parentId: PARENT_ID, contentSha256: ins.sha256Hex(body), contentLength: 700 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      network,
      address: expected.address,
      scriptPubKey: hex(expected.script),
      tapLeafHash: hex(expected.tapLeafHash),
      controlBlock: hex(expected.controlBlock),
      leafScriptBytes: expected.leafScript.length,
      internalKey: hex(ins.NUMS_INTERNAL_KEY),
      contentSha256: ins.sha256Hex(body),
      parentId: PARENT_ID,
    });
  });

  it('accepts a compressed key and uses its x coordinate', async () => {
    const r = await h.call<CommitAddressResult>('commit_address', { network: 'regtest', revealPubkey: `02${PUB_HEX}`, contentType: 'text/plain', contentBase64: b64(bytes(3)) });
    expect(r.data.address).toBe(ins.commitAddress(PUB, { contentType: 'text/plain', body: bytes(3) }, 'regtest').address);
  });

  it('requires the exact bytes: a hash + length alone cannot derive the address', async () => {
    const r = await h.call<ErrBody>('commit_address', { network: 'mainnet', revealPubkey: PUB_HEX, contentType: 'text/plain', contentSha256: ins.sha256Hex(bytes(3)), contentLength: 3 });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('invalid_input');
    expect(r.data.error.message).toMatch(/contentBase64 is required/);
  });

  it('catches a hash mismatch', async () => {
    const r = await h.call<ErrBody>('commit_address', { network: 'mainnet', revealPubkey: PUB_HEX, contentType: 'text/plain', contentBase64: b64(bytes(3)), contentSha256: ins.sha256Hex(bytes(4)) });
    expect(r.data.error.code).toBe('content_hash_mismatch');
  });
});

describe('explain_lanes', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('reproduces the @bsh/inscription README size table exactly', async () => {
    const r = await h.call<ExplainLanesResult>('explain_lanes', {});
    expect(r.isError).toBe(false);
    const rows = r.data.rows.map((row) => [row.bodyBytes, row.withParent.weight, row.withParent.vsize, row.withParent.lane, row.withParent.fee, row.rescue.weight, row.rescue.lane]);
    expect(rows).toEqual([
      [1, 974, 244, 'standard', 488, 572, 'standard'],
      [1_000, 1_980, 495, 'standard', 990, 1_578, 'standard'],
      [205_000, 207_160, 51_790, 'standard', 103_580, 206_758, 'standard'],
      [390_000, 393_226, 98_307, 'standard', 196_614, 392_824, 'standard'],
      [400_000, 403_285, 100_822, 'block', 201_644, 402_883, 'block'],
      [1_000_000, 1_006_746, 251_687, 'block', 503_374, 1_006_344, 'block'],
      [3_900_000, 3_923_476, 980_869, 'block', 1_961_738, 3_923_074, 'block'],
      [3_960_000, 3_983_823, 995_956, 'block', 1_991_912, 3_983_421, 'block'],
    ]);
    expect(r.data.lanes).toEqual([
      expect.objectContaining({ lane: 'standard', maxTxWeight: 400_000, maxBodyBytes: { withParent: 396_735, rescue: 397_134 } }),
      expect.objectContaining({ lane: 'block', maxTxWeight: 3_990_000, maxBodyBytes: { withParent: 3_966_141, rescue: 3_966_542 } }),
    ]);
    expect(r.data.parentCostWeight).toBe(402);
    expect(r.data.assumptions).toEqual({ contentType: 'image/webp', parentIndex: 0, recipient: 'p2tr', parentReturn: 'p2tr', feeRate: 2 });
    // The max body really is the boundary: one more byte leaves the lane.
    const at = (n: number) => ins.laneFor(ins.estimateRevealWeight({ content: { contentType: 'image/webp', body: new Uint8Array(n), parentId: PARENT_ID }, withParent: true, recipientScript: P2TR }));
    expect(at(396_735)).toBe('standard');
    expect(at(396_736)).toBe('block');
    expect(at(3_966_141)).toBe('block');
    expect(at(3_966_142)).toBeNull();
    // Text rendering carries the table for models.
    const text = (r.result.content[0] as { text: string }).text;
    expect(text).toContain('| 3,960,000 | 3,983,823 | 995,956 | block |');
  });

  it('fee column follows feeRate', async () => {
    const r = await h.call<ExplainLanesResult>('explain_lanes', { feeRate: 10 });
    expect(r.data.rows[0]!.withParent.fee).toBe(2440);
    const bad = await h.call<ErrBody>('explain_lanes', { feeRate: 0.5 });
    expect(bad.isError).toBe(false); // positive, fractional rates are fine
    await expectSchemaError(h, 'explain_lanes', { feeRate: 0 });
  });
});

describe('rescue_tx', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('finalizes the half-signed PSBT exactly like buildRescueReveal and never echoes the PSBT', async () => {
    const fx = halfSignedFixture();
    const expected = ins.buildRescueReveal({ network: 'regtest', halfSignedPsbtBase64: fx.psbtBase64 });
    const r = await h.call<RescueResult>('rescue_tx', { halfSignedPsbtBase64: `  ${fx.psbtBase64}\n`, network: 'regtest' });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ network: 'regtest', txid: expected.txid, hex: expected.hex, weight: expected.weight, vsize: expected.vsize, lane: 'standard', inscriptionId: `${expected.txid}i0` });
    expect(r.data.weight).toBe(ins.estimateRevealWeight({ content: fx.content, withParent: false, recipientScript: ins.addressToScript(fx.recipient, 'regtest') }));
    expect(JSON.stringify(r.result)).not.toContain(fx.psbtBase64.slice(0, 40));
  });

  it('refuses garbage and 0x81 PSBTs with invalid_psbt (0x81 rescues are re-signed with K_e, not replayed)', async () => {
    const fx = halfSignedFixture();
    const garbage = await h.call<ErrBody>('rescue_tx', { halfSignedPsbtBase64: b64(bytes(64)) });
    expect(garbage.data.error.code).toBe('invalid_psbt');
    const notB64 = await h.call<ErrBody>('rescue_tx', { halfSignedPsbtBase64: '***' });
    expect(notB64.data.error.code).toBe('invalid_input');
    // The library default (ADR-0005) signs 0x81 and pre-commits the parent return: that PSBT is not a rescue tx.
    const modern = ins.buildHalfSignedReveal({
      network: 'regtest',
      revealPrivkey: bytes(32, 7),
      content: fx.content,
      commitOutpoint: { txid: '11'.repeat(32), vout: 1 },
      commitValue: 10_000n,
      recipientAddress: fx.recipient,
      postage: 546n,
      parentReturnAddress: fx.recipient,
      parentValue: 546n,
    });
    expect(modern.sighashType).toBe(ins.SIGHASH_ALL_ANYONECANPAY);
    const r81 = await h.call<ErrBody>('rescue_tx', { halfSignedPsbtBase64: modern.psbtBase64, network: 'regtest' });
    expect(r81.isError).toBe(true);
    expect(r81.data.error.code).toBe('invalid_psbt');
    expect(r81.data.error.message).toMatch(/buildResignedRescue/);
    for (const r of [garbage, notB64, r81]) {
      expect(JSON.stringify(r.result)).not.toContain(fx.psbtBase64.slice(0, 40));
      expect(JSON.stringify(r.result)).not.toContain(modern.psbtBase64.slice(0, 40));
    }
  });
});
