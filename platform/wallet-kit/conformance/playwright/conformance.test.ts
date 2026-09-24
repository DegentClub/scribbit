/**
 * Real-browser conformance: fake providers (modelled on each adapter's assumptions) are injected into a
 * Chromium page with `addInitScript`, the bundled wallet-kit harness runs every step, and we assert what
 * jsdom cannot show us: real `window` injection timing, async provider round-trips through the page's
 * event loop, DOM rendering, and event listeners firing across the extension → page boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { buildConformance } from '../build.js';
import { startConformanceServer, type ConformanceServer } from '../serve.js';
import { FIXTURES } from '../fixtures.js';
import type { FakeCall, FakeWalletConfig, FakeWalletId } from '../fakes/providers.js';
import type { StepResult } from '../harness.js';
import { contextWithFakes, launchChromium, openHarness } from './browser.js';

let browser: Browser;
let server: ConformanceServer;
let fakesBundle: string;

beforeAll(async () => {
  ({ fakes: fakesBundle } = await buildConformance());
  server = await startConformanceServer();
  browser = await launchChromium();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const NET: Record<FakeWalletId, 'signet' | 'mainnet'> = { unisat: 'signet', xverse: 'signet', leather: 'signet', okx: 'signet', magiceden: 'mainnet' };

function config(wallet: FakeWalletId, over: Partial<FakeWalletConfig> = {}): FakeWalletConfig {
  const net = over.network ?? NET[wallet];
  const f = net === 'mainnet' ? FIXTURES.mainnet : FIXTURES.signet;
  return { wallets: [wallet], network: net, ordinals: f.ordinals, payment: f.payment, ...over };
}

async function runInPage(page: Page, wallet: FakeWalletId, opts: Record<string, unknown> = {}): Promise<StepResult[]> {
  return page.evaluate(([w, o]) => window.__walletKitHarness.run(w as never, o as never), [wallet, opts] as const);
}

const calls = (page: Page): Promise<FakeCall[]> => page.evaluate(() => window.__fakeWalletCalls);
const byStep = (rs: StepResult[]) => Object.fromEntries(rs.map((r) => [r.step, r.status]));

describe.each(['unisat', 'xverse', 'leather', 'okx', 'magiceden'] as FakeWalletId[])('%s adapter in a real browser', (wallet) => {
  it('passes every harness step and renders the table', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config(wallet));
    try {
      const page = await openHarness(ctx, server.url, NET[wallet]);
      expect(await page.evaluate(() => window.__walletKitHarness.detect())).toEqual([wallet]);
      const results = await runInPage(page, wallet, { network: NET[wallet] });
      const failed = results.filter((r) => r.status === 'fail');
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
      expect(byStep(results)).toEqual({ detect: 'pass', connect: 'pass', addresses: 'pass', signMessage: 'pass', signPsbt: 'pass', pushTx: 'skip', disconnect: 'pass' });

      // DOM: one row per step with the status attribute the CSS keys on.
      const rows = await page.$$eval('#results tbody tr', (trs) => trs.map((tr) => [tr.getAttribute('data-step'), tr.getAttribute('data-status')]));
      expect(rows.map((r) => r[0])).toEqual(['detect', 'connect', 'addresses', 'signMessage', 'signPsbt', 'pushTx', 'disconnect']);
      expect(await page.textContent('#summary')).toBe('6 passed, 0 failed, 1 skipped');

      // Kit events crossed the real event loop in order.
      const events = await page.evaluate(() => window.__walletKitHarness.events.map((e) => e.event));
      expect(events).toEqual(['connect', 'disconnect']);
    } finally {
      await ctx.close();
    }
  });

  it('maps a user rejection at connect to USER_REJECTED and skips the rest', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config(wallet, { rejectPrompts: true }));
    try {
      const page = await openHarness(ctx, server.url, NET[wallet]);
      const results = await runInPage(page, wallet, { network: NET[wallet] });
      const connect = results.find((r) => r.step === 'connect')!;
      expect(connect.status).toBe('fail');
      expect(connect.code).toBe('USER_REJECTED');
      expect(results.filter((r) => r.step !== 'detect' && r.step !== 'connect').every((r) => r.status === 'skip')).toBe(true);
      const events = await page.evaluate(() => window.__walletKitHarness.events);
      expect(events.map((e) => e.event)).toEqual(['error']);
    } finally {
      await ctx.close();
    }
  });
});

describe('provider call shapes observed in the browser', () => {
  it('UniSat: chain API switch is verified, PSBT goes as hex with toSignInputs + sighashTypes, pushTx takes { rawtx }', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('unisat', { unisatInitialChain: 'BITCOIN_MAINNET' }));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      const results = await runInPage(page, 'unisat', { network: 'signet', pushTx: true });
      expect(results.filter((r) => r.status === 'fail')).toEqual([]);
      const c = await calls(page);
      const methods = c.map((x) => x.method);
      expect(methods.slice(0, 5)).toEqual(['requestAccounts', 'getChain', 'switchChain', 'getChain', 'requestAccounts']);
      expect(c.find((x) => x.method === 'switchChain')!.args).toEqual(['BITCOIN_SIGNET']);
      const sign = c.find((x) => x.method === 'signPsbt')!;
      expect(sign.args[0]).toMatch(/^70736274ff/);
      expect(sign.args[1]).toEqual({ autoFinalized: false, toSignInputs: [{ index: 0, address: FIXTURES.signet.payment.address, sighashTypes: [0x81] }] });
      expect(c.find((x) => x.method === 'signMessage')!.args).toEqual([expect.any(String), 'bip322-simple']);
      expect(c.find((x) => x.method === 'pushTx')!.args).toEqual([{ rawtx: FIXTURES.signet.rawTxHex }]);
      expect(results.find((r) => r.step === 'pushTx')).toMatchObject({ status: 'pass', detail: expect.stringContaining('ab'.repeat(32)) });
    } finally {
      await ctx.close();
    }
  });

  it('UniSat legacy network API cannot select signet → UNSUPPORTED_NETWORK, but testnet works', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('unisat', { unisatLegacyNetworkApi: true, unisatInitialChain: 'BITCOIN_MAINNET' }));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      const signet = await runInPage(page, 'unisat', { network: 'signet' });
      expect(signet.find((r) => r.step === 'connect')).toMatchObject({ status: 'fail', code: 'UNSUPPORTED_NETWORK' });
      const testnet = await runInPage(page, 'unisat', { network: 'testnet' });
      expect(testnet.filter((r) => r.status === 'fail')).toEqual([]);
      expect((await calls(page)).find((x) => x.method === 'switchNetwork')!.args).toEqual(['testnet']);
    } finally {
      await ctx.close();
    }
  });

  it('Xverse: wallet_connect with Signet, signPsbt base64 with signInputs grouped by address, BIP322 signMessage', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('xverse'));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      const results = await runInPage(page, 'xverse', { network: 'signet' });
      expect(results.filter((r) => r.status === 'fail')).toEqual([]);
      const c = await calls(page);
      expect(c.find((x) => x.method === 'wallet_connect')!.args[0]).toMatchObject({ addresses: ['ordinals', 'payment'], network: 'Signet' });
      expect(c.find((x) => x.method === 'signPsbt')!.args[0]).toMatchObject({ psbt: expect.stringMatching(/^cHNidP/), signInputs: { [FIXTURES.signet.payment.address]: [0] }, broadcast: false });
      expect(c.find((x) => x.method === 'signMessage')!.args[0]).toMatchObject({ address: FIXTURES.signet.payment.address, protocol: 'BIP322' });
      expect(c.map((x) => x.method)).toContain('wallet_disconnect');
      expect(c.filter((x) => x.method === 'addListener').map((x) => x.args[0])).toEqual(['accountChange', 'networkChange']);
    } finally {
      await ctx.close();
    }
  });

  it('Xverse on the wrong network is refused before any address is used', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('xverse', { satsConnectReportedNetwork: 'Mainnet' }));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      const results = await runInPage(page, 'xverse', { network: 'signet' });
      expect(results.find((r) => r.step === 'connect')).toMatchObject({ status: 'fail', code: 'UNSUPPORTED_NETWORK' });
    } finally {
      await ctx.close();
    }
  });

  it('Leather: hex PSBT with signAtIndex + allowedSighash, signMessage by paymentType, ECDSA unsupported', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('leather'));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      const results = await runInPage(page, 'leather', { network: 'signet' });
      expect(results.filter((r) => r.status === 'fail')).toEqual([]);
      const c = await calls(page);
      expect(c.find((x) => x.method === 'signPsbt')!.args[0]).toEqual({ hex: expect.stringMatching(/^70736274ff/), signAtIndex: [0], network: 'signet', broadcast: false, allowedSighash: [0x81] });
      expect(c.find((x) => x.method === 'signMessage')!.args[0]).toEqual({ message: expect.any(String), paymentType: 'p2wpkh', network: 'signet' });
      const ecdsa = await runInPage(page, 'leather', { network: 'signet', signMessageType: 'ecdsa' });
      expect(ecdsa.find((r) => r.step === 'signMessage')).toMatchObject({ status: 'fail', code: 'UNSUPPORTED_METHOD' });
    } finally {
      await ctx.close();
    }
  });

  it('OKX: picks the per-network provider, connect() returns the single account', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('okx'));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      expect(await page.evaluate(() => Object.keys((window as unknown as { okxwallet: object }).okxwallet))).toEqual(['bitcoinSignet']);
      const results = await runInPage(page, 'okx', { network: 'signet', pushTx: true });
      expect(results.filter((r) => r.status === 'fail')).toEqual([]);
      const c = await calls(page);
      expect(c[0]!.method).toBe('connect');
      expect(c.find((x) => x.method === 'pushTx')!.args).toEqual([FIXTURES.signet.rawTxHex]); // OKX takes the raw string
      const testnet = await runInPage(page, 'okx', { network: 'testnet' });
      expect(testnet.find((r) => r.step === 'connect')).toMatchObject({ status: 'fail', code: 'UNSUPPORTED_NETWORK' });
    } finally {
      await ctx.close();
    }
  });

  it('Magic Eden legacy (sats-connect v1) surface: JWT tokens carry the request payloads', async () => {
    const ctx = await contextWithFakes(browser, fakesBundle, config('magiceden', { magicEdenLegacy: true }));
    try {
      const page = await openHarness(ctx, server.url, 'mainnet');
      const results = await runInPage(page, 'magiceden', { network: 'mainnet' });
      expect(results.filter((r) => r.status === 'fail')).toEqual([]);
      const c = await calls(page);
      expect(c.map((x) => x.method)).toEqual(['connect', 'signMessage', 'signTransaction']);
      expect(c[0]!.args[0]).toMatchObject({ purposes: ['ordinals', 'payment'], network: { type: 'Mainnet' } });
      expect(c[2]!.args[0]).toMatchObject({ psbtBase64: expect.stringMatching(/^cHNidP/), inputsToSign: [{ address: FIXTURES.mainnet.payment.address, signingIndexes: [0], sigHash: 0x81 }] });
    } finally {
      await ctx.close();
    }
  });
});

describe('extension → page events in a real browser', () => {
  it.each([
    ['unisat', 'accountsChanged'],
    ['xverse', 'accountChange'],
    ['okx', 'accountChanged'],
  ] as Array<[FakeWalletId, string]>)('%s firing %s drops the session and emits accountsChanged + disconnect', async (wallet, event) => {
    const ctx = await contextWithFakes(browser, fakesBundle, config(wallet));
    try {
      const page = await openHarness(ctx, server.url, 'signet');
      await page.evaluate(([w]) => window.__walletKitHarness.run(w as never, { network: 'signet' }), [wallet] as const);
      // Connect again and leave the session open, then have the "extension" switch accounts.
      const out = await page.evaluate(
        async ([w, ev]) => {
          const h = window.__walletKitHarness;
          h.clear();
          // run() creates a kit per run and leaves it on `kit`; reuse it for a session we keep open.
          await h.run(w as never, { network: 'signet' });
          const k = h.kit!;
          const wallet = await k.connect(w as never);
          const seen: string[] = [];
          k.on('accountsChanged', () => seen.push('accountsChanged'));
          k.on('disconnect', (p) => seen.push(`disconnect:${p.reason}`));
          const listeners = window.__fakeWallet.emit(w as never, ev);
          await new Promise((r) => setTimeout(r, 20));
          return { listeners, seen, current: k.current?.id ?? null, id: wallet.id };
        },
        [wallet, event] as const,
      );
      expect(out.listeners).toBeGreaterThan(0);
      expect(out.seen).toEqual(['accountsChanged', 'disconnect:accountsChanged']);
      expect(out.current).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
