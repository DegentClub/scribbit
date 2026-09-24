import { describe, expect, it } from 'vitest';
import {
  FakeProvider,
  LedgerWorker,
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  PsbtProvider,
  assertPayoutTransition,
  esploraScriptHash,
  evaluatePsbt,
  expectedOutputsFor,
  observedFromChainTx,
  scriptHexForAddress,
  type ChainTx,
  type ExpectedOutput,
  type ObservedTransaction,
  type Order,
  type OrderStore,
  type PaymentIntent,
  type Payout,
  type PsbtChainPort,
  type Receipt,
} from '../src/index.js';
import { expectContract } from './contract.js';
import { fakeClock, harness, orderBody } from './helpers.js';

// BIP173 / BIP350 test vectors (address ↔ scriptPubKey), so the address→script step is checked against known bytes.
const ARTIST_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ARTIST_SCRIPT = '0014751e76e8199196d454941c45d1b3a323f1433bd6';
const CLUB_ADDR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const CLUB_SCRIPT = '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const COMMIT_SCRIPT = '5120' + 'c0'.repeat(32);
const TXID = 'e'.repeat(64);
const now = new Date('2026-09-23T12:00:00Z');

/** degent open-studio mint: artist 10 %, club fee, and the mint's own (unique) commit output, all as payee line items. */
const mintItems = (commitScript = COMMIT_SCRIPT): Order['lineItems'] => [
  { sku: 'artist-share', description: 'Artist share (10%)', quantity: 1, unitSats: 1_000, payee: { kind: 'artist', ref: 'artist-7', address: ARTIST_ADDR } },
  { sku: 'club-fee', description: 'Club fee', quantity: 2, unitSats: 250, payee: { kind: 'club', ref: 'degent-club', address: CLUB_ADDR } },
  { sku: 'club-tip', description: 'Club tip', quantity: 1, unitSats: 100, payee: { kind: 'club', ref: 'degent-club', scriptHex: CLUB_SCRIPT.toUpperCase() } },
  { sku: 'commit', description: 'Inscription commit', quantity: 1, unitSats: 8_400, payee: { kind: 'platform', ref: 'commit', scriptHex: commitScript } },
];
const mintLineItems = mintItems();
const MINT_TOTAL = 1_000 + 500 + 100 + 8_400;
const order = (lineItems: Order['lineItems'] = mintLineItems): Pick<Order, 'lineItems'> => ({ lineItems });

const tx = (outputs: Array<[string, number]>, o: Partial<ObservedTransaction> = {}): ObservedTransaction => ({
  txid: TXID,
  outputs: outputs.map(([scriptHex, valueSats]) => ({ scriptHex, valueSats })),
  confirmations: 1,
  rbfSignalled: false,
  ...o,
});
const policy = { confirmations: 1 };

describe('expectedOutputsFor', () => {
  it('sums line items per payee SCRIPT (address and its own script are one key), in first-appearance order', () => {
    const outs = expectedOutputsFor(order(), 'mainnet');
    expect(outs).toEqual([
      { scriptHex: ARTIST_SCRIPT, valueSats: 1_000, address: ARTIST_ADDR, payee: { kind: 'artist', ref: 'artist-7', address: ARTIST_ADDR } },
      { scriptHex: CLUB_SCRIPT, valueSats: 600, address: CLUB_ADDR, payee: { kind: 'club', ref: 'degent-club', address: CLUB_ADDR } },
      { scriptHex: COMMIT_SCRIPT, valueSats: 8_400, payee: { kind: 'platform', ref: 'commit', scriptHex: COMMIT_SCRIPT } },
    ]);
    expect(outs.reduce((s, o) => s + o.valueSats, 0)).toBe(MINT_TOTAL);
  });

  it('skips line items without a payee and rejects addresses of another network', () => {
    expect(expectedOutputsFor(order([{ sku: 'x', description: 'x', quantity: 1, unitSats: 5 }]))).toEqual([]);
    expect(scriptHexForAddress(ARTIST_ADDR, 'mainnet')).toBe(ARTIST_SCRIPT);
    expect(() => scriptHexForAddress(ARTIST_ADDR, 'testnet')).toThrow(expect.objectContaining({ code: 'invalid_payee_address', status: 400 }));
    expect(() => expectedOutputsFor(order(), 'signet')).toThrow(/not valid on signet/);
    expect(() => scriptHexForAddress('not-an-address', 'mainnet')).toThrow(/not valid on mainnet/);
  });
});

