import { describe, expect, it } from 'vitest';
import { base64, hex } from '@scure/base';
import { p2tr, Transaction, utils } from '@scure/btc-signer';
import { UserRejectedError, WalletNotInstalledError, XCP_NUMS_INTERNAL_KEY, xcpAdapter } from '../src/index.js';
import { ADDR, PUBKEY_A, PUBKEY_B, Recorder, SIGNED_B64, SIGNED_HEX, UNSIGNED_B64, UNSIGNED_HEX, eip1193Rejection, win } from './helpers.js';

type Handler = (params: unknown[] | undefined) => unknown;

/** `window.xcpwallet`: `request({ method, params })`, EIP-1193 errors, `on` / `removeListener`. */
function fakeXcp(handlers: Record<string, Handler>) {
  const rec = new Recorder();
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const p = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      rec.record(method, params ?? []);
      const h = handlers[method];
      if (!h) throw Object.assign(new Error('Method not supported'), { code: 4200 });
      return h(params);
    },
    on(ev: string, h: (...a: unknown[]) => void) {
      rec.record('on', [ev]);
      (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(h);
    },
    removeListener(ev: string, h: (...a: unknown[]) => void) {
      listeners.get(ev)?.delete(h);
    },
  };
  return { p, rec, listeners };
}

const addresses = () => ({
  active: { address: ADDR.main.p2tr, publicKey: PUBKEY_A, type: 'p2tr' },
  segwit: { address: ADDR.main.p2wpkh, publicKey: PUBKEY_B, type: 'p2wpkh' },
});

function install(handlers: Record<string, Handler> = {}) {
  const f = fakeXcp({
    xcp_requestAccounts: () => ({ accounts: [ADDR.main.p2tr], proof: { address: ADDR.main.p2tr, message: 'xcp-wallet\n…', signature: 'sig', verification: { method: 'BIP-322', format: 'p2tr' } } }),
    xcp_accounts: () => [ADDR.main.p2tr],
    xcp_getAddresses: addresses,
    xcp_signPsbt: () => ({ hex: SIGNED_HEX }),
    xcp_signMessage: () => ({ signature: 'xcp-bip322-sig' }),
    xcp_broadcastTransaction: () => ({ txid: 'ab'.repeat(32) }),
    xcp_disconnect: () => undefined,
    ...handlers,
  });
  win().xcpwallet = f.p;
  return f;
}

