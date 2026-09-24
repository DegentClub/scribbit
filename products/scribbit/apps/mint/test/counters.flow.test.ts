import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { canMove, countersReducer, initialCountersFlow } from '../src/flows/counters/state';
import { composeParams, finishReveal, mintCounter, preflight, type CountersForm, type MintDeps } from '../src/flows/counters/effects';
import { loadPendingCounters, COUNTERS_KEY } from '../src/lib/pending';
import { TxidMismatchError } from '../src/lib/funding';
import type { AssetInfo, WalletId } from '../src/services/types';
import { enc, fakes, memoryStore } from './helpers';

function form(over: Partial<CountersForm> = {}): CountersForm {
  return { kind: 'counter', asset: '', bytes: enc('a counter is a file on Bitcoin'), mimeType: 'text/plain', feeRate: 2, quantity: 1n, divisible: false, lockQuantity: true, ordWrapper: false, preset: 'xcp69', fairminter: null, route: 'public', ...over };
}

function deps(services: ReturnType<typeof fakes>, store = memoryStore()): MintDeps & { stages: string[]; store: ReturnType<typeof memoryStore> } {
  const stages: string[] = [];
  return { services, store, network: 'signet', stages, onStage: (s) => stages.push(s), onPending: () => stages.push('pending-saved') };
}

describe('pre-flight checks table', () => {
  const services = fakes();
  const kit = services.counters;
  const wallet = { id: 'xcp', name: 'XCP Wallet', ordinals: { address: 'tb1pme', publicKey: '00', addressType: 'p2tr' }, payment: { address: 'tb1pme', publicKey: '00', addressType: 'p2tr' }, capabilities: { broadcast: true, bip322: true, tapscript: true, tweakedLeafKey: true } } as never;
  const mine: AssetInfo = { asset: 'SCRIBBLE', owner: 'tb1pme', divisible: false, locked: false, descriptionLocked: false, supply: 1n };
  const theirs: AssetInfo = { ...mine, owner: 'tb1pother' };
  const facts = { wallet, existing: null as AssetInfo | null | undefined | 'error', xcpBalance: 100_000_000n as bigint | 'error' | null, btcAvailable: 1_000_000 as number | null | 'error' };
  const status = (f: Partial<CountersForm>, x: Partial<typeof facts> = {}) => Object.fromEntries(preflight(kit, form(f), { ...facts, ...x }).checks.map((c) => [c.id, c.status]));

  it.each([
    ['empty name: numeric drawn, free', {}, {}, { wallet: 'ok', name: 'ok', existence: 'skip', burn: 'ok', weight: 'ok', btc: 'ok' }, true],
    ['free named asset with enough XCP', { asset: 'SCRIBBLE' }, {}, { name: 'ok', existence: 'ok', burn: 'ok' }, true],
    ['named asset, not enough XCP for the 0.5 burn', { asset: 'SCRIBBLE' }, { xcpBalance: 10_000_000n }, { burn: 'fail' }, false],
    ['name taken by someone else', { asset: 'SCRIBBLE' }, { existing: theirs }, { existence: 'fail' }, false],
    ['name exists and is yours (suggests reinscription)', { asset: 'SCRIBBLE' }, { existing: mine }, { existence: 'fail' }, false],
    ['bad name shape', { asset: 'AB' }, {}, { name: 'fail' }, false],
    ['reserved name', { asset: 'XCP' }, {}, { name: 'fail' }, false],
    ['reinscription of your asset: no burn', { kind: 'reinscription', asset: 'SCRIBBLE' }, { existing: mine, xcpBalance: 0n }, { existence: 'ok', burn: 'ok' }, true],
    ['reinscription of someone else’s asset', { kind: 'reinscription', asset: 'SCRIBBLE' }, { existing: theirs }, { existence: 'fail' }, false],
    ['reinscription of a locked description', { kind: 'reinscription', asset: 'SCRIBBLE' }, { existing: { ...mine, descriptionLocked: true } }, { existence: 'fail' }, false],
    ['lookup still running', { asset: 'SCRIBBLE' }, { existing: undefined }, { existence: 'pending' }, false],
    ['node unreachable', { asset: 'SCRIBBLE' }, { existing: 'error' }, { existence: 'fail' }, false],
    ['not enough BTC', {}, { btcAvailable: 500 }, { btc: 'fail' }, false],
    ['over the 400k WU relay cap on the public route', { bytes: new Uint8Array(420_000), mimeType: 'application/octet-stream' }, { btcAvailable: 10_000_000 }, { weight: 'fail' }, false],
    ['over the cap with Slipstream chosen', { bytes: new Uint8Array(420_000), mimeType: 'application/octet-stream', route: 'slipstream' }, { btcAvailable: 10_000_000 }, { weight: 'warn' }, true],
    ['fairminter waiting for the tip', { kind: 'fairminter' }, {}, { sale: 'pending' }, false],
    ['fairminter XCP-69 scheduled', { kind: 'fairminter', fairminter: services.counters.xcp69Params(services.counters.xcp69Schedule(900_000).startBlock) }, {}, { sale: 'ok' }, true],
    ['custom fairminter with a pool but no soft cap', { kind: 'fairminter', preset: 'custom', fairminter: { ...services.counters.xcp69Params(900_003), softCap: 0n } }, {}, { sale: 'fail' }, false],
  ] as const)('%s', (_name, f, x, expected, ready) => {
    expect(status(f as Partial<CountersForm>, x as never)).toMatchObject(expected);
    expect(preflight(kit, form(f as Partial<CountersForm>), { ...facts, ...(x as object) }).ready).toBe(ready);
  });

  it('no wallet / non-taproot / no tapscript fail the wallet row', () => {
    expect(status({}, { wallet: null as never }).wallet).toBe('fail');
    expect(status({}, { wallet: { ...(wallet as object), ordinals: { address: 'tb1q', publicKey: '', addressType: 'p2wpkh' } } as never }).wallet).toBe('fail');
    expect(status({}, { wallet: { ...(wallet as object), capabilities: { tapscript: false } } as never }).wallet).toBe('fail');
  });

  it('the estimate delegates to @bsh/scribbit-counters', () => {
    const r = preflight(kit, form(), facts);
    expect(r.estimate).toEqual(kit.estimate({ bytes: form().bytes!.length, feeRate: 2, kind: 'counter', mimeType: 'text/plain', quantity: 1n }));
  });
});

