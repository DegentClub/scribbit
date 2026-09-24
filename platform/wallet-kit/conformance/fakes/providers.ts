/**
 * FAKE wallet providers for the conformance lab, modelled on the assumptions in `src/adapters/*` (see the
 * README "Support matrix" and "Verified vs assumed"). Injected into a real page by Playwright via
 * `page.addInitScript` BEFORE any page script runs, exactly where an extension would inject.
 *
 * Configuration comes from `window.__fakeWalletConfig` (set by an earlier init script); every provider
 * call is appended to `window.__fakeWalletCalls`; `window.__fakeWallet.emit(walletId, event)` fires the
 * account/network-change events each wallet family exposes.
 *
 * This file must stay dependency-free: it is bundled standalone (IIFE) by `conformance/build.ts`.
 */

export type FakeWalletId = 'unisat' | 'xverse' | 'leather' | 'okx' | 'magiceden';

export interface FakeAccount {
  address: string;
  publicKey: string;
}

export interface FakeWalletConfig {
  wallets: FakeWalletId[];
  network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  ordinals: FakeAccount;
  payment: FakeAccount;
  /** Every user-facing prompt (connect, sign) is rejected the way that wallet family rejects. */
  rejectPrompts?: boolean;
  /** Simulated wallet latency per call. */
  latencyMs?: number;
  /** UniSat: expose only the legacy getNetwork/switchNetwork API (no chain API). */
  unisatLegacyNetworkApi?: boolean;
  /** Magic Eden: expose only the sats-connect v1 surface (connect/signTransaction/signMessage with JWT tokens). */
  magicEdenLegacy?: boolean;
  /** UniSat: chain the wallet starts on (default: the requested network). */
  unisatInitialChain?: string;
  /** Xverse / Magic Eden: `wallet_connect` reports this network name (default: the configured network). */
  satsConnectReportedNetwork?: string;
  signature?: string;
  txid?: string;
}

export interface FakeCall {
  wallet: FakeWalletId;
  method: string;
  args: unknown[];
}

declare global {
  interface Window {
    __fakeWalletConfig?: FakeWalletConfig;
    __fakeWalletCalls: FakeCall[];
    __fakeWallet: { emit(wallet: FakeWalletId, event: string, payload?: unknown): number; config: FakeWalletConfig };
  }
}

const PSBT_B64_MAGIC = 'cHNidP';
const PSBT_HEX_MAGIC = '70736274ff';
const UNISAT_CHAINS: Record<string, string> = { mainnet: 'BITCOIN_MAINNET', testnet: 'BITCOIN_TESTNET4', signet: 'BITCOIN_SIGNET' };
const SATS_NETWORKS: Record<string, string> = { mainnet: 'Mainnet', testnet: 'Testnet4', signet: 'Signet', regtest: 'Regtest' };

