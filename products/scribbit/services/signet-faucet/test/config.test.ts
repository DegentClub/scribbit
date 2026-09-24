import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, loadServerConfig } from '../src/index.js';

const envSchema = JSON.parse(readFileSync(new URL('../env.schema.json', import.meta.url), 'utf8'));

describe('loadServerConfig', () => {
  it('defaults: wallet off, documented limits, public signet explorer', () => {
    const c = loadServerConfig({});
    expect(c.wallet).toBe('off');
    expect(c.port).toBe(3070);
    expect(c.app).toMatchObject({ dripSats: DEFAULTS.dripSats, dailyBudgetSats: DEFAULTS.dailyBudgetSats, powDifficulty: 20, addressDripsPerDay: 1, ipDripsPerDay: 3, challengeTtlMs: 300_000, explorerUrl: 'https://mempool.space/signet' });
  });

  it('bitcoind requires URL, wallet and credentials; never credentials in the URL', () => {
    expect(() => loadServerConfig({ FAUCET_WALLET: 'bitcoind' })).toThrow(ConfigError);
    expect(() => loadServerConfig({ FAUCET_WALLET: 'bitcoind', BITCOIND_RPC_URL: 'http://bitcoind.internal.example:38332', BITCOIND_RPC_WALLET: 'faucet' })).toThrow(/secret store/);
    expect(() => loadServerConfig({ FAUCET_WALLET: 'bitcoind', BITCOIND_RPC_URL: 'http://u:p@bitcoind.internal.example:38332', BITCOIND_RPC_WALLET: 'f', BITCOIND_RPC_USER: 'u', BITCOIND_RPC_PASSWORD: 'p' })).toThrow(/credentials/);
    const ok = loadServerConfig({ FAUCET_WALLET: 'bitcoind', BITCOIND_RPC_URL: 'http://bitcoind.internal.example:38332/', BITCOIND_RPC_WALLET: 'faucet', BITCOIND_RPC_USER: 'u', BITCOIND_RPC_PASSWORD: 'p' });
    expect(ok.bitcoind).toMatchObject({ url: 'http://bitcoind.internal.example:38332', wallet: 'faucet', timeoutMs: 15_000 });
  });

  it('validates numbers and relations', () => {
    expect(() => loadServerConfig({ FAUCET_WALLET: 'mainnet' })).toThrow(/FAUCET_WALLET/);
    expect(() => loadServerConfig({ DRIP_SATS: '100' })).toThrow(/DRIP_SATS/);
    expect(() => loadServerConfig({ DRIP_SATS: '50000', DAILY_BUDGET_SATS: '1000' })).toThrow(/DAILY_BUDGET_SATS/);
    expect(() => loadServerConfig({ POW_DIFFICULTY: '40' })).toThrow(/POW_DIFFICULTY/);
    expect(() => loadServerConfig({ PORT: 'x' })).toThrow(/PORT/);
    expect(loadServerConfig({ CORS_ORIGINS: 'https://scribb.it, http://localhost:5173' }).app.corsOrigins).toEqual(['https://scribb.it', 'http://localhost:5173']);
  });

  it('every variable config.ts reads is documented in env.schema.json', () => {
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const read = new Set([...src.matchAll(/(?:env|Env)\(env, '([A-Z_]+)'|env\.([A-Z_]+)/g)].map((m) => m[1] ?? m[2]));
    for (const v of read) expect(Object.keys(envSchema.properties), v).toContain(v);
  });
});