describe('XCP Wallet adapter', () => {
  it('not installed', async () => {
    expect(xcpAdapter.isInstalled()).toBe(false);
    await expect(xcpAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
    win().xcpwallet = { notARequest: true };
    expect(xcpAdapter.isInstalled()).toBe(false);
  });

  it('mainnet only', async () => {
    install();
    for (const network of ['testnet', 'signet', 'regtest'] as const) {
      await expect(xcpAdapter.connect({ network })).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
    }
  });

  it('connect: xcp_requestAccounts, then xcp_getAddresses for the public key; one account serves both purposes', async () => {
    const { rec } = install();
    expect(xcpAdapter.isInstalled()).toBe(true);
    const w = await xcpAdapter.connect({ network: 'mainnet' });
    expect(rec.methods()).toEqual(['xcp_requestAccounts', 'xcp_getAddresses']);
    expect(w.id).toBe('xcp');
    expect(w.ordinals).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals', addressType: 'p2tr' });
    expect(w.payment).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'payment', addressType: 'p2tr' });
    expect(w.taprootOutputKey).toBe('01'.repeat(32)); // the bc1p program (ADDR.main.p2tr is filled with 0x01)
    expect(w.capabilities).toEqual({ broadcast: true, bip322: true, tapscript: true, tweakedLeafKey: true });
  });

  it('connect: legacy string[] accounts response and a wallet that will not give public keys', async () => {
    install({ xcp_requestAccounts: () => [ADDR.main.p2wpkh], xcp_getAddresses: () => { throw new Error('old build'); } });
    const w = await xcpAdapter.connect({ network: 'mainnet' });
    expect(w.ordinals).toEqual({ address: ADDR.main.p2wpkh, publicKey: '', purpose: 'ordinals', addressType: 'p2wpkh' });
    expect(w.taprootOutputKey).toBeUndefined();
  });

  it('connect: wrong-network address, no accounts, rejection', async () => {
    install({ xcp_requestAccounts: () => ({ accounts: [ADDR.test.p2tr], proof: null }) });
    await expect(xcpAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
    install({ xcp_requestAccounts: () => ({ accounts: [], proof: null }) });
    await expect(xcpAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    install({ xcp_requestAccounts: () => { throw eip1193Rejection(); } });
    await expect(xcpAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
    install({ xcp_requestAccounts: () => { throw Object.assign(new Error('Unauthorized'), { code: 4100 }); } });
    await expect(xcpAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  describe('signPsbt', () => {
    it('xcp_signPsbt [{ hex, signInputs }] without sighashTypes; returns base64', async () => {
      const { rec } = install();
      const w = await xcpAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }, { index: 2, address: ADDR.main.p2tr }] });
      expect(rec.last('xcp_signPsbt')?.args).toEqual([{ hex: UNSIGNED_HEX, signInputs: { [ADDR.main.p2tr]: [0, 2] } }]);
      expect(res).toEqual({ psbtBase64: SIGNED_B64 });
    });

    it('inscription context → { revealScript, tapInternalKey: NUMS }; explicit sighashTypes forwarded', async () => {
      const { rec } = install();
      const w = await xcpAdapter.connect({ network: 'mainnet' });
      await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [{ index: 0, address: ADDR.main.p2tr, sighashTypes: [1] }],
        inscription: { envelopeScriptHex: '20' + '01'.repeat(32) + 'ac0063036f7264', commitAddress: ADDR.main.p2tr },
      });
      expect(rec.last('xcp_signPsbt')?.args[0]).toEqual({
        hex: UNSIGNED_HEX,
        signInputs: { [ADDR.main.p2tr]: [0] },
        sighashTypes: [1],
        inscription: { revealScript: '20' + '01'.repeat(32) + 'ac0063036f7264', tapInternalKey: XCP_NUMS_INTERNAL_KEY },
      });
      expect(XCP_NUMS_INTERNAL_KEY).toBe('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
    });

    it('broadcast: finalizes the wallet-signed PSBT locally and relays via xcp_broadcastTransaction', async () => {
      // A real key-path p2tr input so the fake wallet can sign and the adapter can finalize.
      const priv = hex.decode('07'.repeat(32));
      const pay = p2tr(utils.pubSchnorr(priv));
      const tx = new Transaction();
      tx.addInput({ txid: 'cd'.repeat(32), index: 0, witnessUtxo: { script: pay.script, amount: 10_000n }, tapInternalKey: utils.pubSchnorr(priv) });
      tx.addOutput({ script: pay.script, amount: 9_000n });
      const unsigned = base64.encode(tx.toPSBT());
      const { rec } = install({
        xcp_signPsbt: (params) => {
          const { hex: h } = (params as [{ hex: string }])[0];
          const t = Transaction.fromPSBT(hex.decode(h));
          t.signIdx(priv, 0);
          return { hex: hex.encode(t.toPSBT()) };
        },
      });
      const w = await xcpAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(unsigned, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }], broadcast: true });
      expect(res.txid).toBe('ab'.repeat(32));
      const raw = rec.last('xcp_broadcastTransaction')?.args[0] as string;
      const relayed = Transaction.fromRaw(hex.decode(raw));
      expect(relayed.id).toBe(tx.id);
      expect(relayed.getInput(0).finalScriptWitness?.[0]?.length).toBe(64);
      expect(Transaction.fromPSBT(base64.decode(res.psbtBase64)).getInput(0).tapKeySig?.length).toBe(64);
    });

    it('broadcast with an unfinalizable answer → INVALID_PSBT, nothing relayed', async () => {
      const { rec } = install();
      const w = await xcpAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }], broadcast: true })).rejects.toMatchObject({ code: 'INVALID_PSBT' });
      expect(rec.last('xcp_broadcastTransaction')).toBeUndefined();
    });

    it('rejection → UserRejectedError; foreign address refused before the wallet is called', async () => {
      const { rec } = install({ xcp_signPsbt: () => { throw eip1193Rejection(); } });
      const w = await xcpAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }] })).rejects.toBeInstanceOf(UserRejectedError);
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2wpkh }] })).rejects.toMatchObject({ code: 'ADDRESS_NOT_IN_WALLET' });
      expect(rec.calls.filter((c) => c.method === 'xcp_signPsbt').length).toBe(1);
    });
  });

  it('signMessage: xcp_signMessage [message] (BIP-322); ecdsa → UNSUPPORTED_METHOD; string result accepted', async () => {
    const { rec } = install();
    const w = await xcpAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('hello', ADDR.main.p2tr)).toBe('xcp-bip322-sig');
    expect(rec.last('xcp_signMessage')?.args).toEqual(['hello']);
    await expect(w.signMessage('hello', ADDR.main.p2tr, 'ecdsa')).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
    install({ xcp_signMessage: () => 'raw-sig' });
    expect(await w.signMessage('hello', ADDR.main.p2tr)).toBe('raw-sig');
  });

  it('pushTx, disconnect, account-change events', async () => {
    const { rec, listeners } = install();
    const w = await xcpAdapter.connect({ network: 'mainnet' });
    expect(await w.pushTx!('0200')).toBe('ab'.repeat(32));
    expect(rec.last('xcp_broadcastTransaction')?.args).toEqual(['0200']);
    let fired = 0;
    const off = w.onAccountsChanged!(() => fired++);
    expect([...listeners.keys()]).toEqual(['accountsChanged', 'disconnect']);
    listeners.get('accountsChanged')!.forEach((h) => h());
    expect(fired).toBe(1);
    off();
    expect(listeners.get('accountsChanged')!.size).toBe(0);
    await w.disconnect();
    expect(rec.last('xcp_disconnect')).toBeDefined();
  });
});
