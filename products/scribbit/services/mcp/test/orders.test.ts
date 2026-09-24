import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as ins from '@bsh/inscription';
import { createLedgerClient, quoteInscription, QUOTE_TTL_MS, TOOLS, type CreateOrderResult, type GetOrderResult, type GetReceiptResult, type ReportFundingResult, type ScribbitMcpPorts } from '../src/index.js';
import { FakeLedger } from './fake-ledger.js';
import { bytes, connect, expectSchemaError, fakeProvider, hex, PARENT_ID, PRIV, PUB, type ErrBody, type Harness } from './helpers.js';

const NET = 'regtest' as const;
const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const p2tr = (seed: number) => ins.commitAddress(PUB, { contentType: 'x', body: bytes(8, seed) }, NET).address;
const script = (addr: string) => hex(ins.addressToScript(addr, NET));

const CONTENT = bytes(1234, 11);
const SHA = ins.sha256Hex(CONTENT);
const COMMIT = ins.commitAddress(PUB, { contentType: 'image/webp', body: CONTENT, parentId: PARENT_ID }, NET).address;
const RECIPIENT = p2tr(1);
const ARTIST = p2tr(2);
const CLUB = p2tr(3);
const P2WPKH = btc.p2wpkh(secp256k1.getPublicKey(PRIV, true), REGTEST).address!;
const TXID = 'a'.repeat(64);

const base = () => ({
  network: NET,
  contentType: 'image/webp',
  contentSha256: SHA,
  contentLength: CONTENT.length,
  parentId: PARENT_ID,
  recipientAddress: RECIPIENT,
  commitAddress: COMMIT,
  feeRate: 3,
  mintPriceSats: 100_000,
  payees: [
    { kind: 'artist', ref: 'artist-7', address: ARTIST, bps: 1000 },
    { kind: 'club', ref: 'the-club', address: CLUB, bps: 250 },
  ],
});

