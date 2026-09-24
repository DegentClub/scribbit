import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { FeeProvider, FeesResponse } from '@bsh/scribbit-fee-oracle';
import { FeesUnavailableError } from '@bsh/scribbit-fee-oracle';
import { createApp, cpRoute, loadServerConfig, ConfigError, type FetchLike } from '../src/index.js';

const contractPath = fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-mint-api.yaml', import.meta.url));
const contract = parse(readFileSync(contractPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'contract');
const validator = (name: string) => ajv.getSchema(`contract#/components/schemas/${name}`)!;
function expectValid(name: string, body: unknown) {
  const v = validator(name);
  const ok = v(body);
  expect(v.errors ?? [], JSON.stringify(v.errors)).toEqual([]);
  expect(ok).toBe(true);
}
const allowedCodes: string[] = (validator('Error').schema as { properties: { error: { properties: { code: { enum: string[] } } } } }).properties.error.properties.code.enum;

const TXID = 'ab'.repeat(32);
const ADDR = 'bc1pqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsjq4d5l';

function fees(over: Partial<FeesResponse> = {}): FeesResponse {
  return { network: 'mainnet', minFeeRate: 1, standard: { slow: 1.5, normal: 4, fast: 6.2 }, block: { min: 1, recommended: 5.1 }, fetchedAt: '2026-09-23T12:00:00.000Z', stale: false, sources: ['fake'], ...over };
}
const feeProvider = (f: FeesResponse | Error = fees()): FeeProvider => ({ network: 'mainnet', getFees: async () => (f instanceof Error ? Promise.reject(f) : f) });

/** A fake Esplora + Counterparty upstream that records every call. */
function fakeUpstream() {
  const calls: { url: string; method: string; body?: string; contentType?: string }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}), ...(init?.headers ? { contentType: (init.headers as Record<string, string>)['content-type'] } : {}) });
    const u = new URL(url);
    if (u.host === 'esplora.test') {
      if (u.pathname.endsWith('/utxo')) return json([{ txid: TXID, vout: 1, value: 50_000, status: { confirmed: true, block_height: 900_000 } }, { txid: TXID, vout: 2, value: 600, status: { confirmed: false } }]);
      if (u.pathname === `/api/tx/${TXID}`) return json({ txid: TXID, version: 2, status: { confirmed: false } });
      if (u.pathname.startsWith('/api/tx/') && method === 'GET') return new Response('Transaction not found', { status: 404 });
      if (u.pathname === '/api/tx' && method === 'POST') return init?.body === 'dead' ? new Response('sendrawtransaction RPC error: bad-txns-inputs-missingorspent', { status: 400 }) : new Response(TXID);
    }
    if (u.host === 'cp.test') {
      if (u.pathname === '/v2/assets/NOPE') return json({ error: 'Asset not found' }, 404);
      if (u.pathname === '/v2/assets/SCRIBBIT') return json({ result: { asset: 'SCRIBBIT', owner: ADDR, divisible: false, locked: false } });
      if (u.pathname.endsWith('/compose/issuance') && method === 'POST') return json({ result: { rawtransaction: '02', btc_fee: 100, params: Object.fromEntries(new URLSearchParams(init?.body as string)) } });
      if (u.pathname === '/v2/bitcoin/transactions' && method === 'POST') return json({ result: TXID });
    }
    return new Response('unexpected upstream call', { status: 599 });
  };
  return { calls, fetch };
}

function makeApp(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const up = fakeUpstream();
  const app = createApp({ network: 'mainnet', esploraUrl: 'https://esplora.test/api/', cpUrl: 'https://cp.test/v2', fees: feeProvider(), fetch: up.fetch, corsOrigins: ['https://scribb.it'], ...over });
  return { app, up };
}

