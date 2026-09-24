import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTERS,
  WALLET_IDS,
  UserRejectedError,
  createWalletKit,
  detectWallets,
  getAdapter,
  type ConnectedWallet,
  type WalletAdapter,
  type WalletId,
} from '../src/index.js';
import { ADDR, PUBKEY_A, win } from './helpers.js';

describe('registry', () => {
  it('has all seven wallets with unique ids', () => {
    expect([...WALLET_IDS].sort()).toEqual(['horizon', 'leather', 'magiceden', 'okx', 'unisat', 'xcp', 'xverse']);
    for (const a of ADAPTERS) {
      expect(getAdapter(a.id)).toBe(a);
      expect(a.name).toBeTruthy();
      expect(a.installUrl).toMatch(/^https:\/\//);
      expect(a.networks).toContain('mainnet');
    }
  });

  it('getAdapter throws UNKNOWN_WALLET', () => {
    expect(() => getAdapter('phantom' as WalletId)).toThrow(expect.objectContaining({ code: 'UNKNOWN_WALLET' }));
  });

  it('detectWallets reflects what is injected right now', () => {
    expect(detectWallets()).toEqual([]);
    win().unisat = { requestAccounts: async () => [] };
    win().LeatherProvider = { request: async () => ({}) };
    expect(detectWallets().map((a) => a.id)).toEqual(['unisat', 'leather']);
    win().XverseProviders = { BitcoinProvider: { request: async () => ({}) } };
    win().okxwallet = { bitcoin: { connect: async () => ({}) } };
    win().magicEden = { bitcoin: { request: async () => ({}) } };
    expect(detectWallets().map((a) => a.id)).toEqual(['unisat', 'xverse', 'leather', 'okx', 'magiceden']);
  });

  it('detectWallets survives an adapter whose isInstalled throws', () => {
    const bad = { ...ADAPTERS[0]!, isInstalled: () => { throw new Error('x'); } } as WalletAdapter;
    expect(detectWallets([bad])).toEqual([]);
  });
});

/** Stub adapter: records connects, lets tests fire account changes. */
function stubAdapter(id: WalletId, opts: { fail?: unknown; delay?: number } = {}) {
  const changeCbs = new Set<() => void>();
  const disconnect = vi.fn(async () => {});
  const connect = vi.fn(async ({ network }: { network: 'mainnet' | 'testnet' | 'signet' | 'regtest' }): Promise<ConnectedWallet> => {
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (opts.fail) throw opts.fail;
    const acct = { address: ADDR.main.p2tr, publicKey: PUBKEY_A, addressType: 'p2tr' as const };
    return {
      id,
      network,
      ordinals: { ...acct, purpose: 'ordinals' },
      payment: { ...acct, purpose: 'payment' },
      capabilities: { broadcast: false, bip322: true, tapscript: 'unknown', tweakedLeafKey: 'unknown' },
      signPsbt: async () => ({ psbtBase64: '' }),
      signMessage: async () => 'sig',
      disconnect,
      onAccountsChanged(cb) {
        changeCbs.add(cb);
        return () => changeCbs.delete(cb);
      },
    };
  });
  const adapter: WalletAdapter = {
    id,
    name: id,
    installUrl: 'https://example.invalid',
    networks: ['mainnet', 'testnet', 'signet', 'regtest'],
    isInstalled: () => true,
    connect,
  };
  return { adapter, connect, disconnect, fireChange: () => changeCbs.forEach((cb) => cb()), changeCbs };
}

describe('createWalletKit', () => {
  it('exposes network, adapters (defaults to built-ins) and detect()', () => {
    const kit = createWalletKit({ network: 'signet' });
    expect(kit.network).toBe('signet');
    expect(kit.adapters.map((a) => a.id)).toEqual([...WALLET_IDS]);
    expect(kit.current).toBeNull();
    expect(kit.detect()).toEqual([]);
  });

  it('connect passes the kit network, sets current and emits connect', async () => {
    const s = stubAdapter('xverse');
    const kit = createWalletKit({ network: 'testnet', adapters: [s.adapter] });
    const onConnect = vi.fn();
    kit.on('connect', onConnect);
    const w = await kit.connect('xverse');
    expect(s.connect).toHaveBeenCalledWith({ network: 'testnet' });
    expect(kit.current).toBe(w);
    expect(onConnect).toHaveBeenCalledWith(w);
  });

  it('unknown id → UNKNOWN_WALLET', async () => {
    const kit = createWalletKit({ network: 'mainnet', adapters: [] });
    await expect(kit.connect('unisat')).rejects.toMatchObject({ code: 'UNKNOWN_WALLET' });
  });

  it('connect failure emits error with a typed WalletError and rethrows', async () => {
    const s = stubAdapter('unisat', { fail: { code: 4001, message: 'User rejected' } });
    const kit = createWalletKit({ network: 'mainnet', adapters: [s.adapter] });
    const onError = vi.fn();
    kit.on('error', onError);
    await expect(kit.connect('unisat')).rejects.toBeInstanceOf(UserRejectedError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ id: 'unisat', error: { code: 'USER_REJECTED' } });
    expect(kit.current).toBeNull();
  });

  it('kit.disconnect clears current, calls the wallet and emits disconnect(user)', async () => {
    const s = stubAdapter('leather');
    const kit = createWalletKit({ network: 'mainnet', adapters: [s.adapter] });
    const onDisconnect = vi.fn();
    kit.on('disconnect', onDisconnect);
    await kit.connect('leather');
    await kit.disconnect();
    expect(kit.current).toBeNull();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith({ id: 'leather', reason: 'user' });
    expect(s.changeCbs.size).toBe(0);
    // Idempotent.
    await kit.disconnect();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('calling disconnect on the returned wallet goes through the kit', async () => {
    const s = stubAdapter('okx');
    const kit = createWalletKit({ network: 'mainnet', adapters: [s.adapter] });
    const onDisconnect = vi.fn();
    kit.on('disconnect', onDisconnect);
    const w = await kit.connect('okx');
    await w.disconnect();
    expect(kit.current).toBeNull();
    expect(onDisconnect).toHaveBeenCalledWith({ id: 'okx', reason: 'user' });
  });

  it('connecting another wallet replaces the current one', async () => {
    const a = stubAdapter('unisat');
    const b = stubAdapter('xverse');
    const kit = createWalletKit({ network: 'mainnet', adapters: [a.adapter, b.adapter] });
    const events: string[] = [];
    kit.on('connect', (w) => events.push(`connect:${w.id}`));
    kit.on('disconnect', (d) => events.push(`disconnect:${d.id}:${d.reason}`));
    await kit.connect('unisat');
    await kit.connect('xverse');
    expect(events).toEqual(['connect:unisat', 'disconnect:unisat:replaced', 'connect:xverse']);
    expect(kit.current?.id).toBe('xverse');
    expect(a.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a wallet account change emits accountsChanged then drops the session', async () => {
    const s = stubAdapter('unisat');
    const kit = createWalletKit({ network: 'mainnet', adapters: [s.adapter] });
    const events: string[] = [];
    kit.on('accountsChanged', (e) => events.push(`accountsChanged:${e.id}`));
    kit.on('disconnect', (d) => events.push(`disconnect:${d.reason}`));
    await kit.connect('unisat');
    s.fireChange();
    await vi.waitFor(() => expect(kit.current).toBeNull());
    expect(events).toEqual(['accountsChanged:unisat', 'disconnect:accountsChanged']);
  });

  it('a slower connect that loses the race is discarded', async () => {
    const slow = stubAdapter('unisat', { delay: 30 });
    const fast = stubAdapter('xverse');
    const kit = createWalletKit({ network: 'mainnet', adapters: [slow.adapter, fast.adapter] });
    const p1 = kit.connect('unisat');
    const p2 = kit.connect('xverse');
    await expect(p2).resolves.toMatchObject({ id: 'xverse' });
    await expect(p1).rejects.toMatchObject({ code: 'WALLET_ERROR' });
    expect(kit.current?.id).toBe('xverse');
    expect(slow.disconnect).toHaveBeenCalled();
  });

  it('on() returns an unsubscribe; a throwing listener does not break others', async () => {
    const s = stubAdapter('unisat');
    const kit = createWalletKit({ network: 'mainnet', adapters: [s.adapter] });
    const good = vi.fn();
    const removed = vi.fn();
    kit.on('connect', () => {
      throw new Error('bad listener');
    });
    kit.on('connect', good);
    const off = kit.on('connect', removed);
    off();
    await kit.connect('unisat');
    expect(good).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('end to end with a real adapter and fake window.unisat', async () => {
    win().unisat = {
      requestAccounts: async () => [ADDR.main.p2wpkh],
      getPublicKey: async () => PUBKEY_A,
      getChain: async () => ({ enum: 'BITCOIN_MAINNET' }),
      switchChain: async () => ({ enum: 'BITCOIN_MAINNET' }),
      signPsbt: async (h: string) => h,
      signMessage: async () => 's',
    };
    const kit = createWalletKit({ network: 'mainnet' });
    expect(kit.detect().map((a) => a.id)).toEqual(['unisat']);
    const w = await kit.connect('unisat');
    expect(w.payment).toMatchObject({ address: ADDR.main.p2wpkh, addressType: 'p2wpkh' });
  });
});