describe('compose parameters', () => {
  const kit = fakes().counters;
  it('counter / reinscription / fairminter', () => {
    const c = composeParams(kit, form({ ordWrapper: true }), 'A1234567890123456789', null);
    expect(c).toMatchObject({ asset: 'A1234567890123456789', quantity: '1', divisible: 'false', lock: 'true', encoding: 'taproot', inscription: 'true', mime_type: 'text/plain', verbose: 'true', exclude_utxos_with_balances: 'true', description: 'a counter is a file on Bitcoin' });
    const r = composeParams(kit, form({ kind: 'reinscription', lockQuantity: true, quantity: 99n }), 'SCRIBBLE', { divisible: true } as never);
    expect(r).toMatchObject({ quantity: '0', divisible: 'true', lock: 'false' });
    const fm = composeParams(kit, form({ kind: 'fairminter', fairminter: kit.xcp69Params(900_003) }), 'SCRIBBLE', null);
    expect(fm).toMatchObject({ asset: 'SCRIBBLE', soft_cap: '6900000000000000', start_block: '900003', soft_cap_deadline_block: '901003', encoding: 'taproot' });
    expect(composeParams(kit, form({ bytes: new Uint8Array([0xff, 0x00]), mimeType: 'image/png' }), 'A1', null).description).toBe('ff00');
  });
});