describe('contract (contracts/openapi/scribbit-mint-api.yaml)', () => {
  it('declares exactly the routes the app serves', () => {
    expect(Object.keys(contract.paths).sort()).toEqual(['/', '/api/cp/{path}', '/api/esplora/address/{addr}/utxo', '/api/esplora/tx', '/api/esplora/tx/{txid}', '/api/fees', '/healthz']);
  });

  it('GET / and /healthz match Index / Health and carry a request id', async () => {
    const { app } = makeApp({ publicUrl: 'https://api.scribb.it' });
    const idx = await app.request('/');
    expect(idx.status).toBe(200);
    expect(idx.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
    const body = await idx.json();
    expectValid('Index', body);
    expect(body.endpoints.cp.composes).toEqual(['addresses/{addr}/compose/issuance', 'addresses/{addr}/compose/fairminter']);
    const h = await app.request('/healthz');
    const hb = await h.json();
    expectValid('Health', hb);
    expect(hb).toMatchObject({ status: 'ok', network: 'mainnet', counterparty: true, fees: true });
    const noCp = await (await makeApp({ cpUrl: undefined }).app.request('/')).json();
    expect(noCp.endpoints.cp).toBeNull();
  });
});

describe('GET /api/fees', () => {
  it('serves the oracle snapshot as FeesResponse with a short cache', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/fees');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    expectValid('FeesResponse', await res.json());
  });
  it('stale snapshots are no-store; no source → 503 fees_unavailable', async () => {
    const stale = await makeApp({ fees: feeProvider(fees({ stale: true })) }).app.request('/api/fees');
    expect(stale.headers.get('cache-control')).toBe('no-store');
    const down = await makeApp({ fees: feeProvider(new FeesUnavailableError('all sources failed', { sources: [] })) }).app.request('/api/fees');
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('5');
    const body = await down.json();
    expectValid('Error', body);
    expect(body.error.code).toBe('fees_unavailable');
    const none = await makeApp({ fees: undefined }).app.request('/api/fees');
    expect(none.status).toBe(503);
  });
});

