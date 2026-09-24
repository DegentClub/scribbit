import { describe, expect, it } from 'vitest';
import { UnsupportedMethodError, UserRejectedError, WalletNotInstalledError, horizonAdapter } from '../src/index.js';
import { ADDR, PUBKEY_A, PUBKEY_B, Recorder, SIGNED_B64, SIGNED_HEX, UNSIGNED_B64, UNSIGNED_HEX, win } from './helpers.js';

type Handler = (params: unknown) => unknown;

/** `window.HorizonWalletProvider.request(method, params)` house API: resolves `{ result }`, rejects `{ error }`. */
function fakeHorizon(handlers: Record<string, Handler>) {
  const rec = new Recorder();
  const p = {
    async request(method: string, params?: unknown) {
      rec.record(method, [params]);
      const h = handlers[method];
      if (!h) throw { error: { code: -32601, message: 'Method not found' } };
      return { result: await h(params) };
    },
  };
  return { p, rec };
}

const addresses = (set: { p2tr: string; p2wpkh: string }) => ({
  addresses: [
    { address: set.p2wpkh, publicKey: PUBKEY_B, type: 'p2wpkh' },
    { address: set.p2tr, publicKey: PUBKEY_A, type: 'p2tr' },
  ],
  network: 'mainnet',
});

function install(handlers: Record<string, Handler> = {}, { announce = false, getter = true } = {}) {
  const f = fakeHorizon({
    getAddresses: () => addresses(ADDR.main),
    signPsbt: () => ({ hex: SIGNED_HEX }),
    signMessage: () => ({ signature: 'horizon-ecdsa-sig' }),
    wallet_disconnect: () => undefined,
    ...handlers,
  });
  if (getter) win().HorizonWalletProvider = f.p;
  if (announce) win().btc_providers = [{ id: 'HorizonWalletProvider', name: 'Horizon Wallet', methods: ['getAddresses', 'signPsbt'] }];
  return f;
}

/** User cancellation: the extension rejects with a plain-string `.error`. */
const cancelled = () => {
  throw { error: 'User rejected the request' };
};

