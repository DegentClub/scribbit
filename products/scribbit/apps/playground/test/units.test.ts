// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { GOAL_SECONDS, verifyPow } from '@bsh/scribbit-playground-kit';
import { WALLET_IDS } from '@bsh/wallet-kit';
import { readConfig, normalizeBase, txUrl, xrayUrl } from '../src/config';
import { deriveKeys, exportBackup, generateThrowaway, loadThrowaway, saveThrowaway, signLocally, THROWAWAY_KEY, throwawayWallet } from '../src/lib/throwaway';
import { CLIENT_MAX_DIFFICULTY, createWorkerSolver, solveOnMainThread } from '../src/lib/pow';
import { createHttpFaucet } from '../src/services/real/faucet';
import { createEsploraChain } from '../src/services/real/esplora';
import { createAnalytics } from '../src/services/real/analytics';
import { BroadcastRejectedError, FaucetError } from '../src/services/types';
import { signetStatuses, STATUSES, summaryLine } from '../src/lib/walletStatus';
import { faucetMessage } from '../src/steps/CoinsStep';
import { staticFiles } from '../scripts/emit-static';
import { snapshot } from '../scripts/sync-wallet-conformance.mjs';
import { memoryStore } from './helpers';

describe('config', () => {
  it('defaults are signet, demo is opt-in, analytics off', () => {
    const c = readConfig({}, '');
    expect(c).toMatchObject({ demo: false, faucetUrl: '', esploraUrl: 'https://mempool.space/signet/api', explorerUrl: 'https://mempool.space/signet', ordUrl: 'https://signet.ordinals.com', xrayUrl: 'https://block.space/xray', analyticsUrl: '', maxFileBytes: 51_200, feeRate: null, minFeeRate: 1, goalSeconds: GOAL_SECONDS, format: 'html' });
    expect(readConfig({}, '?demo=1').demo).toBe(true);
    expect(readConfig({ VITE_DEMO_DEFAULT: '1' }, '').demo).toBe(true);
    expect(readConfig({ VITE_DEMO_DEFAULT: '1' }, '?demo=0').demo).toBe(false);
    expect(readConfig({}, '?format=json').format).toBe('json');
  });

  it('env overrides; non-http URLs are ignored (never javascript:)', () => {
    const c = readConfig({ VITE_FAUCET_URL: 'https://faucet.scribbit.internal.example/', VITE_XRAY_URL: 'javascript:alert(1)', VITE_EXPLORER_URL: 'https://explorer.internal.example/signet/', VITE_ANALYTICS_URL: 'https://a.internal.example/e', VITE_MAX_FILE_BYTES: '1000', VITE_FEE_RATE: '2.5', VITE_MIN_FEE_RATE: 'x' }, '');
    expect(c.faucetUrl).toBe('https://faucet.scribbit.internal.example');
    expect(c.xrayUrl).toBe('https://block.space/xray');
    expect(txUrl(c, 'ab')).toBe('https://explorer.internal.example/signet/tx/ab');
    expect(xrayUrl(c, 'ab')).toBe('https://block.space/xray/ab');
    expect(c).toMatchObject({ analyticsUrl: 'https://a.internal.example/e', maxFileBytes: 1000, feeRate: 2.5, minFeeRate: 1 });
    expect(normalizeBase('./')).toBe('./');
    expect(normalizeBase('/scribbit/playground')).toBe('/scribbit/playground/');
  });
});

describe('throwaway key', () => {
  it('is a signet key: tb1p address, testnet WIF, signet-tagged record; bad records are refused', () => {
    const store = memoryStore();
    const rec = generateThrowaway();
    saveThrowaway(store, rec);
    expect(loadThrowaway(store)).toEqual(rec);
    const keys = deriveKeys(rec);
    expect(keys.address).toMatch(/^tb1p[02-9ac-hj-np-z]{58}$/);
    const { wif, descriptor } = exportBackup(rec);
    expect(wif).toMatch(/^c/);
    expect(descriptor).toBe(`tr(${wif})`);
    expect(() => btc.WIF(btc.NETWORK).decode(wif)).toThrow();
    store.setItem(THROWAWAY_KEY, JSON.stringify({ ...rec, network: 'mainnet' }));
    expect(loadThrowaway(store)).toBeNull();
    store.setItem(THROWAWAY_KEY, '{nope');
    expect(loadThrowaway(store)).toBeNull();
    expect(loadThrowaway(null)).toBeNull();
  });

  it('signs a key-path input with the tweaked key (valid Schnorr) and refuses foreign addresses', () => {
    const rec = generateThrowaway(() => new Uint8Array(32).fill(7));
    const w = throwawayWallet(rec);
    const out = btc.p2tr(w.keys.internal, undefined, btc.TEST_NETWORK);
    const tx = new btc.Transaction();
    tx.addInput({ txid: '11'.repeat(32), index: 0, witnessUtxo: { script: out.script, amount: 10_000n }, tapInternalKey: w.keys.internal });
    tx.addOutputAddress(w.keys.address, 9_000n, btc.TEST_NETWORK);
    const psbt = base64.encode(tx.toPSBT());
    const signed = btc.Transaction.fromPSBT(base64.decode(signLocally(w.keys, psbt, { inputsToSign: [{ index: 0, address: w.keys.address }], finalize: true })));
    expect(signed.isFinal).toBe(true);
    expect(signed.getInput(0).finalScriptWitness![0]!.length).toBe(64);
    expect(() => signLocally(w.keys, psbt, { inputsToSign: [{ index: 0, address: 'tb1qsomeoneelse' }] })).toThrow(/not the throwaway key/);
    expect(w.plan).toMatchObject({ leafKeyKind: 'internal', sighash: 'default', broadcastVia: 'esplora' });
  });
});