function install(cfg: FakeWalletConfig): void {
  const w = window;
  const calls: FakeCall[] = (w.__fakeWalletCalls = []);
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const key = (wallet: string, ev: string) => `${wallet}:${ev}`;
  const signature = cfg.signature ?? 'AkgwRQIhAPfake-signature-base64=';
  const txid = cfg.txid ?? 'ab'.repeat(32);
  const wait = () => new Promise<void>((r) => setTimeout(r, cfg.latencyMs ?? 0));
  const record = (wallet: FakeWalletId, method: string, args: unknown[]) => calls.push({ wallet, method, args });

  const eip1193Reject = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const assertHexPsbt = (hex: unknown) => {
    if (typeof hex !== 'string' || !hex.toLowerCase().startsWith(PSBT_HEX_MAGIC)) throw new Error(`fake: expected hex PSBT, got ${String(hex).slice(0, 12)}`);
  };
  const assertB64Psbt = (b64: unknown) => {
    if (typeof b64 !== 'string' || !b64.startsWith(PSBT_B64_MAGIC)) throw new Error(`fake: expected base64 PSBT, got ${String(b64).slice(0, 12)}`);
  };

  w.__fakeWallet = {
    config: cfg,
    emit(wallet, event, payload) {
      const ls = listeners.get(key(wallet, event)) ?? [];
      for (const l of ls) l(payload);
      return ls.length;
    },
  };
  const on = (wallet: FakeWalletId, event: string, cb: (...a: unknown[]) => void) => {
    const k = key(wallet, event);
    listeners.set(k, [...(listeners.get(k) ?? []), cb]);
    return () => listeners.set(k, (listeners.get(k) ?? []).filter((x) => x !== cb));
  };

  // ---- UniSat family (UniSat, OKX): hex PSBTs, { autoFinalized, toSignInputs }, one account -------------
  const unisatFamily = (wallet: FakeWalletId, changeEvents: string[]) => ({
    async signPsbt(psbtHex: string, options?: unknown) {
      record(wallet, 'signPsbt', [psbtHex, options]);
      await wait();
      if (cfg.rejectPrompts) throw eip1193Reject();
      assertHexPsbt(psbtHex);
      return psbtHex;
    },
    async signMessage(message: string, type?: string) {
      record(wallet, 'signMessage', [message, type]);
      await wait();
      if (cfg.rejectPrompts) throw eip1193Reject();
      return signature;
    },
    async pushTx(arg: unknown) {
      record(wallet, 'pushTx', [arg]);
      await wait();
      return txid;
    },
    async pushPsbt(psbtHex: string) {
      record(wallet, 'pushPsbt', [psbtHex]);
      await wait();
      assertHexPsbt(psbtHex);
      return txid;
    },
    async disconnect() {
      record(wallet, 'disconnect', []);
    },
    on(event: string, handler: (...a: unknown[]) => void) {
      record(wallet, 'on', [event]);
      if (changeEvents.includes(event)) on(wallet, event, handler);
    },
    removeListener(event: string, handler: (...a: unknown[]) => void) {
      record(wallet, 'removeListener', [event]);
      const k = key(wallet, event);
      listeners.set(k, (listeners.get(k) ?? []).filter((x) => x !== handler));
    },
  });

  if (cfg.wallets.includes('unisat')) {
    let chain = cfg.unisatInitialChain ?? UNISAT_CHAINS[cfg.network] ?? 'BITCOIN_MAINNET';
    let legacyNet = chain === 'BITCOIN_MAINNET' ? 'livenet' : 'testnet';
    const base = {
      ...unisatFamily('unisat', ['accountsChanged', 'networkChanged', 'chainChanged']),
      async requestAccounts() {
        record('unisat', 'requestAccounts', []);
        await wait();
        if (cfg.rejectPrompts) throw eip1193Reject();
        return [cfg.payment.address];
      },
      async getAccounts() {
        record('unisat', 'getAccounts', []);
        return [cfg.payment.address];
      },
      async getPublicKey() {
        record('unisat', 'getPublicKey', []);
        return cfg.payment.publicKey;
      },
    };
    const chainApi = {
      async getChain() {
        record('unisat', 'getChain', []);
        return { enum: chain, name: chain, network: chain === 'BITCOIN_MAINNET' ? 'livenet' : 'testnet' };
      },
      async switchChain(c: string) {
        record('unisat', 'switchChain', [c]);
        await wait();
        if (cfg.rejectPrompts) throw eip1193Reject();
        chain = c;
        return { enum: chain };
      },
    };
    const legacyApi = {
      async getNetwork() {
        record('unisat', 'getNetwork', []);
        return legacyNet;
      },
      async switchNetwork(n: string) {
        record('unisat', 'switchNetwork', [n]);
        legacyNet = n;
        return n;
      },
    };
    (w as unknown as Record<string, unknown>).unisat = cfg.unisatLegacyNetworkApi ? { ...base, ...legacyApi } : { ...base, ...chainApi };
  }

  if (cfg.wallets.includes('okx')) {
    const provider = {
      ...unisatFamily('okx', ['accountChanged', 'accountsChanged']),
      async connect() {
        record('okx', 'connect', []);
        await wait();
        if (cfg.rejectPrompts) throw eip1193Reject();
        return { address: cfg.payment.address, publicKey: cfg.payment.publicKey, compressedPublicKey: cfg.payment.publicKey };
      },
    };
    const k = cfg.network === 'mainnet' ? 'bitcoin' : cfg.network === 'testnet' ? 'bitcoinTestnet' : 'bitcoinSignet';
    (w as unknown as Record<string, unknown>).okxwallet = { [k]: provider };
  }

  // ---- sats-connect dialect (Xverse, Magic Eden): request(method, params) resolving JSON-RPC envelopes ----
  const satsConnect = (wallet: 'xverse' | 'magiceden') => {
    const reported = cfg.satsConnectReportedNetwork ?? SATS_NETWORKS[cfg.network] ?? 'Mainnet';
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: '1', result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: '1', error: { code, message } });
    return {
      async request(method: string, params?: unknown) {
        record(wallet, method, [params]);
        await wait();
        switch (method) {
          case 'wallet_connect':
            if (cfg.rejectPrompts) return err(-32000, 'User rejected the request');
            return ok({
              addresses: [
                { address: cfg.ordinals.address, publicKey: cfg.ordinals.publicKey, purpose: 'ordinals', addressType: 'p2tr' },
                { address: cfg.payment.address, publicKey: cfg.payment.publicKey, purpose: 'payment', addressType: 'p2wpkh' },
              ],
              walletType: 'software',
              network: { bitcoin: { name: reported }, stacks: { name: reported } },
            });
          case 'signPsbt': {
            if (cfg.rejectPrompts) return err(-32000, 'User rejected the request');
            const p = params as { psbt?: unknown; signInputs?: unknown; broadcast?: boolean };
            assertB64Psbt(p.psbt);
            return ok({ psbt: p.psbt, ...(p.broadcast ? { txid } : {}) });
          }
          case 'signMessage':
            if (cfg.rejectPrompts) return err(-32000, 'User rejected the request');
            return ok({ signature, messageHash: 'aa'.repeat(32), address: (params as { address?: string }).address });
          case 'wallet_disconnect':
            return ok(null);
          default:
            return err(-32601, 'Method not found');
        }
      },
      addListener(event: string, cb: (...a: unknown[]) => void) {
        record(wallet, 'addListener', [event]);
        return on(wallet, event, cb);
      },
    };
  };

  if (cfg.wallets.includes('xverse')) (w as unknown as Record<string, unknown>).XverseProviders = { BitcoinProvider: satsConnect('xverse') };

  if (cfg.wallets.includes('magiceden')) {
    if (cfg.magicEdenLegacy) {
      // sats-connect v1: unsecured JWT tokens in, plain objects out.
      const payloadOf = (token: string) => JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
      const legacy = {
        async connect(token: string) {
          const p = payloadOf(token);
          record('magiceden', 'connect', [p]);
          await wait();
          if (cfg.rejectPrompts) throw new Error('User rejected the request');
          return {
            addresses: [
              { address: cfg.ordinals.address, publicKey: cfg.ordinals.publicKey, purpose: 'ordinals' },
              { address: cfg.payment.address, publicKey: cfg.payment.publicKey, purpose: 'payment' },
            ],
          };
        },
        async signTransaction(token: string) {
          const p = payloadOf(token);
          record('magiceden', 'signTransaction', [p]);
          await wait();
          if (cfg.rejectPrompts) throw new Error('User rejected the request');
          assertB64Psbt(p.psbtBase64);
          return { psbtBase64: p.psbtBase64, ...(p.broadcast ? { txId: txid } : {}) };
        },
        async signMessage(token: string) {
          const p = payloadOf(token);
          record('magiceden', 'signMessage', [p]);
          await wait();
          if (cfg.rejectPrompts) throw new Error('User rejected the request');
          return signature;
        },
      };
      (w as unknown as Record<string, unknown>).magicEden = { bitcoin: legacy };
    } else {
      (w as unknown as Record<string, unknown>).magicEden = { bitcoin: satsConnect('magiceden') };
    }
  }

  // ---- Leather: request(method, params) → { result } / rejects { error: { code: 4001 } } ---------------
  if (cfg.wallets.includes('leather')) {
    const reject = () => ({ jsonrpc: '2.0', id: '1', error: { code: 4001, message: 'User rejected request' } });
    (w as unknown as Record<string, unknown>).LeatherProvider = {
      async request(method: string, params?: unknown) {
        record('leather', method, [params]);
        await wait();
        switch (method) {
          case 'getAddresses':
            if (cfg.rejectPrompts) throw reject();
            return {
              jsonrpc: '2.0',
              id: '1',
              result: {
                addresses: [
                  { symbol: 'BTC', type: 'p2wpkh', address: cfg.payment.address, publicKey: cfg.payment.publicKey, derivationPath: "m/84'/1'/0'/0/0" },
                  { symbol: 'BTC', type: 'p2tr', address: cfg.ordinals.address, publicKey: cfg.ordinals.publicKey, tweakedPublicKey: cfg.ordinals.publicKey, derivationPath: "m/86'/1'/0'/0/0" },
                  { symbol: 'STX', address: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM' },
                ],
              },
            };
          case 'signPsbt': {
            if (cfg.rejectPrompts) throw reject();
            const p = params as { hex?: unknown; signAtIndex?: unknown; broadcast?: boolean };
            assertHexPsbt(p.hex);
            return { jsonrpc: '2.0', id: '1', result: { hex: p.hex, ...(p.broadcast ? { txid } : {}) } };
          }
          case 'signMessage': {
            if (cfg.rejectPrompts) throw reject();
            const p = params as { paymentType?: string };
            return { jsonrpc: '2.0', id: '1', result: { signature, address: p.paymentType === 'p2tr' ? cfg.ordinals.address : cfg.payment.address } };
          }
          default:
            throw { jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'Method not found' } };
        }
      },
    };
  }
}

if (typeof window !== 'undefined') {
  const cfg = window.__fakeWalletConfig;
  if (cfg) install(cfg);
}
