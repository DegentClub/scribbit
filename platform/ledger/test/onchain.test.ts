import { HDKey } from '@scure/bip32';
import { describe, expect, it } from 'vitest';
import {
  EsploraChain,
  FakeProvider,
  LedgerService,
  LedgerWorker,
  MemoryOrderStore,
  OnchainAddressProvider,
  evaluateOnchain,
  isReplaceable,
  type ChainPort,
  type ChainTx,
} from '../src/index.js';
import { fakeClock, json, seqIds } from './helpers.js';

const ADDR = 'bc1qaddr';
const FINAL = 0xffffffff;
const RBF = 0xfffffffd;
const tx = (id: string, value: number, o: { height?: number; seq?: number; to?: string } = {}): ChainTx => ({
  txid: id.padEnd(64, '0'),
  vin: [{ sequence: o.seq ?? FINAL }],
  vout: [
    { scriptpubkey_address: o.to ?? ADDR, value },
    { scriptpubkey_address: 'bc1qchange', value: 999 },
  ],
  status: o.height !== undefined ? { confirmed: true, block_height: o.height } : { confirmed: false },
});
const now = new Date('2026-09-23T12:00:00Z');
const base = { address: ADDR, amountSats: 10_000, expiresAt: '2026-09-23T13:00:00Z', now };

describe('evaluateOnchain (confirmation policy, under/over, RBF)', () => {
  it('nothing received: undefined before expiry, expired after', () => {
    expect(evaluateOnchain({ ...base, txs: [], tipHeight: 100, policy: { confirmations: 1 } })).toBeUndefined();
    expect(evaluateOnchain({ ...base, txs: [], tipHeight: 100, policy: { confirmations: 1 }, now: new Date('2026-09-23T13:00:00Z') })?.status).toBe('expired');
    // outputs to other addresses do not count
    expect(evaluateOnchain({ ...base, txs: [tx('a', 10_000, { height: 100, to: 'bc1qother' })], tipHeight: 100, policy: { confirmations: 1 } })).toBeUndefined();
  });

  it('exact payment: pending until the confirmation depth, then paid', () => {
    const txs = [tx('a', 10_000, { height: 100 })];
    const p3 = { confirmations: 3 };
    expect(evaluateOnchain({ ...base, txs, tipHeight: 100, policy: p3 })).toMatchObject({ status: 'pending', amountPaidSats: 0, awaitingSats: 10_000 });
    expect(evaluateOnchain({ ...base, txs, tipHeight: 101, policy: p3 })?.status).toBe('pending');
    const paid = evaluateOnchain({ ...base, txs, tipHeight: 102, policy: p3 });
    expect(paid).toMatchObject({ status: 'paid', amountPaidSats: 10_000, creditedSats: 10_000, paidAt: now.toISOString() });
    expect(paid?.txid).toBe('a'.padEnd(64, '0'));
  });

  it('unconfirmed: unreplaceable counts under a 0-conf policy, RBF-signalling never counts', () => {
    const finalTx = [tx('a', 10_000)];
    expect(isReplaceable(finalTx[0]!)).toBe(false);
    expect(evaluateOnchain({ ...base, txs: finalTx, tipHeight: 100, policy: { confirmations: 0 } })?.status).toBe('paid');
    expect(evaluateOnchain({ ...base, txs: finalTx, tipHeight: 100, policy: { confirmations: 1 } })?.status).toBe('pending');

    const rbfTx = [tx('b', 10_000, { seq: RBF })];
    expect(isReplaceable(rbfTx[0]!)).toBe(true);
    const ev = evaluateOnchain({ ...base, txs: rbfTx, tipHeight: 100, policy: { confirmations: 0 } });
    expect(ev).toMatchObject({ status: 'pending', amountPaidSats: 0, replaceableSats: 10_000, detail: 'replaceable transaction seen' });
    // once mined it counts regardless of the sequence field
    expect(evaluateOnchain({ ...base, txs: [tx('b', 10_000, { seq: RBF, height: 100 })], tipHeight: 100, policy: { confirmations: 1 } })?.status).toBe('paid');
    // sequence 0xfffffffe is final (not replaceable)
    expect(isReplaceable(tx('c', 1, { seq: 0xfffffffe }))).toBe(false);
  });

  it('underpayment: confirmed partial funds → underpaid; a top-up completes it', () => {
    const p1 = { confirmations: 1 };
    const partial = [tx('a', 6_000, { height: 100 })];
    expect(evaluateOnchain({ ...base, txs: partial, tipHeight: 100, policy: p1 })).toMatchObject({ status: 'underpaid', amountPaidSats: 6_000 });
    const topped = [...partial, tx('b', 4_000)];
    expect(evaluateOnchain({ ...base, txs: topped, tipHeight: 100, policy: p1 })).toMatchObject({ status: 'pending', amountPaidSats: 6_000 });
    expect(evaluateOnchain({ ...base, txs: [...partial, tx('b', 4_000, { height: 101 })], tipHeight: 101, policy: p1 })).toMatchObject({ status: 'paid', amountPaidSats: 10_000 });
    // underpaid money is never "expired" away
    expect(evaluateOnchain({ ...base, txs: partial, tipHeight: 100, policy: p1, now: new Date('2026-09-24T00:00:00Z') })?.status).toBe('underpaid');
  });

  it('overpayment and tolerances', () => {
    const p1 = { confirmations: 1 };
    expect(evaluateOnchain({ ...base, txs: [tx('a', 12_000, { height: 100 })], tipHeight: 100, policy: p1 })).toMatchObject({ status: 'overpaid', amountPaidSats: 12_000 });
    expect(evaluateOnchain({ ...base, txs: [tx('a', 10_001, { height: 100 })], tipHeight: 100, policy: p1 })?.status).toBe('overpaid');
    expect(evaluateOnchain({ ...base, txs: [tx('a', 10_001, { height: 100 })], tipHeight: 100, policy: { ...p1, overpaymentToleranceSats: 10 } })?.status).toBe('paid');
    expect(evaluateOnchain({ ...base, txs: [tx('a', 9_995, { height: 100 })], tipHeight: 100, policy: p1 })?.status).toBe('underpaid');
    expect(evaluateOnchain({ ...base, txs: [tx('a', 9_995, { height: 100 })], tipHeight: 100, policy: { ...p1, underpaymentToleranceSats: 10 } })).toMatchObject({ status: 'paid', amountPaidSats: 9_995 });
  });
});

