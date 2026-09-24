import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import * as ins from '@bsh/inscription';
import { initialOrdinalsState, ordinalsReducer, canEnter, type ContentItem } from '../src/flows/ordinals/state';
import { pendingRecord, prepareCommit, quoteItem, rescueFromPending, revealFromPending, signAndBroadcastCommit, signAndBroadcastReveal, encodeMetadata, toContent } from '../src/flows/ordinals/effects';
import { isUnverified, planRevealSigning, taprootOutputKey } from '../src/lib/walletRouting';
import { loadPendingOrdinals, ORDINALS_KEY } from '../src/lib/pending';
import { TxidMismatchError } from '../src/lib/funding';
import { extractInscriptionBody } from '../src/services/fakes';
import type { WalletId } from '../src/services/types';
import { enc, fakes, memoryStore } from './helpers';

const item = (body: Uint8Array = enc('scribb.it: hello, Bitcoin'), contentType = 'text/plain;charset=utf-8'): ContentItem => ({ id: 'a', fileName: 'hello.txt', bytes: body, contentType, sha256: ins.sha256Hex(body), size: body.length });
const options = { parentId: '', metadataJson: '', postage: 546n };

async function mintOnce(id: WalletId, body?: Uint8Array) {
  const services = fakes();
  const store = memoryStore();
  const wallet = await services.wallets.connect(id, 'signet');
  const it = item(body);
  const quote = quoteItem(services, { network: 'signet', wallet, item: it, options, feeRate: 3 });
  const { commit, reveal } = await prepareCommit(services, { network: 'signet', wallet, item: it, options, quote });
  const pending = pendingRecord({ network: 'signet', wallet, item: it, options, quote, commit });
  const commitTxid = await signAndBroadcastCommit(services, store, { wallet, commit, pending });
  expect(store.map.has(ORDINALS_KEY)).toBe(true);
  const r = await signAndBroadcastReveal(services, store, { wallet, reveal });
  return { services, store, wallet, quote, commit, commitTxid, r, it };
}