describe('mint (fake node, real engine, real signatures)', () => {
  it.each(['xcp', 'horizon', 'unisat', 'xverse', 'leather', 'okx', 'magiceden'] as WalletId[])('%s mints a counter end to end', async (id) => {
    const services = fakes();
    const d = deps(services);
    const wallet = await services.wallets.connect(id, 'signet');
    const r = await mintCounter(d, wallet, form({ ordWrapper: id === 'xverse' }));
    expect(r.asset).toMatch(/^A\d+$/);
    expect(d.stages).toEqual(['checking', 'composing', 'signing-commit', 'pending-saved', 'broadcasting-commit', 'signing-reveal', 'broadcasting-reveal']);
    // XCP Wallet got the inscription context on the commit (it refuses without); Horizon relays through us.
    expect(services.log).toContain(`wallet.signPsbt:${id}:inscription`);
    const reveal = btc.Transaction.fromRaw(hex.decode(services.chain.state.broadcasts.get(r.revealTxid)!), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    expect(hex.encode(reveal.getInput(0).txid!)).toBe(r.commitTxid);
    expect(hex.encode(reveal.getOutput(0).script!)).toBe('6a08434e545250525459'); // OP_RETURN "CNTRPRTY"
    expect(reveal.getInput(0).finalScriptWitness).toHaveLength(3); // script-path spend
    expect(loadPendingCounters(d.store)).toBeNull();
    if (id === 'horizon') expect(services.log).not.toContain('wallet.pushTx:horizon');
  });

  it('a named asset, a reinscription and an XCP-69 deploy', async () => {
    const services = fakes();
    const d = deps(services);
    const wallet = await services.wallets.connect('xcp', 'signet');
    const a = await mintCounter(d, wallet, form({ asset: 'SCRIBBLE' }));
    expect(a.asset).toBe('SCRIBBLE');
    const b = await mintCounter(d, wallet, form({ kind: 'reinscription', asset: 'SCRIBBLE', bytes: enc('v2') }));
    expect(b.kind).toBe('reinscription');
    const tip = await services.cp.getTip();
    const c = await mintCounter(d, wallet, form({ kind: 'fairminter', asset: 'FAIRSCRIB', fairminter: services.counters.xcp69Params(services.counters.xcp69Schedule(tip).startBlock) }));
    expect(c.kind).toBe('fairminter');
    expect(services.log.filter((l) => l === 'cp.compose:fairminter')).toHaveLength(1);
  });

  it('commit txid check: an altered commit is never broadcast and nothing is saved', async () => {
    const services = fakes({ wallet: { tamper: (tx) => tx.updateInput(0, { sequence: 1 }) } });
    const d = deps(services);
    const wallet = await services.wallets.connect('horizon', 'signet');
    await expect(mintCounter(d, wallet, form())).rejects.toBeInstanceOf(TxidMismatchError);
    expect(services.chain.state.broadcasts.size).toBe(0);
    expect(d.store.map.has(COUNTERS_KEY)).toBe(false);
  });

  it('reveal refused → pending mint survives → resume signs the reveal again', async () => {
    const services = fakes();
    const d = deps(services);
    const wallet = await services.wallets.connect('xcp', 'signet');
    const realSign = wallet.signPsbt.bind(wallet);
    let calls = 0;
    wallet.signPsbt = async (p, r) => {
      calls++;
      if (calls === 2) throw Object.assign(new Error('User rejected the request'), { code: 'USER_REJECTED' });
      return realSign(p, r);
    };
    await expect(mintCounter(d, wallet, form())).rejects.toThrow(/rejected/);
    const pending = loadPendingCounters(d.store)!;
    expect(pending.commitTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(services.chain.state.broadcasts.has(pending.commitTxid)).toBe(true);
    // --- later (another session), the same wallet
    const r = await finishReveal(d, wallet, pending);
    expect(services.chain.state.broadcasts.has(r.txid)).toBe(true);
    expect(loadPendingCounters(d.store)).toBeNull();
  });

  it('resume refuses a different account', async () => {
    const services = fakes();
    const d = deps(services);
    const w1 = await services.wallets.connect('xcp', 'signet');
    const w2 = await services.wallets.connect('horizon', 'signet');
    const pending = { source: w1.ordinals.address } as never;
    await expect(finishReveal(d, w2, pending)).rejects.toThrow(/was started from/);
  });

  it('over the relay cap on the public route is refused before signing', async () => {
    const services = fakes({ chain: { utxos: new Map() } });
    const d = deps(services);
    const wallet = await services.wallets.connect('xcp', 'signet');
    services.chain.state.utxos.set(wallet.ordinals.address, [{ txid: 'ab'.repeat(32), vout: 0, value: 50_000_000, status: { confirmed: true } }]);
    await expect(mintCounter(d, wallet, form({ bytes: new Uint8Array(420_000), mimeType: 'application/octet-stream' }))).rejects.toThrow(/relay cap/);
    expect(services.log.some((l) => l.startsWith('wallet.signPsbt'))).toBe(false);
  });
});

describe('state machine', () => {
  it('only allows the documented transitions', () => {
    expect(canMove('idle', 'checking')).toBe(true);
    expect(canMove('idle', 'signing-reveal')).toBe(true); // resume
    expect(canMove('idle', 'broadcasting-commit')).toBe(false);
    expect(canMove('signing-commit', 'signing-reveal')).toBe(false);
    let s = initialCountersFlow();
    for (const st of ['checking', 'composing', 'signing-commit', 'broadcasting-commit'] as const) s = countersReducer(s, { type: 'STAGE', stage: st });
    expect(s.stage).toBe('broadcasting-commit');
    s = countersReducer(s, { type: 'STAGE', stage: 'composing' });
    expect(s.stage).toBe('broadcasting-commit');
    s = countersReducer(s, { type: 'PENDING_SAVED', pending: { asset: 'A1' } as never });
    s = countersReducer(s, { type: 'FAILED', error: { message: 'x', hint: 'y' } });
    expect(s).toMatchObject({ stage: 'idle', pending: { asset: 'A1' } });
    s = countersReducer(s, { type: 'DONE', result: { asset: 'A1' } as never });
    expect(s).toMatchObject({ stage: 'done', pending: null });
  });
});