describe('evaluatePsbt (scripts compared, never addresses)', () => {
  const expected: ExpectedOutput[] = expectedOutputsFor(order(), 'mainnet');
  const exact: Array<[string, number]> = [[COMMIT_SCRIPT, 8_400], [ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], ['0014' + '99'.repeat(20), 50_000]];

  it('paid when every expected output is present at or above its value; one payout per payee output', () => {
    const ev = evaluatePsbt({ expected, tx: tx(exact), policy, now })!;
    expect(ev).toMatchObject({ status: 'paid', amountPaidSats: 10_000, expectedSats: 10_000, observedSats: 10_000, txid: TXID, paidAt: now.toISOString() });
    expect(ev.payouts).toEqual([
      { payee: expected[0]!.payee, scriptHex: ARTIST_SCRIPT, amountSats: 1_000, txid: TXID, vout: 1 },
      { payee: expected[1]!.payee, scriptHex: CLUB_SCRIPT, amountSats: 600, txid: TXID, vout: 2 },
      { payee: expected[2]!.payee, scriptHex: COMMIT_SCRIPT, amountSats: 8_400, txid: TXID, vout: 0 },
    ]);
    expect(ev.settlements.map((s) => s.vouts)).toEqual([[1], [2], [0]]);
    // uppercase hex in the observed outputs still matches
    expect(evaluatePsbt({ expected, tx: tx(exact.map(([s, v]) => [s.toUpperCase(), v])), policy, now })?.status).toBe('paid');
    // more to a payee is still paid within the tolerance, overpaid beyond it
    const over = tx([[COMMIT_SCRIPT, 8_400], [ARTIST_SCRIPT, 1_500], [CLUB_SCRIPT, 600]]);
    expect(evaluatePsbt({ expected, tx: over, policy, now })).toMatchObject({ status: 'overpaid', amountPaidSats: 10_500 });
    expect(evaluatePsbt({ expected, tx: over, policy: { confirmations: 1, overpaymentToleranceSats: 500 }, now })?.status).toBe('paid');
    // several outputs to the same script are summed (payout records the first vout)
    const split = tx([[ARTIST_SCRIPT, 400], [COMMIT_SCRIPT, 8_400], [ARTIST_SCRIPT, 600], [CLUB_SCRIPT, 600]]);
    const evSplit = evaluatePsbt({ expected, tx: split, policy, now })!;
    expect(evSplit.status).toBe('paid');
    expect(evSplit.payouts![0]).toMatchObject({ scriptHex: ARTIST_SCRIPT, amountSats: 1_000, vout: 0 });
    expect(evSplit.settlements[0]!.vouts).toEqual([0, 2]);
  });

  it('underpaid when some outputs are short or missing (with what did arrive), never paid by address string', () => {
    const short = evaluatePsbt({ expected, tx: tx([[COMMIT_SCRIPT, 8_400], [ARTIST_SCRIPT, 999], [CLUB_SCRIPT, 600]]), policy, now })!;
    expect(short).toMatchObject({ status: 'underpaid', amountPaidSats: 9_999, txid: TXID });
    expect(short.detail).toMatch(/artist:artist-7 999\/1000/);
    expect(short.payouts!.map((p) => p.scriptHex)).toEqual([CLUB_SCRIPT, COMMIT_SCRIPT]);
    const missing = evaluatePsbt({ expected, tx: tx([[COMMIT_SCRIPT, 8_400], [CLUB_SCRIPT, 600]]), policy, now })!;
    expect(missing).toMatchObject({ status: 'underpaid', amountPaidSats: 9_000 });
    expect(missing.settlements[0]).toMatchObject({ observedSats: 0, vouts: [], satisfied: false });
    // the underpayment tolerance applies per output
    expect(evaluatePsbt({ expected, tx: tx([[COMMIT_SCRIPT, 8_400], [ARTIST_SCRIPT, 999], [CLUB_SCRIPT, 600]]), policy: { confirmations: 1, underpaymentToleranceSats: 1 }, now })?.status).toBe('paid');
    // a transaction that pays none of the scripts is not ours
    expect(evaluatePsbt({ expected, tx: tx([['0014' + '99'.repeat(20), 10_000]]), policy, now })).toBeUndefined();
    expect(() => evaluatePsbt({ expected, tx: tx(exact, { txid: 'nope' }), policy, now })).toThrow(/txid/);
    expect(() => evaluatePsbt({ expected: [], tx: tx(exact), policy, now })).toThrow(/expected/);
  });

  it('pending while replaceable or below the confirmation depth; nothing credited and no payouts yet', () => {
    const rbf = evaluatePsbt({ expected, tx: tx(exact, { confirmations: 0, rbfSignalled: true }), policy: { confirmations: 0 }, now })!;
    expect(rbf).toMatchObject({ status: 'pending', amountPaidSats: 0, detail: 'replaceable transaction seen' });
    expect(rbf.payouts).toBeUndefined();
    expect(evaluatePsbt({ expected, tx: tx(exact, { confirmations: 0 }), policy: { confirmations: 0 }, now })?.status).toBe('paid'); // final, 0-conf policy
    expect(evaluatePsbt({ expected, tx: tx(exact, { confirmations: 2 }), policy: { confirmations: 3 }, now })).toMatchObject({ status: 'pending', detail: 'awaiting confirmations' });
    expect(evaluatePsbt({ expected, tx: tx(exact, { confirmations: 3, rbfSignalled: true }), policy: { confirmations: 3 }, now })?.status).toBe('paid'); // mined: RBF flag irrelevant
  });
});