describe('quote maths delegate to @bsh/inscription', () => {
  it('weight, vsize, fee and commit value equal the library and the signed reveal', async () => {
    const { quote, r, it, wallet } = await mintOnce('unisat');
    const content = toContent(it, options);
    const w = ins.estimateRevealWeight({ content, withParent: false, recipientScript: ins.addressToScript(wallet.ordinals.address, 'signet'), commitSighash: 'default' });
    expect(quote.quote.weight).toBe(w);
    expect(quote.quote).toMatchObject(ins.quoteReveal({ revealWeight: w, feeRate: 3, postage: 546n }).revealVsize ? { vsize: Math.ceil(w / 4) } : {});
    expect(quote.quote.commitValue).toBe(quote.quote.revealFee + 546n);
    expect(quote.quote.lane).toBe('standard');
    // the exact weight is the weight of the transaction the wallet actually signed
    expect(r.weight).toBe(w);
  });

  it('lanes: > 400,000 WU is the block lane', () => {
    const services = fakes();
    const big = new Uint8Array(420_000);
    const q = services.inscription.quote({ content: { contentType: 'application/octet-stream', body: big }, recipientAddress: 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', network: 'signet', feeRate: 2, postage: 546n });
    expect(q.lane).toBe('block');
  });

  it('metadata is CBOR and parent ids are validated', () => {
    expect(hex.encode(encodeMetadata('{"a":1}'))).toBe('a1616101');
    expect(() => toContent(item(), { ...options, parentId: 'nope' })).toThrow(/not an inscription id/);
    expect(toContent(item(), { ...options, parentId: `${'AB'.repeat(32)}i0` }).parentId).toBe(`${'ab'.repeat(32)}i0`);
  });
});

describe('wallet capability routing (which key / options per wallet)', () => {
  it.each([
    ['unisat', 'output', false, 'default'], // kit: tweaked by default
    ['okx', 'internal', true, 'default'], // kit: unknown → app fallback (internal + disableTweakSigner)
    ['xverse', 'internal', true, 'default'],
    ['leather', 'internal', true, 'default'],
    ['magiceden', 'internal', true, 'default'],
    ['xcp', 'output', false, 'all'],
    ['horizon', 'output', false, 'default'],
  ] as const)('%s → %s leaf key, disableTweak=%s, sighash %s (capabilities from @bsh/wallet-kit CAPABILITIES)', async (id, kind, disableTweak, sighash) => {
    const services = fakes();
    const w = await services.wallets.connect(id, 'signet');
    const plan = planRevealSigning(w);
    expect(plan.leafKeyKind).toBe(kind);
    expect(plan.inputToSign.disableTweak === true).toBe(disableTweak);
    expect(plan.sighash).toBe(sighash);
    const expectedKey = kind === 'output' ? taprootOutputKey(w.ordinals.address)! : hex.decode(w.ordinals.publicKey);
    expect(hex.encode(plan.leafPubkey)).toBe(hex.encode(expectedKey));
    expect(plan.broadcastVia).toBe(id === 'horizon' ? 'esplora' : 'wallet');
    expect(isUnverified(id, w.capabilities)).toBe(id !== 'xcp' && id !== 'horizon');
  });

  it('refuses a wallet that cannot sign tapscript, before anything is funded', async () => {
    const services = fakes({ wallet: { capabilities: { leather: { tapscript: false } } } });
    const w = await services.wallets.connect('leather', 'signet');
    expect(() => planRevealSigning(w)).toThrow(/cannot sign a tapscript/);
  });

  it.each(['unisat', 'xverse', 'leather', 'okx', 'magiceden', 'xcp', 'horizon'] as const)('%s: full mint signs for real and inscribes the exact bytes', async (id) => {
    const body = enc(`inscribed by ${id}`);
    const { r, services, commitTxid, store } = await mintOnce(id, body);
    expect(r.inscriptionId).toBe(`${r.txid}i0`);
    const raw = services.chain.state.broadcasts.get(r.txid)!;
    expect(hex.encode(extractInscriptionBody(raw)!)).toBe(hex.encode(body));
    // the reveal spends the commit that was broadcast
    const tx = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    expect(hex.encode(tx.getInput(0).txid!)).toBe(commitTxid);
    expect(loadPendingOrdinals(store)).toBeNull();
    expect(r.broadcastVia).toBe(id === 'horizon' ? 'esplora' : 'wallet');
  });
});

describe('commit txid check', () => {
  it('blocks a wallet that altered the commit: nothing is broadcast', async () => {
    const services = fakes({ wallet: { tamper: (tx) => tx.updateOutput(tx.outputsLength - 1, { amount: tx.getOutput(tx.outputsLength - 1).amount! - 1000n }) } });
    const store = memoryStore();
    const wallet = await services.wallets.connect('xverse', 'signet');
    const it = item();
    const quote = quoteItem(services, { network: 'signet', wallet, item: it, options, feeRate: 3 });
    const { commit } = await prepareCommit(services, { network: 'signet', wallet, item: it, options, quote });
    const pending = pendingRecord({ network: 'signet', wallet, item: it, options, quote, commit });
    await expect(signAndBroadcastCommit(services, store, { wallet, commit, pending })).rejects.toBeInstanceOf(TxidMismatchError);
    expect(services.chain.state.broadcasts.size).toBe(0);
    expect(services.log).not.toContain('chain.broadcast');
    expect(store.map.has(ORDINALS_KEY)).toBe(false);
  });

  it('the funding PSBT pays the commit address at vout 0 with exactly the quoted commit value', async () => {
    const services = fakes();
    const wallet = await services.wallets.connect('leather', 'signet');
    const it = item();
    const quote = quoteItem(services, { network: 'signet', wallet, item: it, options, feeRate: 3 });
    const { commit } = await prepareCommit(services, { network: 'signet', wallet, item: it, options, quote });
    const tx = btc.Transaction.fromPSBT(base64.decode(commit.psbtBase64));
    expect(btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(quote.commitAddress);
    expect(tx.getOutput(0).amount).toBe(quote.quote.commitValue);
    expect(tx.id).toBe(commit.txid);
  });
});

describe('resume + rescue', () => {
  it('a reload after the commit rebuilds the same reveal from storage and finishes', async () => {
    const services = fakes();
    const store = memoryStore();
    const wallet = await services.wallets.connect('unisat', 'signet');
    const it = item();
    const quote = quoteItem(services, { network: 'signet', wallet, item: it, options, feeRate: 3 });
    const { commit, reveal } = await prepareCommit(services, { network: 'signet', wallet, item: it, options, quote });
    await signAndBroadcastCommit(services, store, { wallet, commit, pending: pendingRecord({ network: 'signet', wallet, item: it, options, quote, commit }) });
    // --- tab closed: only storage survives
    const pending = loadPendingOrdinals(store)!;
    const rebuilt = revealFromPending(services, pending, 'default');
    expect(rebuilt.psbtBase64).toBe(reveal.psbtBase64);
    const r = await signAndBroadcastReveal(services, store, { wallet, reveal: rebuilt });
    expect(r.inscriptionId).toMatch(/i0$/);
    expect(loadPendingOrdinals(store)).toBeNull();
  });

  it('rescue re-signs a fresh [commit] → [child] reveal that the network accepts', async () => {
    const services = fakes();
    const store = memoryStore();
    const wallet = await services.wallets.connect('xcp', 'signet');
    const it = item();
    const quote = quoteItem(services, { network: 'signet', wallet, item: it, options, feeRate: 3 });
    const { commit } = await prepareCommit(services, { network: 'signet', wallet, item: it, options, quote });
    await signAndBroadcastCommit(services, store, { wallet, commit, pending: pendingRecord({ network: 'signet', wallet, item: it, options, quote, commit }) });
    const pending = loadPendingOrdinals(store)!;
    const rescue = rescueFromPending(services, pending, 'all');
    const r = await signAndBroadcastReveal(services, store, { wallet, reveal: rescue });
    expect(hex.encode(extractInscriptionBody(services.chain.state.broadcasts.get(r.txid)!)!)).toBe(hex.encode(it.bytes));
  });
});

describe('reducer', () => {
  it('walks the steps and refuses to go back once the commit is broadcast', () => {
    let s = initialOrdinalsState('signet');
    expect(canEnter(s, 'content')).toBe(false);
    s = ordinalsReducer(s, { type: 'WALLET_CONNECTED', wallet: { id: 'unisat' } as never });
    expect(s.step).toBe('content');
    s = ordinalsReducer(s, { type: 'FEES_LOADED', fees: { minFeeRate: 1, standard: { slow: 1, normal: 4, fast: 8 }, block: { min: 1, recommended: 5 }, fetchedAt: '', stale: false } });
    expect(s.feeRate).toBe(4);
    s = ordinalsReducer(s, { type: 'ITEMS_ADDED', items: [item(), { ...item(), id: 'b' }] });
    expect(canEnter(s, 'quote')).toBe(true);
    s = ordinalsReducer(s, { type: 'QUOTED', quote: {} as never });
    s = ordinalsReducer(s, { type: 'COMMIT_PREPARED', commit: { txid: 'aa', commitValue: 1n } as never, reveal: { psbtBase64: 'x' } });
    s = ordinalsReducer(s, { type: 'COMMIT_BROADCAST', txid: 'aa', pending: {} as never });
    expect(s.step).toBe('reveal');
    expect(ordinalsReducer(s, { type: 'GO', step: 'content' }).step).toBe('reveal');
    s = ordinalsReducer(s, { type: 'REVEAL_BROADCAST', txid: 'bb', inscriptionId: 'bbi0' });
    expect(s.step).toBe('done');
    expect(s.done).toHaveLength(1);
    s = ordinalsReducer(s, { type: 'NEXT_ITEM' });
    expect(s).toMatchObject({ current: 1, step: 'quote', commit: null });
  });
});