describe('Esplora proxy', () => {
  it('normalises UTXOs and validates the address first', async () => {
    const { app, up } = makeApp();
    const res = await app.request(`/api/esplora/address/${ADDR}/utxo`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expectValid('UtxoList', list);
    expect(list).toEqual([
      { txid: TXID, vout: 1, value: 50_000, status: { confirmed: true, block_height: 900_000 } },
      { txid: TXID, vout: 2, value: 600, status: { confirmed: false } },
    ]);
    expect(up.calls[0]!.url).toBe(`https://esplora.test/api/address/${ADDR}/utxo`);
    const bad = await app.request('/api/esplora/address/not%20an%20address/utxo');
    expect(bad.status).toBe(400);
    expect(up.calls).toHaveLength(1);
  });

  it('GET /tx/:txid passes the transaction through; unknown → 404; malformed → 400', async () => {
    const { app } = makeApp();
    const ok = await app.request(`/api/esplora/tx/${TXID}`);
    expect(ok.status).toBe(200);
    expectValid('Transaction', await ok.json());
    const missing = await app.request(`/api/esplora/tx/${'cd'.repeat(32)}`);
    expect(missing.status).toBe(404);
    expectValid('Error', await missing.json());
    expect((await app.request('/api/esplora/tx/zz')).status).toBe(400);
  });

  it('POST /tx broadcasts hex as text/plain and returns the txid; node rejections are 400 broadcast_rejected', async () => {
    const { app, up } = makeApp();
    const res = await app.request('/api/esplora/tx', { method: 'POST', body: '0200aa' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('BroadcastResult', body);
    expect(body.txid).toBe(TXID);
    expect(up.calls[0]).toMatchObject({ url: 'https://esplora.test/api/tx', method: 'POST', body: '0200aa', contentType: 'text/plain' });
    const rejected = await app.request('/api/esplora/tx', { method: 'POST', body: 'dead' });
    expect(rejected.status).toBe(400);
    const rb = await rejected.json();
    expect(rb.error.code).toBe('broadcast_rejected');
    expect(rb.error.message).toContain('missingorspent');
    expect((await app.request('/api/esplora/tx', { method: 'POST', body: 'not hex' })).status).toBe(400);
    expect((await app.request('/api/esplora/tx', { method: 'POST', body: '' })).status).toBe(400);
  });

  it('upstream failures and timeouts are 502 / 504', async () => {
    const down = createApp({ network: 'mainnet', esploraUrl: 'https://esplora.test/api', fetch: async () => Promise.reject(new Error('ECONNREFUSED')) });
    const r = await down.request(`/api/esplora/tx/${TXID}`);
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe('upstream_error');
    const slow = createApp({
      network: 'mainnet',
      esploraUrl: 'https://esplora.test/api',
      limits: { upstreamTimeoutMs: 5 },
      fetch: (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const t = await slow.request(`/api/esplora/tx/${TXID}`);
    expect(t.status).toBe(504);
    expect((await t.json()).error.code).toBe('upstream_timeout');
  });
});

describe('Counterparty proxy allowlist', () => {
  it.each([
    ['GET', 'assets/SCRIBBIT', 'read'],
    ['GET', `addresses/${ADDR}/balances`, 'read'],
    ['GET', `addresses/${ADDR}/balances/XCP`, 'read'],
    ['GET', `addresses/${ADDR}/assets`, 'read'],
    ['GET', `addresses/${ADDR}/assets/owned`, 'read'],
    ['GET', 'blocks/last', 'read'],
    ['GET', `bitcoin/transactions/${TXID}`, 'read'],
    ['POST', `addresses/${ADDR}/compose/issuance`, 'compose'],
    ['POST', `addresses/${ADDR}/compose/fairminter`, 'compose'],
    ['POST', 'bitcoin/transactions', 'broadcast'],
  ])('%s %s is allowed as %s', (method, path, kind) => {
    expect(cpRoute(method, path)?.kind).toBe(kind);
  });

  it.each([
    ['GET', ''],
    ['GET', 'addresses/x/balances'],
    ['GET', `addresses/${ADDR}/compose/issuance`],
    ['GET', 'bitcoin/transactions'],
    ['GET', 'assets/SCRIBBIT/fairminters'],
    ['GET', 'pools/A/B'],
    ['POST', `addresses/${ADDR}/compose/send`],
    ['POST', `addresses/${ADDR}/compose/order`],
    ['POST', `addresses/${ADDR}/compose/pooldeposit`],
    ['POST', 'assets/SCRIBBIT'],
    ['DELETE', 'assets/SCRIBBIT'],
    ['PUT', 'bitcoin/transactions'],
    ['GET', '../assets/SCRIBBIT'],
  ])('%s %s is refused', (method, path) => {
    expect(cpRoute(method, path)).toBeNull();
  });

  it('proxies allowed reads with status and body passed through (404 included)', async () => {
    const { app, up } = makeApp();
    const ok = await app.request('/api/cp/assets/SCRIBBIT?verbose=true');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = await ok.json();
    expectValid('CpEnvelope', body);
    expect(body.result.asset).toBe('SCRIBBIT');
    expect(up.calls[0]!.url).toBe('https://cp.test/v2/assets/SCRIBBIT?verbose=true');
    const missing = await app.request('/api/cp/assets/NOPE');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('Asset not found');
  });

  it('forwards composes as form bodies and refuses other media types', async () => {
    const { app, up } = makeApp();
    const form = new URLSearchParams({ asset: 'SCRIBBIT', description: 'deadbeef', mime_type: 'image/png', encoding: 'taproot' }).toString();
    const res = await app.request(`/api/cp/addresses/${ADDR}/compose/issuance`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).result.params.description).toBe('deadbeef');
    expect(up.calls[0]).toMatchObject({ method: 'POST', body: form, contentType: 'application/x-www-form-urlencoded' });
    const json = await app.request(`/api/cp/addresses/${ADDR}/compose/issuance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(415);
  });

  it('relays a signed hex and validates it first', async () => {
    const { app, up } = makeApp();
    const ok = await app.request('/api/cp/bitcoin/transactions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'signedhex=0200aa' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).result).toBe(TXID);
    const bad = await app.request('/api/cp/bitcoin/transactions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'signedhex=zz' });
    expect(bad.status).toBe(400);
    expect(up.calls).toHaveLength(1);
  });

  it('denies everything else with 403 without touching the node; 503 when no node is configured', async () => {
    const { app, up } = makeApp();
    for (const [method, path] of [
      ['GET', '/api/cp/pools/A/B'],
      ['POST', `/api/cp/addresses/${ADDR}/compose/send`],
      ['DELETE', '/api/cp/assets/SCRIBBIT'],
      ['GET', '/api/cp/'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = await res.json();
      expectValid('Error', body);
      expect(body.error.code).toBe('cp_not_allowed');
    }
    expect(up.calls).toHaveLength(0);
    const none = await makeApp({ cpUrl: undefined }).app.request('/api/cp/blocks/last');
    expect(none.status).toBe(503);
    expect((await none.json()).error.code).toBe('cp_unavailable');
  });

  it('size-limits composes and broadcasts (413)', async () => {
    const { app } = makeApp({ limits: { maxComposeBytes: 2048, maxBroadcastBytes: 1024 } });
    const big = await app.request(`/api/cp/addresses/${ADDR}/compose/issuance`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '4096' }, body: 'x'.repeat(4096) });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe('payload_too_large');
    const bigTx = await app.request('/api/esplora/tx', { method: 'POST', headers: { 'content-length': '2048' }, body: 'a'.repeat(2048) });
    expect(bigTx.status).toBe(413);
  });
});

describe('edge behaviour', () => {
  it('every error body matches Error with a code from the contract enum', async () => {
    const { app } = makeApp({ rateLimit: { ipPerMinute: 3 } });
    const responses = [
      await app.request('/nope'),
      await app.request('/api/esplora/tx/zz'),
      await app.request('/api/cp/pools/A/B'),
      await app.request('/api/fees'), // 4th call: rate limited
    ];
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.json();
      expectValid('Error', body);
      expect(allowedCodes, `${res.status} ${body.error.code}`).toContain(body.error.code);
    }
    expect(responses[3]!.status).toBe(429);
    expect(responses[3]!.headers.get('retry-after')).toBeTruthy();
  });

  it('CORS is an exact allowlist', async () => {
    const { app } = makeApp();
    const ok = await app.request('/api/fees', { headers: { origin: 'https://scribb.it' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://scribb.it');
    const other = await app.request('/api/fees', { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await app.request('/api/esplora/tx', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(403);
  });

  it('security headers are on', async () => {
    const { app } = makeApp();
    const res = await app.request('/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('config', () => {
  it('defaults per network, validates URLs and numbers', () => {
    const c = loadServerConfig({ MINT_NETWORK: 'signet', CP_API_URL: 'https://cp.test/v2/', CORS_ORIGINS: 'https://scribb.it, http://localhost:5173' });
    expect(c).toMatchObject({ network: 'signet', esploraUrl: 'https://mempool.space/signet/api', cpUrl: 'https://cp.test/v2', corsOrigins: ['https://scribb.it', 'http://localhost:5173'], port: 3060, feeUrl: undefined });
    expect(loadServerConfig({ FEE_URL: 'off' }).feeUrl).toBe('off');
    expect(() => loadServerConfig({ MINT_NETWORK: 'bogus' })).toThrow(ConfigError);
    expect(() => loadServerConfig({ MINT_NETWORK: 'regtest' })).toThrow(/ESPLORA_URL is required/);
    expect(() => loadServerConfig({ ESPLORA_URL: 'ftp://x' })).toThrow(/http\(s\)/);
    expect(() => loadServerConfig({ RATE_LIMIT_IP_PER_MIN: 'ten' })).toThrow(/integer/);
  });
});