// ------------------------------------------------------------------------------------------ provider + worker with a fake chain

class FakeChain implements ChainPort {
  tip = 100;
  readonly txs = new Map<string, ChainTx[]>();
  async tipHeight(): Promise<number> {
    return this.tip;
  }
  async addressTxs(address: string): Promise<ChainTx[]> {
    return this.txs.get(address) ?? [];
  }
  pay(address: string, txid: string, value: number, o: { height?: number; seq?: number } = {}): void {
    this.txs.set(address, [...(this.txs.get(address) ?? []), tx(txid, value, { ...o, to: address })]);
  }
  mine(n = 1): void {
    this.tip += n;
    for (const list of this.txs.values()) for (const t of list) if (!t.status.confirmed) t.status = { confirmed: true, block_height: this.tip };
  }
}

const XPUB = HDKey.fromMasterSeed(new Uint8Array(64).fill(7)).derive("m/84'/0'/0'").publicExtendedKey;

function setup(confirmations = 1) {
  const clock = fakeClock();
  const store = new MemoryOrderStore();
  const chain = new FakeChain();
  const onchain = new OnchainAddressProvider({ xpub: XPUB, network: 'mainnet', addressType: 'p2wpkh', chain, store, policy: { confirmations }, expiryMinutes: 30 });
  const providers = [onchain, new FakeProvider()];
  const service = new LedgerService({ store, providers, now: clock.now, newId: seqIds() });
  const worker = new LedgerWorker({ service, store, providers, now: clock.now, onError: (e) => { throw e; } });
  return { clock, store, chain, onchain, service, worker };
}
const ctx = { product: 'degent' as const };
const lineItems = [{ sku: 's', description: 'd', quantity: 1, unitSats: 10_000 }];