describe('order tools over the ledger (in-memory fake, contract-validated)', () => {
  let fake: FakeLedger;
  let h: Harness;
  let ports: ScribbitMcpPorts;
  beforeEach(async () => {
    fake = new FakeLedger();
    ports = { ledger: createLedgerClient({ baseUrl: fake.baseUrl, apiKey: fake.apiKey, fetch: fake.fetch }), fees: { regtest: fakeProvider(NET) }, now: fake.now };
    h = await connect(ports);
  });
  afterEach(() => h.close());

  describe('create_order', () => {
    it('quotes like quote_inscription, builds the line items, opens a psbt intent and returns the outputs to fund', async () => {
      const r = await h.call<CreateOrderResult>('create_order', base());
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      const quote = await quoteInscription({ network: NET, contentType: 'image/webp', contentLength: CONTENT.length, contentSha256: SHA, parentId: PARENT_ID, feeRate: 3, recipientAddress: RECIPIENT }, ports);
      expect(r.data.quote.reveal).toEqual(quote.reveal);
      expect(r.data.quote.fees).toEqual(quote.fees);
      expect(r.data.commitValueSats).toBe(quote.fees.commitValue);
      expect(r.data.payeeSats).toBe(10_000 + 2_500);
      expect(r.data.totalSats).toBe(quote.fees.commitValue + 12_500);
      expect(r.data.status).toEqual({ order: 'awaiting_payment', payment: 'created' });
      expect(r.data.orderId).toMatch(/^ord_/);
      expect(r.data.paymentId).toMatch(/^pay_/);
      expect(r.data.lineItems.map((li) => [li.sku, li.unitSats, li.payee?.kind, li.payee?.ref, li.payee?.address])).toEqual([
        ['network-cost', quote.fees.commitValue, 'platform', 'commit', COMMIT],
        ['share:artist:artist-7', 10_000, 'artist', 'artist-7', ARTIST],
        ['share:club:the-club', 2_500, 'club', 'the-club', CLUB],
      ]);
      expect(r.data.expectedOutputs).toEqual([
        { scriptHex: script(COMMIT), address: COMMIT, valueSats: quote.fees.commitValue, payee: { kind: 'platform', ref: 'commit' } },
        { scriptHex: script(ARTIST), address: ARTIST, valueSats: 10_000, payee: { kind: 'artist', ref: 'artist-7' } },
        { scriptHex: script(CLUB), address: CLUB, valueSats: 2_500, payee: { kind: 'club', ref: 'the-club' } },
      ]);
      expect(r.data.quoteExpiresAt).toBe(new Date(fake.now().getTime() + QUOTE_TTL_MS).toISOString());
      expect(r.data.expiresAt).toBe(new Date(fake.now().getTime() + 60 * 60_000).toISOString());
      expect(r.data.warnings).toEqual([]);
      expect(r.data.next).toMatch(/your own wallet/i);
      // what the ledger received: product scribbit, customerRef = recipient, the metadata the reveal is checked against
      const order = fake.orders.get(r.data.orderId)!;
      expect(order).toMatchObject({ product: 'scribbit', customerRef: RECIPIENT, totalSats: r.data.totalSats });
      expect(order.metadata).toMatchObject({ contentSha256: SHA, network: NET, quoteExpiresAt: r.data.quoteExpiresAt, parentId: PARENT_ID, commitAddress: COMMIT, lane: 'standard', contentLength: String(CONTENT.length) });
      expect(fake.requests.map((q) => [q.method, q.path])).toEqual([
        ['POST', '/v1/orders'],
        ['POST', `/v1/orders/${r.data.orderId}/payments`],
      ]);
      expect(fake.requests[0]!.auth).toBe(`Bearer ${fake.apiKey}`);
      expect(fake.requests[1]!.body).toEqual({ method: 'psbt' });
      expect(JSON.stringify(r.result)).not.toContain(fake.apiKey);
      expect((r.result.content[0] as { text: string }).text).toMatch(/^Order ord_\d+ \/ payment pay_\d+: fund \d+ sats across 3 output\(s\)/);
    });

    it('forwards idempotencyKey so a retry returns the same order and payment', async () => {
      const a = await h.call<CreateOrderResult>('create_order', { ...base(), idempotencyKey: 'agent-run-1' });
      const b = await h.call<CreateOrderResult>('create_order', { ...base(), idempotencyKey: 'agent-run-1' });
      expect(a.isError || b.isError).toBe(false);
      expect(b.data.orderId).toBe(a.data.orderId);
      expect(b.data.paymentId).toBe(a.data.paymentId);
      expect(fake.orders.size).toBe(1);
      expect(fake.requests.every((q) => q.idempotencyKey === 'agent-run-1')).toBe(true);
    });

    it('without payees the only expected output is the commit; mintPriceSats is optional; the oracle rate is used without feeRate', async () => {
      const { payees: _p, mintPriceSats: _m, feeRate: _f, ...rest } = base();
      const r = await h.call<CreateOrderResult>('create_order', { ...rest, tier: 'fast' });
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data.expectedOutputs).toHaveLength(1);
      expect(r.data.expectedOutputs[0]!.payee).toEqual({ kind: 'platform', ref: 'commit' });
      expect(r.data.totalSats).toBe(r.data.commitValueSats);
      expect(r.data.mintPriceSats).toBe(0);
      expect(r.data.quote.feeRate).toBe(6.2);
      expect(r.data.quote.feeSource).toMatchObject({ kind: 'oracle', pick: 'standard.fast' });
    });

    it('warns about dust-sized payee shares and merges nothing it should not', async () => {
      const r = await h.call<CreateOrderResult>('create_order', { ...base(), mintPriceSats: 4_000, payees: [{ kind: 'artist', ref: 'a', address: ARTIST, bps: 1000 }] });
      expect(r.isError).toBe(false);
      expect(r.data.payeeSats).toBe(400);
      expect(r.data.warnings.join(' ')).toMatch(/artist:a receives 400 sats, below 546/);
    });

    it.each([
      ['payees without mintPriceSats', { mintPriceSats: undefined }, /mintPriceSats is required/],
      ['bps over 100 %', { payees: [{ kind: 'artist', ref: 'a', address: ARTIST, bps: 6000 }, { kind: 'club', ref: 'c', address: CLUB, bps: 5000 }] }, /more than 10000/],
      ['share rounds to zero', { mintPriceSats: 5, payees: [{ kind: 'artist', ref: 'a', address: ARTIST, bps: 100 }] }, /rounds to 0 sats/],
      ['payee address of another network', { payees: [{ kind: 'artist', ref: 'a', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', bps: 100 }] }, /payees\[0\]\.address/],
      ['reserved commit payee', { payees: [{ kind: 'platform', ref: 'commit', address: ARTIST, bps: 100 }] }, /reserved/],
      ['bad commitAddress', { commitAddress: 'bcrt1qnotanaddress' }, /commitAddress/],
      ['non-P2TR commitAddress', { commitAddress: P2WPKH }, /P2TR/],
      ['bad recipient', { recipientAddress: 'bcrt1qnotvalid' }, /recipientAddress/],
      ['bad idempotency key', { idempotencyKey: 'has space' }, /idempotencyKey/],
    ])('invalid_input: %s', async (_name, patch, msg) => {
      const r = await h.call<ErrBody>('create_order', { ...base(), ...patch });
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe('invalid_input');
      expect(r.data.error.message).toMatch(msg);
      expect(fake.requests).toEqual([]); // nothing reached the ledger
    });

    it('quote failures come through unchanged and nothing is created', async () => {
      const big = await h.call<ErrBody>('create_order', { ...base(), contentLength: 4 * 1024 * 1024 });
      expect(big.data.error.code).toBe('too_large');
      const noRate = await connect({ ...ports, fees: {} });
      const r = await noRate.call<ErrBody>('create_order', { ...base(), feeRate: undefined });
      expect(r.data.error.code).toBe('fee_rate_required');
      await noRate.close();
      await expectSchemaError(h, 'create_order', { ...base(), contentSha256: undefined });
      await expectSchemaError(h, 'create_order', { ...base(), payees: [{ kind: 'artist', ref: 'a', address: ARTIST, bps: 0 }] });
      await expectSchemaError(h, 'create_order', { ...base(), mintPriceSats: -1 });
      await expectSchemaError(h, 'create_order', { ...base(), payees: Array.from({ length: 21 }, (_, i) => ({ kind: 'other', ref: `p${i}`, address: ARTIST, bps: 1 })) });
      expect(fake.orders.size).toBe(0);
    });

    it('ledger failures: rejected (with the ledger code), unreachable, or not configured; the key never leaks', async () => {
      fake.failNext = { status: 409, code: 'payee_required', message: 'psbt payments need a payee on every line item' };
      const rejected = await h.call<ErrBody>('create_order', base());
      expect(rejected.data.error).toMatchObject({ code: 'ledger_rejected', details: { status: 409, code: 'payee_required' } });
      expect(rejected.data.error.message).toMatch(/creating the order: psbt payments need a payee/);
      fake.failNext = { status: 401, code: 'invalid_api_key', message: 'Invalid API key' };
      const unauth = await h.call<ErrBody>('create_order', base());
      expect(unauth.data.error).toMatchObject({ code: 'ledger_rejected', details: { status: 401 } });
      expect(JSON.stringify(unauth.result)).not.toContain(fake.apiKey);
      fake.down = true;
      const down = await h.call<ErrBody>('create_order', base());
      expect(down.data.error.code).toBe('ledger_unavailable');
      expect(down.data.error.message).toMatch(/ECONNREFUSED/);
      fake.down = false;
      const none = await connect({ fees: ports.fees });
      const off = await none.call<ErrBody>('create_order', base());
      expect(off.data.error.code).toBe('ledger_unavailable');
      expect(off.data.error.message).toMatch(/MCP_LEDGER_URL/);
      await none.close();
    });

    it('a failure opening the payment leaves the order created and says so', async () => {
      const okOrder = await h.call<CreateOrderResult>('create_order', base());
      expect(okOrder.isError).toBe(false);
      fake.requests.length = 0;
      const second = new FakeLedger();
      second.failNext = undefined;
      const h2 = await connect({ ...ports, ledger: createLedgerClient({ baseUrl: second.baseUrl, apiKey: second.apiKey, fetch: async (u, i) => (second.requests.length === 1 ? (second.failNext = { status: 503, code: 'provider_unavailable', message: 'psbt provider down' }, second.fetch(u, i)) : second.fetch(u, i)) }) });
      const r = await h2.call<ErrBody>('create_order', base());
      expect(r.data.error).toMatchObject({ code: 'ledger_rejected', details: { status: 503, code: 'provider_unavailable' } });
      expect(r.data.error.message).toMatch(/opening the psbt payment for order ord_/);
      expect([...second.orders.values()][0]!.status).toBe('created');
      await h2.close();
    });
  });

  describe('get_order, report_funding, get_receipt', () => {
    let created: CreateOrderResult;
    beforeEach(async () => {
      const r = await h.call<CreateOrderResult>('create_order', base());
      if (r.isError) throw new Error(JSON.stringify(r.data));
      created = r.data;
    });

    const fundingOutputs = (skip?: string) => [
      { scriptHex: script(P2WPKH), valueSats: 250_000 }, // change first: vout order must not matter
      ...created.expectedOutputs.filter((o) => o.payee.ref !== skip).map((o) => ({ scriptHex: o.scriptHex.toUpperCase(), valueSats: o.valueSats })),
    ];

    it('get_order reads status, the current payment with its expected outputs, and payouts', async () => {
      const r = await h.call<GetOrderResult>('get_order', { orderId: created.orderId });
      expect(r.isError).toBe(false);
      expect(r.data.status).toEqual({ order: 'awaiting_payment', payment: 'created' });
      expect(r.data.payment).toMatchObject({ id: created.paymentId, method: 'psbt', status: 'created', amountSats: created.totalSats, txid: null, expectedOutputs: created.expectedOutputs });
      expect(r.data.payments).toHaveLength(1);
      expect(r.data.payouts).toEqual([]);
      expect(r.data.order.metadata.contentSha256).toBe(SHA);
      expect((r.result.content[0] as { text: string }).text).toMatch(/is awaiting_payment, payment created; 0 payout\(s\)/);
    });

    it('get_order / get_receipt: unknown ids are order_not_found, malformed ids invalid_input', async () => {
      for (const tool of ['get_order', 'get_receipt']) {
        const missing = await h.call<ErrBody>(tool, { orderId: 'ord_nope' });
        expect(missing.data.error.code).toBe('order_not_found');
        const bad = await h.call<ErrBody>(tool, { orderId: 'pay_0001' });
        expect(bad.data.error.code).toBe('invalid_input');
      }
    });

    it('report_funding round trip: pending unconfirmed -> paid at depth with payouts -> receipt', async () => {
      const outputs = fundingOutputs();
      const seen = await h.call<ReportFundingResult>('report_funding', { orderId: created.orderId, txid: TXID.toUpperCase(), outputs });
      expect(seen.isError, JSON.stringify(seen.data)).toBe(false);
      expect(seen.data).toMatchObject({ orderId: created.orderId, paymentId: created.paymentId, txid: TXID, applied: true, reason: null, status: { order: 'awaiting_payment', payment: 'pending' }, confirmations: 0, payouts: [] });
      expect(seen.data.next).toMatch(/Report again/);
      // the ledger got a contract-shaped observation with lowercase scripts
      const obs = fake.requests.at(-1)!;
      expect(obs.path).toBe(`/v1/payments/${created.paymentId}/observations`);
      expect(obs.body).toEqual({ txid: TXID, outputs: outputs.map((o) => ({ scriptHex: o.scriptHex.toLowerCase(), valueSats: o.valueSats })), confirmations: 0, rbfSignalled: false });

      const foreign = await h.call<ReportFundingResult>('report_funding', { orderId: created.orderId, txid: 'b'.repeat(64), outputs: [{ scriptHex: script(P2WPKH), valueSats: 1 }], confirmations: 5 });
      expect(foreign.data.applied).toBe(false);
      expect(foreign.data.reason).toMatch(/none of the expected outputs/);
      expect(foreign.data.status.payment).toBe('pending');
      expect(foreign.data.next).toMatch(/Nothing changed/);

      const paid = await h.call<ReportFundingResult>('report_funding', { orderId: created.orderId, txid: TXID, outputs, confirmations: 1 });
      expect(paid.data).toMatchObject({ applied: true, status: { order: 'paid', payment: 'paid' }, amountPaidSats: created.totalSats, amountSats: created.totalSats });
      expect(paid.data.payouts.map((p) => [p.payee.ref, p.amountSats, p.vout, p.status])).toEqual([
        ['commit', created.commitValueSats, 1, 'settled'],
        ['artist-7', 10_000, 2, 'settled'],
        ['the-club', 2_500, 3, 'settled'],
      ]);
      expect(paid.data.settlements).toHaveLength(3);
      expect(paid.data.next).toMatch(/buildHalfSignedReveal/);
      expect((paid.result.content[0] as { text: string }).text).toMatch(/payment paid, order paid/);

      const again = await h.call<ReportFundingResult>('report_funding', { orderId: created.orderId, paymentId: created.paymentId, txid: TXID, outputs, confirmations: 6 });
      expect(again.data.applied).toBe(false);
      expect(again.data.payouts).toHaveLength(3);

      const order = await h.call<GetOrderResult>('get_order', { orderId: created.orderId });
      expect(order.data.status).toEqual({ order: 'paid', payment: 'paid' });
      expect(order.data.payment?.txid).toBe(TXID);
      expect(order.data.payouts).toHaveLength(3);

      const receipt = await h.call<GetReceiptResult>('get_receipt', { orderId: created.orderId });
      expect(receipt.isError).toBe(false);
      expect(receipt.data.receipt.order.id).toBe(created.orderId);
      expect(receipt.data.receipt.totals).toEqual({ totalSats: created.totalSats, paidSats: created.totalSats, refundedSats: 0, dueSats: 0 });
      expect(receipt.data.receipt.payouts?.map((p) => p.payee.ref)).toEqual(['commit', 'artist-7', 'the-club']);
      expect(receipt.data.text).toMatch(/^RECEIPT rcpt_/);
      expect(receipt.data.text).toContain('Payouts');
      expect((receipt.result.content[0] as { text: string }).text.startsWith(receipt.data.text)).toBe(true);
    });

    it('report_funding: a short transaction is underpaid and says which outputs are missing', async () => {
      const r = await h.call<ReportFundingResult>('report_funding', { orderId: created.orderId, txid: TXID, outputs: fundingOutputs('artist-7'), confirmations: 2 });
      expect(r.isError).toBe(false);
      expect(r.data.status).toEqual({ order: 'awaiting_payment', payment: 'underpaid' });
      expect(r.data.amountPaidSats).toBe(created.totalSats - 10_000);
      expect(r.data.next).toMatch(/short: artist:artist-7 0\/10000/);
      expect(r.data.payouts).toEqual([]);
    });

    it.each([
      ['bad txid', { txid: 'xyz' }, /txid/],
      ['no outputs', { outputs: [] }, /outputs/],
      ['bad script', { outputs: [{ scriptHex: 'zz', valueSats: 1 }] }, /scriptHex/],
      ['fractional value', { outputs: [{ scriptHex: '5120' + '00'.repeat(32), valueSats: 1.5 }] }, /valueSats/],
      ['negative confirmations', { confirmations: -1 }, /confirmations/],
      ['bad paymentId', { paymentId: 'nope' }, /paymentId/],
    ])('report_funding invalid_input: %s', async (_name, patch, msg) => {
      const r = await h.call<ErrBody>('report_funding', { orderId: created.orderId, txid: TXID, outputs: fundingOutputs(), ...patch });
      expect(r.isError).toBe(true);
      expect(['invalid_input', 'schema']).toContain(r.data.error?.code ?? 'schema');
      if (r.data.error) expect(r.data.error.message).toMatch(msg);
    });

    it('report_funding: unknown order, a payment of another order, and an order without a payment', async () => {
      const missing = await h.call<ErrBody>('report_funding', { orderId: 'ord_9999', txid: TXID, outputs: fundingOutputs() });
      expect(missing.data.error.code).toBe('order_not_found');
      const other = await h.call<CreateOrderResult>('create_order', { ...base(), recipientAddress: p2tr(9) });
      const mismatch = await h.call<ErrBody>('report_funding', { orderId: created.orderId, paymentId: other.data.paymentId, txid: TXID, outputs: fundingOutputs() });
      expect(mismatch.data.error.code).toBe('invalid_input');
      expect(mismatch.data.error.message).toMatch(/belongs to order/);
      const bare = { ...fake.orders.get(created.orderId)!, id: 'ord_bare', status: 'created' as const };
      fake.orders.set(bare.id, bare);
      const none = await h.call<ErrBody>('report_funding', { orderId: 'ord_bare', txid: TXID, outputs: fundingOutputs() });
      expect(none.data.error).toMatchObject({ code: 'ledger_rejected', details: { code: 'no_payment' } });
    });

    it('one transaction settles one intent: the fake enforces it like the ledger and the tool reports it', async () => {
      const outputs = fundingOutputs();
      await h.call('report_funding', { orderId: created.orderId, txid: TXID, outputs, confirmations: 1 });
      const other = await h.call<CreateOrderResult>('create_order', base()); // identical expected outputs
      const r = await h.call<ReportFundingResult>('report_funding', { orderId: other.data.orderId, txid: TXID, outputs, confirmations: 1 });
      expect(r.data.applied).toBe(false);
      expect(r.data.reason).toMatch(/already settles/);
    });
  });

  it('order tools are declared with the scopes and annotations the flow needs', () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    expect(byName.create_order!.scopes).toEqual(['mcp:order']);
    expect(byName.create_order!.annotations.readOnlyHint).toBe(false);
    expect(byName.report_funding!.scopes).toEqual(['mcp:order', 'mcp:settle']);
    expect(byName.get_order!.scopes).toEqual(['mcp:quote', 'mcp:order', 'mcp:settle']);
    expect(byName.get_receipt!.annotations.readOnlyHint).toBe(true);
  });
});