describe('Horizon Wallet adapter', () => {
  it('not installed; WBIP-004 announcement counts as installed', async () => {
    expect(horizonAdapter.isInstalled()).toBe(false);
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
    install({}, { announce: true, getter: false });
    expect(horizonAdapter.isInstalled()).toBe(true);
    // Announced but the getter is not there yet: connect cannot proceed.
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
  });

  it('connect: house getAddresses (no params); p2tr → ordinals, p2wpkh → payment', async () => {
    const { rec } = install();
    const w = await horizonAdapter.connect({ network: 'mainnet' });
    expect(rec.calls).toEqual([{ method: 'getAddresses', args: [undefined] }]);
    expect(w.id).toBe('horizon');
    expect(w.ordinals).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals', addressType: 'p2tr' });
    expect(w.payment).toEqual({ address: ADDR.main.p2wpkh, publicKey: PUBKEY_B, purpose: 'payment', addressType: 'p2wpkh' });
    expect(w.taprootOutputKey).toBe('01'.repeat(32));
    expect(w.capabilities).toEqual({ broadcast: false, bip322: false, tapscript: true, tweakedLeafKey: true });
    expect(w.pushTx).toBeUndefined();
    expect(w.onAccountsChanged).toBeUndefined();
  });

  it('connect: taproot-only wallet uses it for both; type inferred when omitted; empty → NOT_CONNECTED', async () => {
    install({ getAddresses: () => ({ addresses: [{ address: ADDR.test.p2tr, publicKey: PUBKEY_A }] }) });
    const w = await horizonAdapter.connect({ network: 'signet' });
    expect(w.ordinals.address).toBe(ADDR.test.p2tr);
    expect(w.payment.address).toBe(ADDR.test.p2tr);
    expect(w.payment.addressType).toBe('p2tr');
    install({ getAddresses: () => ({ addresses: [] }) });
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('connect: network validated from the addresses; rejections mapped', async () => {
    install();
    await expect(horizonAdapter.connect({ network: 'testnet' })).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
    install({ getAddresses: cancelled });
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
    install({ getAddresses: () => { throw { error: { code: -32000, message: 'User rejected' } }; } });
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
    install({ getAddresses: () => { throw { error: { code: -32002, message: 'Not connected' } }; } });
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    install({ getAddresses: () => { throw { error: { code: -32603, message: 'boom' } }; } });
    await expect(horizonAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'WALLET_ERROR', message: /boom/ });
  });

  describe('signPsbt', () => {
    it('house signPsbt { hex, signInputs, sighashTypes: [0, 1] }; returns base64; inscription context not forwarded', async () => {
      const { rec } = install();
      const w = await horizonAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [
          { index: 0, address: ADDR.main.p2wpkh },
          { index: 1, address: ADDR.main.p2tr },
          { index: 3, address: ADDR.main.p2wpkh },
        ],
        inscription: { envelopeScriptHex: '20' + '01'.repeat(32) + 'ac', commitAddress: ADDR.main.p2tr },
      });
      expect(rec.last('signPsbt')?.args[0]).toEqual({
        hex: UNSIGNED_HEX,
        signInputs: { [ADDR.main.p2wpkh]: [0, 3], [ADDR.main.p2tr]: [1] },
        sighashTypes: [0, 1],
      });
      expect(res).toEqual({ psbtBase64: SIGNED_B64 });
    });

    it('requested sighash types are added to the whitelist', async () => {
      const { rec } = install();
      const w = await horizonAdapter.connect({ network: 'mainnet' });
      await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr, sighashTypes: [0x81] }] });
      expect(rec.last('signPsbt')?.args[0]).toMatchObject({ sighashTypes: [0, 1, 0x81] });
    });

    it('broadcast is unsupported (no relay); nothing is signed', async () => {
      const { rec } = install();
      const w = await horizonAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }], broadcast: true })).rejects.toBeInstanceOf(
        UnsupportedMethodError,
      );
      expect(rec.last('signPsbt')).toBeUndefined();
    });

    it('rejection → UserRejectedError; empty answer → WALLET_ERROR; foreign address refused', async () => {
      install({ signPsbt: cancelled });
      const w = await horizonAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }] })).rejects.toBeInstanceOf(UserRejectedError);
      install({ signPsbt: () => ({}) });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }] })).rejects.toMatchObject({ code: 'WALLET_ERROR' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2sh }] })).rejects.toMatchObject({ code: 'ADDRESS_NOT_IN_WALLET' });
    });
  });

  it('signMessage: ECDSA (default) via house signMessage; bip322 → UnsupportedMethodError', async () => {
    const { rec } = install();
    const w = await horizonAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('m', ADDR.main.p2wpkh)).toBe('horizon-ecdsa-sig');
    expect(rec.last('signMessage')?.args[0]).toEqual({ message: 'm', address: ADDR.main.p2wpkh });
    expect(await w.signMessage('m', ADDR.main.p2tr, 'ecdsa')).toBe('horizon-ecdsa-sig');
    await expect(w.signMessage('m', ADDR.main.p2tr, 'bip322-simple')).rejects.toBeInstanceOf(UnsupportedMethodError);
    await expect(w.signMessage('m', ADDR.main.p2tr, 'bip322-simple')).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD', walletId: 'horizon' });
    await expect(w.signMessage('m', ADDR.main.p2sh)).rejects.toMatchObject({ code: 'ADDRESS_NOT_IN_WALLET' });
  });

  it('disconnect: wallet_disconnect {} (best effort)', async () => {
    const { rec } = install({ wallet_disconnect: () => { throw new Error('nope'); } });
    const w = await horizonAdapter.connect({ network: 'mainnet' });
    await expect(w.disconnect()).resolves.toBeUndefined();
    expect(rec.last('wallet_disconnect')?.args).toEqual([{}]);
  });
});
