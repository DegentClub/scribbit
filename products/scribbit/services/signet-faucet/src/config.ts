/** Environment parsing (documented in env.schema.json). The RPC password is the only secret; it comes from the secret store. */
import { DEFAULTS, type FaucetOptions } from './app.js';
import type { WalletKind } from './wallet.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  port: number;
  host: string;
  wallet: WalletKind;
  bitcoind?: { url: string; wallet: string; user: string; password: string; timeoutMs: number };
  fakeBalanceSats: number;
  app: Omit<FaucetOptions, 'wallet' | 'now' | 'random' | 'onUnexpected'>;
}

type Env = Record<string, string | undefined>;

const intEnv = (env: Env, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
};

const listEnv = (env: Env, name: string): string[] =>
  (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const urlEnv = (env: Env, name: string): string | undefined => {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new ConfigError(`${name} must be http(s)`);
  if (u.username || u.password) throw new ConfigError(`${name} must not carry credentials; use BITCOIND_RPC_USER / BITCOIND_RPC_PASSWORD`);
  return raw.replace(/\/+$/, '');
};

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const walletRaw = (env.FAUCET_WALLET?.trim() || 'off').toLowerCase();
  if (!['off', 'bitcoind', 'fake'].includes(walletRaw)) throw new ConfigError(`FAUCET_WALLET must be off | bitcoind | fake (got "${walletRaw}")`);
  const wallet = walletRaw as WalletKind;
  let bitcoind: ServerConfig['bitcoind'];
  if (wallet === 'bitcoind') {
    const url = urlEnv(env, 'BITCOIND_RPC_URL');
    const name = env.BITCOIND_RPC_WALLET?.trim();
    const user = env.BITCOIND_RPC_USER ?? '';
    const password = env.BITCOIND_RPC_PASSWORD ?? '';
    if (!url) throw new ConfigError('BITCOIND_RPC_URL is required with FAUCET_WALLET=bitcoind');
    if (!name) throw new ConfigError('BITCOIND_RPC_WALLET is required with FAUCET_WALLET=bitcoind');
    if (!user || !password) throw new ConfigError('BITCOIND_RPC_USER and BITCOIND_RPC_PASSWORD are required with FAUCET_WALLET=bitcoind (from the secret store)');
    bitcoind = { url, wallet: name, user, password, timeoutMs: intEnv(env, 'BITCOIND_RPC_TIMEOUT_MS', 15_000, 100) };
  }
  const dripSats = intEnv(env, 'DRIP_SATS', DEFAULTS.dripSats, 330, 10_000_000);
  const dailyBudgetSats = intEnv(env, 'DAILY_BUDGET_SATS', DEFAULTS.dailyBudgetSats, 330);
  if (dailyBudgetSats < dripSats) throw new ConfigError('DAILY_BUDGET_SATS must be at least DRIP_SATS');
  const explorerUrl = urlEnv(env, 'EXPLORER_URL') ?? 'https://mempool.space/signet';
  return {
    port: intEnv(env, 'PORT', 3070),
    host: env.HOST?.trim() || '0.0.0.0',
    wallet,
    ...(bitcoind ? { bitcoind } : {}),
    fakeBalanceSats: intEnv(env, 'FAKE_WALLET_BALANCE_SATS', 100_000_000, 0),
    app: {
      dripSats,
      dailyBudgetSats,
      addressDripsPerDay: intEnv(env, 'ADDRESS_DRIPS_PER_DAY', DEFAULTS.addressDripsPerDay, 1, 1000),
      ipDripsPerDay: intEnv(env, 'IP_DRIPS_PER_DAY', DEFAULTS.ipDripsPerDay, 1, 10_000),
      powDifficulty: intEnv(env, 'POW_DIFFICULTY', DEFAULTS.powDifficulty, 1, 32),
      challengeTtlMs: intEnv(env, 'CHALLENGE_TTL_SECONDS', DEFAULTS.challengeTtlMs / 1000, 10, 3600) * 1000,
      requestsPerMinute: intEnv(env, 'RATE_LIMIT_IP_PER_MIN', DEFAULTS.requestsPerMinute),
      challengesPerMinute: intEnv(env, 'CHALLENGES_PER_MIN', DEFAULTS.challengesPerMinute),
      corsOrigins: listEnv(env, 'CORS_ORIGINS'),
      trustedProxies: listEnv(env, 'TRUSTED_PROXIES'),
      publicUrl: urlEnv(env, 'PUBLIC_URL'),
      explorerUrl,
    },
  };
}
