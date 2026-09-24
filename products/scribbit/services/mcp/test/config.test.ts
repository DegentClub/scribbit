import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '@bsh/edge';
import { ConfigError, feeProviderFor, keyStoreFrom, loadServerConfig, parseKeyRecords } from '../src/index.js';
import { mintKey } from '../src/mint-key.js';

const rec = (over: Record<string, unknown> = {}) => ({ id: 'k1', hash: generateApiKey('live').hash, env: 'live', scopes: ['mcp'], ...over });

describe('loadServerConfig', () => {
  it('defaults with one inline key', () => {
    const cfg = loadServerConfig({ MCP_API_KEYS_JSON: JSON.stringify([rec()]) });
    expect(cfg).toMatchObject({ port: 3050, host: '0.0.0.0', networks: ['mainnet'], keyEnv: 'live', requireApiKey: true, rateLimit: { ipPerMinute: 600, keyPerMinute: 120 }, maxBodyBytes: 8 * 1024 * 1024, feeUrls: {} });
    expect(cfg.keys).toHaveLength(1);
    expect(cfg.ledger).toBeUndefined();
  });

  it('ledger: URL and key together, http(s) only, never one without the other', () => {
    const env = { MCP_REQUIRE_API_KEY: 'false' };
    expect(loadServerConfig({ ...env, MCP_LEDGER_URL: 'http://ledger.internal:3050/', MCP_LEDGER_API_KEY: 'bsh_live_x' }).ledger).toEqual({ url: 'http://ledger.internal:3050/', apiKey: 'bsh_live_x' });
    expect(() => loadServerConfig({ ...env, MCP_LEDGER_URL: 'http://ledger.internal' })).toThrow(/MCP_LEDGER_API_KEY is required/);
    expect(() => loadServerConfig({ ...env, MCP_LEDGER_API_KEY: 'k' })).toThrow(/MCP_LEDGER_URL is not/);
    expect(() => loadServerConfig({ ...env, MCP_LEDGER_URL: 'not a url', MCP_LEDGER_API_KEY: 'k' })).toThrow(/MCP_LEDGER_URL/);
    expect(() => loadServerConfig({ ...env, MCP_LEDGER_URL: 'ftp://x', MCP_LEDGER_API_KEY: 'k' })).toThrow(/http\(s\)/);
  });

  it('refuses a key that both proposes and settles', () => {
    expect(() => loadServerConfig({ MCP_API_KEYS_JSON: JSON.stringify([rec({ scopes: ['mcp:order', 'mcp:settle'] })]) })).toThrow(/API key k1: scopes mcp:order and mcp:settle/);
  });

  it('refuses to start without keys unless MCP_REQUIRE_API_KEY=false', () => {
    expect(() => loadServerConfig({})).toThrow(ConfigError);
    expect(() => loadServerConfig({})).toThrow(/no API keys configured/);
    expect(loadServerConfig({ MCP_REQUIRE_API_KEY: 'false' }).requireApiKey).toBe(false);
  });

  it('refuses plaintext keys, bad hashes, env mismatches and duplicates', () => {
    expect(() => parseKeyRecords(JSON.stringify([rec({ key: 'bsh_live_x' })]), 'x')).toThrow(/plaintext/);
    expect(() => parseKeyRecords(JSON.stringify([rec({ hash: 'abc' })]), 'x')).toThrow(/SHA-256/);
    expect(() => parseKeyRecords(JSON.stringify([rec(), rec()]), 'x')).toThrow(/duplicate/);
    expect(() => parseKeyRecords('nope', 'x')).toThrow(/invalid JSON/);
    expect(() => parseKeyRecords('{}', 'x')).toThrow(/array/);
    expect(() => loadServerConfig({ MCP_API_KEYS_JSON: JSON.stringify([rec({ env: 'test' })]) })).toThrow(/test keys but MCP_API_KEY_ENV=live/);
    expect(() => loadServerConfig({ MCP_API_KEY_ENV: 'prod', MCP_API_KEYS_JSON: '[]', MCP_REQUIRE_API_KEY: '0' })).toThrow(/MCP_API_KEY_ENV/);
  });

  it('reads a keys file, merges it with inline keys, and loads them into a store that matches by hash', async () => {
    const a = generateApiKey('test');
    const b = generateApiKey('test');
    const files: Record<string, string> = { '/etc/keys.json': JSON.stringify([{ id: 'file', hash: a.hash, env: 'test', scopes: ['mcp'], quota: { limit: 5, windowMs: 60_000 }, expiresAt: 4102444800000 }]) };
    const cfg = loadServerConfig({ MCP_API_KEY_ENV: 'test', MCP_API_KEYS_FILE: '/etc/keys.json', MCP_API_KEYS_JSON: JSON.stringify([{ id: 'inline', hash: b.hash, env: 'test', scopes: ['mcp'], ownerId: 'o' }]) }, (p) => files[p]!);
    expect(cfg.keys.map((k) => k.id)).toEqual(['inline', 'file']);
    const store = keyStoreFrom(cfg.keys);
    expect((await store.findByHash(hashApiKey(a.key)))?.id).toBe('file');
    expect((await store.findByHash(hashApiKey(a.key)))?.quota).toEqual({ limit: 5, windowMs: 60_000 });
    expect(await store.findByHash(hashApiKey('bsh_test_nope'))).toBeUndefined();
    expect(() => loadServerConfig({ MCP_API_KEYS_FILE: '/missing' }, () => { throw new Error('ENOENT'); })).toThrow(/cannot read/);
  });

  it('parses networks, fee URLs, proxies, limits', () => {
    const cfg = loadServerConfig({
      MCP_REQUIRE_API_KEY: 'no',
      MCP_NETWORKS: 'mainnet, signet',
      MCP_FEE_URL_MAINNET: 'http://fees.internal/v1/fees',
      MCP_FEE_URL_SIGNET: 'OFF',
      MCP_FEE_URL_REGTEST: 'http://ignored',
      MCP_TRUSTED_PROXIES: '10.40.0.0/16',
      MCP_CORS_ORIGINS: 'https://app.scribb.it',
      MCP_RATE_LIMIT_KEY_PER_MIN: '10',
      MCP_MAX_BODY_BYTES: '65536',
      PORT: '4000',
      MCP_PUBLIC_URL: 'https://mcp.scribb.it',
    });
    expect(cfg).toMatchObject({ port: 4000, networks: ['mainnet', 'signet'], feeUrls: { mainnet: 'http://fees.internal/v1/fees', signet: 'off' }, trustedProxies: ['10.40.0.0/16'], corsOrigins: ['https://app.scribb.it'], rateLimit: { keyPerMinute: 10 }, maxBodyBytes: 65536, publicUrl: 'https://mcp.scribb.it' });
    expect(cfg.feeUrls).not.toHaveProperty('regtest');
    expect(() => loadServerConfig({ MCP_REQUIRE_API_KEY: 'no', MCP_NETWORKS: 'litecoin' })).toThrow(/unknown network/);
    expect(() => loadServerConfig({ MCP_REQUIRE_API_KEY: 'no', PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadServerConfig({ MCP_REQUIRE_API_KEY: 'maybe' })).toThrow(/MCP_REQUIRE_API_KEY/);
  });
});

describe('feeProviderFor', () => {
  it('picks the fee client for /v1/fees URLs, a mempool oracle otherwise, and nothing for regtest by default', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ network: 'signet', minFeeRate: 1, standard: { slow: 1, normal: 2, fast: 3 }, block: { min: 1, recommended: 2 }, fetchedAt: new Date().toISOString(), stale: false, sources: ['x'] }), { headers: { 'content-type': 'application/json' } });
    };
    const server = feeProviderFor('http://fees.internal/v1/fees', 'signet', fetchImpl)!;
    expect(server.kind).toBe('scribbit-fee-server');
    expect((await server.provider.getFees()).standard.normal).toBe(2);
    expect(calls[0]).toMatch(/^http:\/\/fees\.internal\/v1\/fees/);
    expect(feeProviderFor(undefined, 'mainnet')?.kind).toBe('mempool');
    expect(feeProviderFor(undefined, 'mainnet')?.url).toBe('https://mempool.space');
    expect(feeProviderFor(undefined, 'regtest')).toBeUndefined();
    expect(() => feeProviderFor('ftp://x', 'mainnet')).toThrow(/http\(s\)/);
    expect(() => feeProviderFor('not a url', 'mainnet')).toThrow(/invalid fee source/);
  });
});

describe('mint-key', () => {
  it('mints a key whose hash is the record hash; the record never holds the key', () => {
    const { key, hint, record } = mintKey(['--env', 'test', '--id', 'ci', '--owner', 'acct_9', '--scopes', 'mcp,other']);
    expect(key.startsWith('bsh_test_')).toBe(true);
    expect(record).toEqual({ id: 'ci', hash: hashApiKey(key), env: 'test', scopes: ['mcp', 'other'], ownerId: 'acct_9' });
    expect(hint.endsWith(key.slice(-4))).toBe(true);
    expect(JSON.stringify(record)).not.toContain(key.slice(9));
    expect(mintKey([]).record).toMatchObject({ env: 'live', scopes: ['mcp'] });
    expect(() => mintKey(['--env', 'prod'])).toThrow(/--env/);
    expect(() => mintKey(['--id'])).toThrow(/needs a value/);
    expect(() => mintKey(['bogus'])).toThrow(/unexpected/);
  });
});
