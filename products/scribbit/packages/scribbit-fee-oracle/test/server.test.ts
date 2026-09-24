import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadServerConfig,
} from '../src/config.js';
import { createFeeOracle, feeClient, parseFeesResponse } from '../src/index.js';
import { createFeeServer } from '../src/server.js';
import { fakeFetch, flat, scriptedSource } from './helpers.js';

const contractPath = fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-fees.yaml', import.meta.url));
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

function makeApp() {
  const main = scriptedSource('m', { targets: { 1: 12, 3: 8, 6: 5, 144: 2 }, minRelay: 1 });
  const lr = scriptedSource('lr', { block: { min: 0.1, recommended: 6 } });
  const mainnet = createFeeOracle({ network: 'mainnet', sources: [main.source, lr.source] });
  const down = scriptedSource('down', flat(1));
  down.fail('ECONNREFUSED');
  const signet = createFeeOracle({ network: 'signet', sources: [down.source] });
  return { app: createFeeServer({ oracles: [mainnet, signet] }), main, down };
}

describe('fee server (contracts/openapi/scribbit-fees.yaml)', () => {
  it('GET /v1/fees returns a contract-valid, degent-compatible body', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/fees');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expectValid('FeesResponse', body);
    expect(body).toMatchObject({
      network: 'mainnet',
      minFeeRate: 1,
      standard: { slow: 2, normal: 8, fast: 12 },
      block: { min: 1, recommended: 6 },
      stale: false,
      sources: ['m', 'lr'],
    });
    // The degent mint FeesResponse keys are all present with the same types.
    for (const k of ['network', 'minFeeRate', 'standard', 'block', 'fetchedAt']) expect(body).toHaveProperty(k);
  });

  it('GET /v1/fees/sources reports health', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/fees/sources?network=mainnet');
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('SourcesHealthResponse', body);
    expect(body.status).toBe('ok');
    expect(body.sources.map((s: { id: string; kind: string }) => s.id)).toEqual(['m', 'lr']);

    const down = await (await app.request('/v1/fees/sources?network=signet')).json();
    expectValid('SourcesHealthResponse', down);
    expect(down.status).toBe('down');
    expect(down.sources[0]).toMatchObject({ id: 'down', ok: false, lastError: 'ECONNREFUSED' });
  });

  it('503 with fees_unavailable when no source works', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/fees?network=signet');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = await res.json();
    expectValid('Error', body);
    expect(body.error.code).toBe('fees_unavailable');
  });

  it('400 for an unknown network, 404 for one not served, 404 JSON for unknown routes', async () => {
    const { app } = makeApp();
    const bad = await app.request('/v1/fees?network=litecoin');
    expect(bad.status).toBe(400);
    expectValid('Error', await bad.json());
    const ns = await app.request('/v1/fees?network=regtest');
    expect(ns.status).toBe(404);
    expect((await ns.json()).error.details).toEqual({ served: ['mainnet', 'signet'] });
    const nr = await app.request('/nope');
    expect(nr.status).toBe(404);
    expectValid('Error', await nr.json());
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('marks stale responses no-store', async () => {
    let t = 0;
    const s = scriptedSource('s', flat(3));
    const oracle = createFeeOracle({ network: 'mainnet', sources: [s.source], ttlMs: 1000, now: () => t });
    const srv = createFeeServer({ oracles: [oracle] });
    await srv.request('/v1/fees');
    s.fail('down');
    t = 5_000;
    const res = await srv.request('/v1/fees');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).stale).toBe(true);
  });

  it('feeClient round-trips through the server', async () => {
    const { app } = makeApp();
    const fetch = (url: string, init?: RequestInit) => app.request(url.replace('http://fees.local', ''), init);
    const client = feeClient({ url: 'http://fees.local/', network: 'mainnet', fetch: async (u, i) => fetch(u, i) });
    const fees = await client.getFees();
    expect(fees.standard.fast).toBe(12);
    const wrong = feeClient({ url: 'http://fees.local/v1/fees', network: 'regtest', fetch: async (u, i) => fetch(u, i) });
    await expect(wrong.getFees()).rejects.toThrow('HTTP 404');
  });

  it('parseFeesResponse accepts a degent-shaped body and rejects a network mismatch', () => {
    const degent = { network: 'testnet', minFeeRate: 1, standard: { slow: 1, normal: 2, fast: 3 }, block: { min: 1, recommended: 2 }, fetchedAt: 'x' };
    expect(parseFeesResponse(degent)).toMatchObject({ stale: false, sources: [] });
    expect(() => parseFeesResponse(degent, 'mainnet')).toThrow('expected mainnet');
    expect(() => parseFeesResponse({ ...degent, block: { min: 0, recommended: 1 } })).toThrow('block.min');
  });
});

describe('loadServerConfig', () => {
  it('builds sources from the environment', () => {
    const { fetch } = fakeFetch({});
    const cfg = loadServerConfig(
      {
        FEE_NETWORK: 'testnet',
        MEMPOOL_URLS: 'http://192.0.2.103:8989, https://mempool.space/testnet4',
        MEMPOOL_BLOCKS_URLS: 'https://mempool.space/testnet4',
        ESPLORA_URLS: 'https://blockstream.info/testnet/api',
        BITCOIND_RPC_URL: 'http://192.0.2.201:48332',
        BITCOIND_RPC_USER: 'fees',
        BITCOIND_RPC_PASSWORD: 'pw',
        LIBRE_RELAY_RPC_URL: 'http://192.0.2.227:8332',
        BLOCK_LANE_PREMIUM: '1.1',
        FEE_TARGET_NORMAL: '6',
        PORT: '9000',
        CORS_ORIGINS: 'https://scribb.it,https://degent.club',
      },
      { fetch },
    );
    expect(cfg.network).toBe('testnet');
    expect(cfg.port).toBe(9000);
    expect(cfg.corsOrigins).toEqual(['https://scribb.it', 'https://degent.club']);
    expect(cfg.oracle.sources.map((s) => `${s.kind}:${s.id}`)).toEqual([
      'mempool-recommended:mempool:192.0.2.103:8989',
      'mempool-recommended:mempool:mempool.space/testnet4',
      'mempool-blocks:mempool-blocks:mempool.space/testnet4',
      'esplora:esplora:blockstream.info/testnet/api',
      'bitcoind:bitcoind:192.0.2.201:48332',
      'block-lane:block-lane:192.0.2.227:8332',
    ]);
    expect(cfg.oracle.config).toMatchObject({ minRelayFeeRate: 1, lane: { premium: 1.1 }, tiers: { normal: 6 } });
    expect(cfg.oracle.ttlMs).toBe(30_000);
  });

  it('collects every problem', () => {
    const err = (() => {
      try {
        loadServerConfig({ FEE_NETWORK: 'mainnet', STATIC_FEE_RATE: '2', PORT: 'x', FEE_TARGET_FAST: '2' });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error('expected ConfigError');
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.problems).toEqual([
      'STATIC_FEE_RATE is refused on mainnet',
      'PORT must be an integer >= 1 (got "x")',
      'FEE_TARGET_FAST must be one of 1, 3, 6, 144 (got 2)',
    ]);
    expect(() => loadServerConfig({ FEE_NETWORK: 'regtest' })).toThrow('no fee sources');
    expect(loadServerConfig({ FEE_NETWORK: 'regtest', STATIC_FEE_RATE: '1' }).oracle.sources[0]!.kind).toBe('static');
  });
});