describe('proof-of-work solver', () => {
  const ADDR = 'tb1pexampleexampleexampleexampleexampleexampleexampleexampleexam';
  it('main-thread solver finds a verifying solution and reports progress', async () => {
    const seen: number[] = [];
    const r = await solveOnMainThread({ nonce: 'aa', address: ADDR, difficulty: 13, onProgress: (p) => seen.push(p.hashes) });
    expect(verifyPow({ nonce: 'aa', address: ADDR, solution: r.solution, difficulty: 13 })).toBe(true);
    expect(r.via).toBe('main');
  });

  it('refuses an absurd difficulty instead of burning the CPU; can be aborted', async () => {
    await expect(solveOnMainThread({ nonce: 'aa', address: ADDR, difficulty: CLIENT_MAX_DIFFICULTY + 1 })).rejects.toThrow(/stops at/);
    const ctl = new AbortController();
    const p = solveOnMainThread({ nonce: 'aa', address: ADDR, difficulty: 26, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow(/abort/);
  });

  it('worker solver relays progress and the answer, and terminates the worker', async () => {
    let terminated = 0;
    const fakeWorker = () => {
      const w = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        terminate: () => void terminated++,
        postMessage: (req: { nonce: string }) => {
          setTimeout(() => w.onmessage?.({ data: { type: 'progress', hashes: 8192, fraction: 0.5 } } as MessageEvent));
          setTimeout(() => w.onmessage?.({ data: { type: 'done', solution: '42', hashes: 43, nonce: req.nonce } } as MessageEvent));
        },
      };
      return w as unknown as Worker;
    };
    const seen: number[] = [];
    const r = await createWorkerSolver(fakeWorker)({ nonce: 'aa', address: ADDR, difficulty: 10, onProgress: (p) => seen.push(p.hashes) });
    expect(r).toEqual({ solution: '42', hashes: 43, via: 'worker' });
    expect(seen).toEqual([8192]);
    expect(terminated).toBe(1);
  });
});

describe('real adapters (fake fetch, offline)', () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('faucet: challenge and drip per the contract; refusals keep their code and Retry-After', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = createHttpFaucet('https://faucet.scribbit.internal.example/', async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/v1/challenge')) return json({ algorithm: 'sha256-leading-zero-bits/v1', nonce: 'ab'.repeat(16), difficulty: 20, expiresAt: '2026-09-24T12:05:00Z', ttlSeconds: 300, message: 'm' });
      return json({ error: { code: 'address_rate_limited', message: 'already', requestId: 'r' } }, 429, { 'retry-after': '120' });
    });
    expect(f.configured).toBe(true);
    expect((await f.challenge()).difficulty).toBe(20);
    const err = await f.drip({ address: 'tb1q', nonce: 'ab'.repeat(16), solution: '1' }).catch((e) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect(err).toMatchObject({ code: 'address_rate_limited', retryAfterSeconds: 120 });
    expect(calls[1]!.url).toBe('https://faucet.scribbit.internal.example/v1/drip');
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ address: 'tb1q', nonce: 'ab'.repeat(16), solution: '1' });
    const down = createHttpFaucet('https://faucet.scribbit.internal.example', async () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(down.challenge()).rejects.toMatchObject({ code: 'unreachable' });
    const none = createHttpFaucet('');
    expect(none.configured).toBe(false);
    await expect(none.challenge()).rejects.toMatchObject({ code: 'faucet_disabled' });
  });

  it('faucet requests and responses validate against the OpenAPI contract', () => {
    const contract = parse(readFileSync(fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-signet-faucet.yaml', import.meta.url)), 'utf8'));
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(contract, 'c');
    const v = (n: string, x: unknown) => ajv.getSchema(`c#/components/schemas/${n}`)!(x);
    expect(v('DripRequest', { address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', nonce: 'ab'.repeat(16), solution: '123' })).toBe(true);
    // Every refusal code the UI explains exists in the contract.
    const codes: string[] = contract.components.schemas.Error.properties.error.properties.code.enum;
    for (const c of ['faucet_empty', 'address_rate_limited', 'ip_rate_limited', 'rate_limited', 'budget_exhausted', 'faucet_disabled', 'challenge_expired', 'challenge_used', 'challenge_unknown', 'pow_invalid', 'mainnet_address_refused', 'wrong_network', 'invalid_address', 'wallet_unavailable']) {
      expect(codes).toContain(c);
      expect(faucetMessage(new FaucetError(c, 'm')).title).not.toBe('The faucet said no');
    }
  });

  it('esplora: UTXOs, fee estimate (floored, fixed override), broadcast; 400 is a typed rejection', async () => {
    const chain = createEsploraChain('https://esplora.internal.example/signet/api/', {
      fetch: async (url, init) => {
        if (url.endsWith('/utxo')) return json([{ txid: 'ab'.repeat(32), vout: 1, value: 50_000, status: { confirmed: false } }]);
        if (url.endsWith('/fee-estimates')) return json({ '1': 0.5, '3': 0.25, '6': 0.2 });
        if (url.endsWith('/status')) return json({ confirmed: true, block_height: 250_001 });
        if (url.endsWith('/tx') && init?.method === 'POST') return init.body === 'bad' ? new Response('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}', { status: 400 }) : new Response('cd'.repeat(32));
        return new Response('nope', { status: 404 });
      },
    });
    expect(await chain.getUtxos('tb1q')).toEqual([{ txid: 'ab'.repeat(32), vout: 1, value: 50_000, status: { confirmed: false } }]);
    expect(await chain.getFeeRate()).toBe(1);
    expect(await chain.getTx('ab'.repeat(32))).toEqual({ txid: 'ab'.repeat(32), confirmed: true, blockHeight: 250_001 });
    expect(await chain.broadcast('00')).toBe('cd'.repeat(32));
    const e = await chain.broadcast('bad').catch((x) => x);
    expect(e).toBeInstanceOf(BroadcastRejectedError);
    expect(e.reason).toMatch(/min relay fee not met/);
    const fixed = createEsploraChain('https://x.internal.example', { fixedFeeRate: 3, fetch: async () => json({}) });
    expect(await fixed.getFeeRate()).toBe(3);
  });

  it('analytics: off sends nothing; on sends exactly five fields without credentials or referrer', async () => {
    const sent: RequestInit[] = [];
    const off = createAnalytics('', async (_u, i) => (sent.push(i!), new Response()));
    expect(off.enabled).toBe(false);
    await off.send({ event: 'playground.quiz', version: '1', passed: true, score: 3, total: 3 });
    expect(sent).toHaveLength(0);
    const on = createAnalytics('https://a.internal.example/e', async (_u, i) => (sent.push(i!), new Response()));
    await on.send({ event: 'playground.quiz', version: '1', passed: false, score: 1, total: 3, address: 'tb1q-leak' } as never);
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ event: 'playground.quiz', version: '1', passed: false, score: 1, total: 3 });
    expect(sent[0]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    const failing = createAnalytics('https://a.internal.example/e', async () => Promise.reject(new Error('offline')));
    await expect(failing.send({ event: 'playground.quiz', version: '1', passed: true, score: 3, total: 3 })).resolves.toBeUndefined();
  });
});

describe('wallet conformance snapshot', () => {
  it('covers every wallet-kit adapter with valid statuses; counts are computed, not stored', () => {
    const list = signetStatuses();
    expect(list.map((s) => s.id).sort()).toEqual([...WALLET_IDS].sort());
    for (const s of list) {
      expect(STATUSES).toContain(s.signet);
      expect(STATUSES).toContain(s.leafSigning);
    }
    expect(summaryLine(list)).toMatch(/^\d+ of \d+ wallets verified on signet; \d+ not supported on signet/);
    expect(summaryLine([])).toMatch(/^0 of 0/);
  });

  const specs = fileURLToPath(new URL('../../../../../../specs/conformance/wallets.yaml', import.meta.url));
  it.skipIf(!existsSync(specs))('is fresh against DegentClub/specs when that checkout is present', () => {
    const current = JSON.parse(readFileSync(new URL('../src/data/wallet-signet.json', import.meta.url), 'utf8'));
    expect(current).toEqual(snapshot(readFileSync(specs, 'utf8')));
  });
});

describe('static twins', () => {
  it('playground.json and sitemap.xml are generated from the kit and the config', () => {
    const files = staticFiles({ VITE_SITE_URL: 'https://example.org/playground' });
    const doc = JSON.parse(files['playground.json']!);
    expect(doc.steps.map((s: { id: string }) => s.id)).toEqual(['wallet', 'coins', 'file', 'inscribe', 'certificate']);
    expect(doc.quiz).toHaveLength(3);
    expect(doc.endpoints.faucet).toBeNull();
    expect(files['sitemap.xml']).toContain('<loc>https://example.org/playground/</loc>');
    expect(files['sitemap.xml']).toContain('<loc>https://example.org/playground/llms.txt</loc>');
  });

  it('llms.txt and index.html carry the machine surface (llms.txt, JSON-LD, OpenGraph, JSON alternate)', () => {
    const llms = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8');
    expect(llms).toMatch(/^# scribb\.it Signet Playground/);
    expect(llms).toContain('playground.json');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(ld['@type']).toContain('LearningResource');
    expect(ld.timeRequired).toBe('PT5M');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('type="application/json" href="playground.json"');
    expect(html).not.toMatch(/\.pve\b|hs\.skrybit|10\.40\./);
  });
});