describe('payout state table', () => {
  it('pending → settled | failed; settled and failed are terminal', () => {
    expect(Object.keys(PAYOUT_TRANSITIONS).sort()).toEqual([...PAYOUT_STATUSES].sort());
    expect(() => assertPayoutTransition('pending', 'settled')).not.toThrow();
    expect(() => assertPayoutTransition('settled', 'failed')).toThrow(/settled to failed/);
    expect(PAYOUT_TRANSITIONS.failed).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------ provider + service over HTTP

const ctxDegent = { product: 'degent' as const };

describe('psbt payments end to end: order with payees → checkout outputs → observed tx → paid → payouts → events → receipt', () => {
  it('runs the open-studio mint flow', async () => {
    const clock = fakeClock();
    const psbt = new PsbtProvider({ network: 'mainnet', policy: { confirmations: 1 }, expiryMinutes: 30 });
    const h = harness({ providers: [psbt, new FakeProvider()], clock });
    await h.ready;

    const order = (await expectContract(await h.req('/v1/orders', { method: 'POST', key: h.keys.degent, json: orderBody({ product: 'degent', customerRef: 'minter-1', lineItems: mintLineItems }) }), '/v1/orders', 'post', 201)) as Order;
    expect(order.totalSats).toBe(MINT_TOTAL);

    // the product asks for a psbt intent and receives the outputs its PSBT must carry
    const p = (await expectContract(await h.req(`/v1/orders/${order.id}/payments`, { method: 'POST', key: h.keys.degent, json: { method: 'psbt' } }), '/v1/orders/{id}/payments', 'post', 201)) as PaymentIntent;
    expect(p).toMatchObject({ method: 'psbt', provider: 'psbt', providerRef: p.id, status: 'created', amountSats: MINT_TOTAL, expiresAt: new Date(clock.now().getTime() + 30 * 60_000).toISOString() });
    expect(p.checkout.outputs!.map((o) => [o.scriptHex, o.valueSats, o.payee.ref])).toEqual([
      [ARTIST_SCRIPT, 1_000, 'artist-7'],
      [CLUB_SCRIPT, 600, 'degent-club'],
      [COMMIT_SCRIPT, 8_400, 'commit'],
    ]);
    expect(p.providerData).toMatchObject({ network: 'mainnet', expectedOutputs: p.checkout.outputs });
    expect(JSON.stringify(p)).not.toMatch(/xprv|privateKey|psbtBase64/); // nothing to sign lives here

    // a line item without a payee cannot be paid by psbt
    const partial = (await (await h.req('/v1/orders', { method: 'POST', key: h.keys.degent, json: orderBody({ product: 'degent', lineItems: [mintLineItems[0], { sku: 'mint', description: 'Mint', quantity: 1, unitSats: 9_000 }] }) })).json()) as Order;
    const refused = await h.req(`/v1/orders/${partial.id}/payments`, { method: 'POST', key: h.keys.degent, json: { method: 'psbt' } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatchObject({ code: 'payee_required', message: expect.stringMatching(/mint/) });
    expect((await h.service.getOrder(partial.id, ctxDegent)).status).toBe('created'); // no intent was opened

    // the minter signs the product's PSBT; the product observes the broadcast transaction and reports it
    const observed = tx([[COMMIT_SCRIPT, 8_400], ['0014' + '77'.repeat(20), 40_000], [ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600]], { confirmations: 0 });
    const seen = await h.service.applyUpdate(p.id, psbt.evaluate(p, observed, clock.now())!, 'product report');
    expect(seen.payment.status).toBe('pending');
    expect(await h.service.listPayouts(order.id, ctxDegent)).toEqual([]); // nothing until paid
    clock.tick(600_000);
    const paid = await h.service.applyUpdate(p.id, psbt.evaluate(p, { ...observed, confirmations: 1 }, clock.now())!, 'product report');
    expect(paid.payment).toMatchObject({ status: 'paid', amountPaidSats: MINT_TOTAL, txid: TXID, paidAt: clock.now().toISOString() });
    expect(paid.order.status).toBe('paid');
    expect(paid.payment.providerData).toMatchObject({ observedTxid: TXID, confirmations: 1, expectedSats: MINT_TOTAL, observedSats: MINT_TOTAL });

    // one payout per payee output, recorded (not moved) by the ledger
    const payouts = (await expectContract(await h.req(`/v1/orders/${order.id}/payouts`, { key: h.keys.degent }), '/v1/orders/{id}/payouts', 'get', 200)) as { payouts: Payout[] };
    expect(payouts.payouts.map((x) => [x.payee.kind, x.payee.ref, x.amountSats, x.vout, x.status])).toEqual([
      ['artist', 'artist-7', 1_000, 2, 'settled'],
      ['club', 'degent-club', 600, 3, 'settled'],
      ['platform', 'commit', 8_400, 0, 'settled'],
    ]);
    const artist = payouts.payouts[0]!;
    expect(artist).toMatchObject({ orderId: order.id, paymentId: p.id, product: 'degent', txid: TXID, settledAt: clock.now().toISOString(), payee: { address: ARTIST_ADDR } });
    expect(artist.id).toMatch(/^pyo_/);
    // by payee, scoped to the caller's product; admin sees it too; another product does not
    const byPayee = (await expectContract(await h.req('/v1/payees/artist-7/payouts', { key: h.keys.degent }), '/v1/payees/{ref}/payouts', 'get', 200)) as { payouts: Payout[] };
    expect(byPayee.payouts.map((x) => x.id)).toEqual([artist.id]);
    expect(((await (await h.req('/v1/payees/artist-7/payouts', { key: h.keys.admin })).json()) as { payouts: Payout[] }).payouts).toHaveLength(1);
    expect(((await (await h.req('/v1/payees/artist-7/payouts', { key: h.keys.scribbit })).json()) as { payouts: Payout[] }).payouts).toEqual([]);
    expect(((await (await h.req('/v1/payees/degent-club/payouts?kind=club', { key: h.keys.degent })).json()) as { payouts: Payout[] }).payouts).toHaveLength(1);
    expect(((await (await h.req('/v1/payees/degent-club/payouts?kind=artist', { key: h.keys.degent })).json()) as { payouts: Payout[] }).payouts).toEqual([]);

    // events: payment.paid, then one payout.settled per payee output, then order.paid
    expect(h.events.map((e) => e.type)).toEqual([
      'ledger.order.created',
      'ledger.order.awaiting_payment',
      'ledger.payment.created',
      'ledger.order.created',
      'ledger.payment.pending',
      'ledger.payment.paid',
      'ledger.payout.settled',
      'ledger.payout.settled',
      'ledger.payout.settled',
      'ledger.order.paid',
    ]);
    const payoutEvent = h.events.find((e) => e.type === 'ledger.payout.settled')!;
    expect(payoutEvent).toMatchObject({ source: 'urn:bsh:ledger', subject: order.id });
    expect(payoutEvent.dataschema).toMatch(/platform-events\.yaml#\/components\/schemas\/LedgerPayoutStatusChanged$/);
    expect(payoutEvent.data).toEqual({
      payoutId: artist.id,
      orderId: order.id,
      paymentId: p.id,
      product: 'degent',
      payee: { kind: 'artist', ref: 'artist-7', address: ARTIST_ADDR },
      amountSats: 1_000,
      txid: TXID,
      vout: 2,
      status: 'settled',
      at: clock.now().toISOString(),
    });
    expect(h.events.find((e) => e.type === 'ledger.payment.paid')!.data).toMatchObject({ method: 'psbt', provider: 'psbt', txid: TXID });

    // re-reporting the same transaction is a no-op: no duplicate payouts, no new events
    const again = await h.service.applyUpdate(p.id, psbt.evaluate(p, { ...observed, confirmations: 2 }, clock.now())!, 'product report');
    expect(again.applied).toBe(false);
    expect(await h.service.listPayouts(order.id, ctxDegent)).toHaveLength(3);
    expect(h.events.filter((e) => e.type.startsWith('ledger.payout.'))).toHaveLength(3);

    // receipt carries the payouts (JSON per contract, and in the text rendering)
    const receipt = (await expectContract(await h.req(`/v1/orders/${order.id}/receipt`, { key: h.keys.degent }), '/v1/orders/{id}/receipt', 'get', 200)) as Receipt;
    expect(receipt.payments[0]).toMatchObject({ method: 'psbt', provider: 'psbt', status: 'paid', reference: p.id, txid: TXID });
    expect(receipt.payouts.map((x) => [x.payee.ref, x.amountSats, `${x.txid}:${x.vout}`])).toEqual([
      ['artist-7', 1_000, `${TXID}:2`],
      ['degent-club', 600, `${TXID}:3`],
      ['commit', 8_400, `${TXID}:0`],
    ]);
    expect(receipt.totals).toEqual({ totalSats: MINT_TOTAL, paidSats: MINT_TOTAL, refundedSats: 0, dueSats: 0 });
    const text = await (await h.req(`/v1/orders/${order.id}/receipt?format=text`, { key: h.keys.degent })).text();
    expect(text).toContain('Payouts');
    expect(text).toContain(`${artist.id}  settled  1,000 sat (0.00001000 BTC)  to artist:artist-7`);
    expect(text).toContain(`    txid ${TXID}:2`);
    expect(text.split('\n').every((l) => l.length <= 100 && /^[\x20-\x7e]*$/.test(l))).toBe(true);

    // refunds of psbt payments are manual payouts: destination required, then pending until settled
    const noDest = (await (await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.degent, json: { reason: 'oops', amountSats: 100 } })).json()) as { status: string; detail: string };
    expect(noDest).toMatchObject({ status: 'failed', detail: expect.stringMatching(/destination/) });
    const refund = (await (await h.req(`/v1/payments/${p.id}/refund`, { method: 'POST', key: h.keys.degent, json: { reason: 'oops', amountSats: 100, destination: 'bc1qminter' } })).json()) as { status: string; version: number };
    expect(refund).toMatchObject({ status: 'pending', version: 1 });
  });

  it('underpaid stays underpaid; a second, complete transaction settles it and records payouts once', async () => {
    const clock = fakeClock();
    const psbt = new PsbtProvider({ network: 'mainnet', policy: { confirmations: 1 } });
    const h = harness({ providers: [psbt], clock });
    const o = (await h.service.createOrder({ product: 'degent', customerRef: 'c', lineItems: mintLineItems }, ctxDegent)).order;
    const p = (await h.service.createPayment(o.id, { method: 'psbt' }, ctxDegent)).payment;
    const short = await h.service.applyUpdate(p.id, psbt.evaluate(p, tx([[COMMIT_SCRIPT, 8_400], [CLUB_SCRIPT, 600]]), clock.now())!);
    expect(short.payment).toMatchObject({ status: 'underpaid', amountPaidSats: 9_000, txid: TXID });
    expect(await h.service.listPayouts(o.id, ctxDegent)).toEqual([]);
    expect((await h.service.getOrder(o.id, ctxDegent)).status).toBe('awaiting_payment');
    const full = await h.service.applyUpdate(p.id, psbt.evaluate(p, tx([[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_SCRIPT, 8_400]], { txid: 'f'.repeat(64) }), clock.now())!);
    expect(full.payment).toMatchObject({ status: 'paid', amountPaidSats: MINT_TOTAL, txid: 'f'.repeat(64) });
    expect((await h.service.listPayouts(o.id, ctxDegent)).map((x) => `${x.txid.slice(0, 1)}:${x.vout}`)).toEqual(['f:0', 'f:1', 'f:2']);
  });
});

// ------------------------------------------------------------------------------------------ worker with a fake chain (scripthash lookups)

class FakeScriptChain implements PsbtChainPort {
  tip = 100;
  readonly txs: ChainTx[] = [];
  readonly lookups: string[] = [];
  async tipHeight(): Promise<number> {
    return this.tip;
  }
  async scriptTxs(scriptHex: string): Promise<ChainTx[]> {
    this.lookups.push(scriptHex);
    return this.txs.filter((t) => t.vout.some((o) => o.scriptpubkey === scriptHex));
  }
  broadcast(txid: string, outputs: Array<[string, number]>, o: { height?: number; seq?: number } = {}): ChainTx {
    const t: ChainTx = {
      txid,
      vin: [{ sequence: o.seq ?? 0xffffffff }],
      vout: outputs.map(([scriptpubkey, value]) => ({ scriptpubkey, value })),
      status: o.height !== undefined ? { confirmed: true, block_height: o.height } : { confirmed: false },
    };
    this.txs.push(t);
    return t;
  }
  mine(): void {
    this.tip += 1;
    for (const t of this.txs) if (!t.status.confirmed) t.status = { confirmed: true, block_height: this.tip };
  }
}

describe('PsbtProvider.poll through a chain backend + LedgerWorker', () => {
  function setup(confirmations = 1, withStore = true) {
    const clock = fakeClock();
    const chain = new FakeScriptChain();
    const late: { store?: OrderStore } = {};
    const store = { findPaymentsByTxid: (txid: string) => late.store!.findPaymentsByTxid(txid) };
    const psbt = new PsbtProvider({ network: 'mainnet', policy: { confirmations }, chain, expiryMinutes: 30, ...(withStore ? { store } : {}) });
    const h = harness({ providers: [psbt], clock });
    late.store = h.store;
    const worker = new LedgerWorker({ service: h.service, store: h.store, providers: [psbt], now: clock.now, onError: (e) => { throw e; } });
    const mk = async (commitScript = COMMIT_SCRIPT) => {
      const o = (await h.service.createOrder({ product: 'degent', customerRef: 'c', lineItems: mintItems(commitScript) }, ctxDegent)).order;
      return (await h.service.createPayment(o.id, { method: 'psbt' }, ctxDegent)).payment;
    };
    return { clock, chain, psbt, h, worker, mk };
  }
  const COMMIT_2 = '5120' + 'c2'.repeat(32);

  it('finds the settling transaction by payee script, waits for depth, records payouts; ignores RBF until mined', async () => {
    const { clock, chain, h, worker, mk } = setup(2);
    const p = await mk();
    expect(await worker.tick()).toEqual({ polled: 1, applied: 0, errors: 0 });
    expect(chain.lookups).toEqual([ARTIST_SCRIPT]); // the first expected output's script is the lookup key
    // a replaceable transaction in the mempool is seen but not credited
    chain.broadcast('a'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_SCRIPT, 8_400]], { seq: 0xfffffffd });
    expect(await worker.tick()).toMatchObject({ applied: 1 });
    expect(await h.service.getPayment(p.id, ctxDegent)).toMatchObject({ status: 'pending', amountPaidSats: 0 });
    chain.mine(); // 1 conf, policy needs 2
    await worker.tick();
    expect((await h.service.getPayment(p.id, ctxDegent)).status).toBe('pending');
    chain.mine();
    expect(await worker.tick()).toMatchObject({ applied: 1 });
    const paid = await h.service.getPayment(p.id, ctxDegent);
    expect(paid).toMatchObject({ status: 'paid', amountPaidSats: MINT_TOTAL, txid: 'a'.repeat(64), paidAt: clock.now().toISOString() });
    expect((await h.service.listPayouts(p.orderId, ctxDegent)).map((x) => x.payee.ref)).toEqual(['artist-7', 'degent-club', 'commit']);
    expect(await worker.tick()).toMatchObject({ applied: 0, errors: 0 }); // idempotent
  });

  it('prefers the best candidate among several transactions to the same script', async () => {
    const { chain, h, worker, mk } = setup(1);
    const p = await mk();
    chain.broadcast('b'.repeat(64), [[ARTIST_SCRIPT, 1_000]], { height: 101 }); // someone tipped the artist: underpaid for us
    chain.broadcast('c'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_SCRIPT, 8_400]], { height: 101 });
    chain.tip = 101;
    await worker.tick();
    expect(await h.service.getPayment(p.id, ctxDegent)).toMatchObject({ status: 'paid', txid: 'c'.repeat(64) });
  });

  it('expires untouched intents and still credits a late payment (expired → paid)', async () => {
    const { clock, chain, h, worker, mk } = setup(1);
    const p = await mk();
    clock.tick(31 * 60_000);
    await worker.tick();
    expect((await h.service.getPayment(p.id, ctxDegent)).status).toBe('expired');
    expect((await h.service.getOrder(p.orderId, ctxDegent)).status).toBe('awaiting_payment');
    chain.broadcast('d'.repeat(64), [[COMMIT_SCRIPT, 8_400], [ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600]], { height: 101 });
    chain.tip = 101;
    await worker.tick();
    expect((await h.service.getPayment(p.id, ctxDegent)).status).toBe('paid');
    expect((await h.service.getOrder(p.orderId, ctxDegent)).status).toBe('paid');
    // a pending (replaceable) intent whose transaction vanished expires too
    const p2 = await mk(COMMIT_2);
    const rbf = chain.broadcast('e'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_2, 8_400]], { seq: 0xfffffffd });
    await worker.tick();
    expect((await h.service.getPayment(p2.id, ctxDegent)).status).toBe('pending');
    chain.txs.splice(chain.txs.indexOf(rbf), 1);
    clock.tick(31 * 60_000);
    await worker.tick();
    expect((await h.service.getPayment(p2.id, ctxDegent)).status).toBe('expired');
  });

  it('one transaction settles at most one intent, even when two orders expect identical outputs', async () => {
    const { chain, h, worker, mk } = setup(1);
    const p0 = await mk('5120' + 'c0'.repeat(31) + 'ff'); // a different mint: its own commit output
    chain.broadcast('9'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], ['5120' + 'c0'.repeat(31) + 'ff', 8_400]], { height: 100 });
    await worker.tick();
    expect((await h.service.getPayment(p0.id, ctxDegent)).status).toBe('paid');
    const p1 = await mk();
    const p2 = await mk(); // same artist, club and (here) commit script: indistinguishable by outputs
    chain.broadcast('a'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_SCRIPT, 8_400]], { height: 101 });
    chain.tip = 101;
    expect(await worker.tick()).toEqual({ polled: 2, applied: 1, errors: 0 });
    expect((await h.service.getPayment(p1.id, ctxDegent)).status).toBe('paid');
    expect((await h.service.getPayment(p2.id, ctxDegent)).status).toBe('created');
    expect(await h.service.listPayouts(p2.orderId, ctxDegent)).toEqual([]);
    const direct = await h.service.applyUpdate(p2.id, { status: 'paid', amountPaidSats: MINT_TOTAL, txid: 'a'.repeat(64) });
    expect(direct).toMatchObject({ applied: false, reason: expect.stringMatching(new RegExp(`already settles ${p1.id}`)) });
    // a second transaction with its own txid settles the second intent
    chain.broadcast('b'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_SCRIPT, 8_400]], { height: 101 });
    await worker.tick();
    expect((await h.service.getPayment(p2.id, ctxDegent))).toMatchObject({ status: 'paid', txid: 'b'.repeat(64) });
    expect(await h.service.listPayouts(p2.orderId, ctxDegent)).toHaveLength(3);
  });

  it('without the store port the provider may propose a claimed txid; the service still refuses to double-credit', async () => {
    const { chain, h, worker, mk } = setup(1, false);
    const p1 = await mk();
    const p2 = await mk();
    chain.broadcast('a'.repeat(64), [[ARTIST_SCRIPT, 1_000], [CLUB_SCRIPT, 600], [COMMIT_SCRIPT, 8_400]], { height: 101 });
    chain.tip = 101;
    expect(await worker.tick()).toEqual({ polled: 2, applied: 1, errors: 0 });
    expect((await h.service.getPayment(p1.id, ctxDegent)).status).toBe('paid');
    expect((await h.service.getPayment(p2.id, ctxDegent)).status).toBe('created');
    expect(await h.service.listPayouts(p2.orderId, ctxDegent)).toEqual([]);
  });

  it('without a chain backend poll reports nothing (the product reports the transaction)', async () => {
    const clock = fakeClock();
    const psbt = new PsbtProvider({ network: 'mainnet', policy: { confirmations: 1 } });
    const h = harness({ providers: [psbt], clock });
    const o = (await h.service.createOrder({ product: 'degent', customerRef: 'c', lineItems: mintLineItems }, ctxDegent)).order;
    const p = (await h.service.createPayment(o.id, { method: 'psbt' }, ctxDegent)).payment;
    expect(await psbt.poll(p, clock.now())).toBeUndefined();
    const worker = new LedgerWorker({ service: h.service, store: h.store, providers: [psbt], now: clock.now });
    clock.tick(61 * 60_000);
    await worker.tick(); // the worker still expires a `created` intent past its expiry
    expect((await h.service.getPayment(p.id, ctxDegent)).status).toBe('expired');
  });

  it('maps esplora transactions to observations and scripthash lookups use sha256(script) in natural order', () => {
    const t: ChainTx = { txid: TXID, vin: [{ sequence: 0xfffffffd }], vout: [{ scriptpubkey: ARTIST_SCRIPT.toUpperCase(), value: 5 }, { value: 6 }], status: { confirmed: false } };
    expect(observedFromChainTx(t, 100)).toEqual({ txid: TXID, outputs: [{ scriptHex: ARTIST_SCRIPT, valueSats: 5 }, { scriptHex: '', valueSats: 6 }], confirmations: 0, rbfSignalled: true });
    expect(observedFromChainTx({ ...t, status: { confirmed: true, block_height: 98 } }, 100)).toMatchObject({ confirmations: 3, rbfSignalled: false });
    // sha256(0014751e...) — natural byte order, unlike Electrum's reversed convention
    expect(esploraScriptHash(ARTIST_SCRIPT)).toMatch(/^[0-9a-f]{64}$/);
    expect(esploraScriptHash(ARTIST_SCRIPT)).toBe(esploraScriptHash(ARTIST_SCRIPT.toUpperCase()));
    expect(esploraScriptHash(ARTIST_SCRIPT)).not.toBe(esploraScriptHash(CLUB_SCRIPT));
  });
});