describe('OnchainAddressProvider + worker', () => {
  it('hands out fresh addresses per intent and watches them to paid', async () => {
    const { clock, chain, onchain, service, worker } = setup(2);
    const o1 = (await service.createOrder({ product: 'degent', customerRef: 'c', lineItems }, ctx)).order;
    const o2 = (await service.createOrder({ product: 'degent', customerRef: 'c', lineItems }, ctx)).order;
    const p1 = (await service.createPayment(o1.id, { method: 'onchain' }, ctx)).payment;
    const p2 = (await service.createPayment(o2.id, { method: 'onchain' }, ctx)).payment;
    expect(p1.checkout.address).toBe(onchain.addressAt(0));
    expect(p2.checkout.address).toBe(onchain.addressAt(1));
    expect(p1.providerRef).toBe(p1.checkout.address);
    expect(p1.expiresAt).toBe(new Date(clock.now().getTime() + 30 * 60_000).toISOString());
    expect(p1.providerData).toEqual({ addressIndex: 0, network: 'mainnet' });

    expect(await worker.tick()).toEqual({ polled: 2, applied: 0, errors: 0 });
    chain.pay(p1.checkout.address!, 'aa', 10_000);
    expect(await worker.tick()).toMatchObject({ applied: 1 });
    expect((await service.getPayment(p1.id, ctx)).status).toBe('pending');
    chain.mine(); // 1 conf
    await worker.tick();
    expect((await service.getPayment(p1.id, ctx)).status).toBe('pending');
    chain.mine(); // 2 confs
    await worker.tick();
    const paid = await service.getPayment(p1.id, ctx);
    expect(paid).toMatchObject({ status: 'paid', amountPaidSats: 10_000, txid: 'aa'.padEnd(64, '0'), paidAt: clock.now().toISOString() });
    expect((await service.getOrder(o1.id, ctx)).status).toBe('paid');
    expect((await service.getOrder(o2.id, ctx)).status).toBe('awaiting_payment');
    // idempotent: another tick changes nothing
    expect(await worker.tick()).toMatchObject({ applied: 0, errors: 0 });
  });

  it('expires untouched intents, still credits a late payment, and handles under/over', async () => {
    const { clock, chain, service, worker } = setup(1);
    const mk = async () => {
      const o = (await service.createOrder({ product: 'degent', customerRef: 'c', lineItems }, ctx)).order;
      return (await service.createPayment(o.id, { method: 'onchain' }, ctx)).payment;
    };
    const late = await mk();
    const under = await mk();
    const over = await mk();
    clock.tick(31 * 60_000);
    await worker.tick();
    expect((await service.getPayment(late.id, ctx)).status).toBe('expired');
    // late payment: expired -> paid
    chain.pay(late.checkout.address!, 'bb', 10_000, { height: 101 });
    chain.tip = 101;
    chain.pay(under.checkout.address!, 'cc', 4_000, { height: 101 });
    chain.pay(over.checkout.address!, 'dd', 15_000, { height: 101 });
    await worker.tick();
    expect((await service.getPayment(late.id, ctx)).status).toBe('paid');
    expect((await service.getPayment(under.id, ctx))).toMatchObject({ status: 'underpaid', amountPaidSats: 4_000 });
    expect((await service.getPayment(over.id, ctx))).toMatchObject({ status: 'overpaid', amountPaidSats: 15_000 });
    expect((await service.getOrder(over.orderId, ctx)).status).toBe('paid');
    // a refund of the excess defaults to 5_000 and needs a destination (manual payout)
    await expect(service.refund(over.id, { reason: 'overpayment' }, ctx)).resolves.toMatchObject({
      refund: { amountSats: 5_000, status: 'failed', detail: expect.stringMatching(/destination/) },
    });
    const r = await service.refund(over.id, { reason: 'overpayment', destination: 'bc1qcustomer' }, ctx);
    expect(r.refund).toMatchObject({ amountSats: 5_000, status: 'pending', destination: 'bc1qcustomer' });
    await service.settleRefund(r.refund.id, 'completed', 'payout txid …');
    expect((await service.getPayment(over.id, ctx))).toMatchObject({ status: 'overpaid', refundedSats: 5_000 });
    // top-up completes the underpaid one
    chain.pay(under.checkout.address!, 'ee', 6_000, { height: 101 });
    await worker.tick();
    expect((await service.getPayment(under.id, ctx))).toMatchObject({ status: 'paid', amountPaidSats: 10_000 });
    // the expired intent stops being polled after the grace window
    clock.tick(25 * 3_600_000);
    const fresh = await mk();
    clock.tick(31 * 60_000);
    await worker.tick();
    expect((await service.getPayment(fresh.id, ctx)).status).toBe('expired');
    clock.tick(25 * 3_600_000);
    expect((await worker.tick()).polled).toBe(0);
  });

  it('a poll failure is counted and does not stop the tick', async () => {
    const { chain, service, store } = setup(1);
    const o = (await service.createOrder({ product: 'degent', customerRef: 'c', lineItems }, ctx)).order;
    await service.createPayment(o.id, { method: 'onchain' }, ctx);
    chain.tipHeight = async () => {
      throw new Error('esplora down');
    };
    const errors: unknown[] = [];
    const w = new LedgerWorker({ service, store, providers: [service.provider('onchain')!], onError: (e) => errors.push(e) });
    expect(await w.tick()).toEqual({ polled: 1, applied: 0, errors: 1 });
    expect(String(errors[0])).toMatch(/esplora down/);
  });
});

describe('EsploraChain', () => {
  it('speaks the esplora REST shape', async () => {
    const calls: string[] = [];
    const chain = new EsploraChain('https://esplora.test/api/', async (url) => {
      calls.push(url);
      if (url.endsWith('/blocks/tip/height')) return new Response('912345');
      if (url.includes('/address/bc1q%2Fx/txs')) return json([tx('a', 1)]);
      return json({}, 404);
    });
    expect(await chain.tipHeight()).toBe(912345);
    expect((await chain.addressTxs('bc1q/x')).length).toBe(1);
    expect(calls).toEqual(['https://esplora.test/api/blocks/tip/height', 'https://esplora.test/api/address/bc1q%2Fx/txs']);
    await expect(chain.addressTxs('nope')).rejects.toThrow(/HTTP 404/);
  });
});
