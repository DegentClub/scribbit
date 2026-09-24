/** Environment parsing (documented in env.schema.json). No secrets: every upstream here is public or read-only. */
import { isNetwork, NETWORKS, publicMempoolUrl, type Network } from '@bsh/scribbit-fee-oracle';
import { DEFAULT_LIMITS, type Limits } from './app.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  port: number;
  host: string;
  network: Network;
  esploraUrl: string;
  cpUrl: string | undefined;
  /** A scribb.it fee server (`.../v1/fees`), a mempool.space-compatible base URL, `'off'`, or undefined (= public mempool.space). */
  feeUrl: string | 'off' | undefined;
  corsOrigins: string[];
  trustedProxies: string[];
  publicUrl: string | undefined;
  rateLimit: { ipPerMinute: number; writePerMinute: number };
  limits: Limits;
}

type Env = Record<string, string | undefined>;

const intEnv = (env: Env, name: string, fallback: number, min = 1): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  const n = Number(raw);
  if (n < min) throw new ConfigError(`${name} must be >= ${min}`);
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
    throw new ConfigError(`${name} must be an absolute http(s) URL (got "${raw}")`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new ConfigError(`${name} must be http(s)`);
  return raw.replace(/\/+$/, '');
};

export function defaultEsploraUrl(network: Network): string | undefined {
  const base = publicMempoolUrl(network);
  return base ? `${base}/api` : undefined;
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const network = (env.MINT_NETWORK?.trim() || 'mainnet') as Network;
  if (!isNetwork(network)) throw new ConfigError(`MINT_NETWORK: unknown network "${network}" (${NETWORKS.join(' | ')})`);
  const esploraUrl = urlEnv(env, 'ESPLORA_URL') ?? defaultEsploraUrl(network);
  if (!esploraUrl) throw new ConfigError(`ESPLORA_URL is required for ${network} (no public default)`);
  const feeRaw = env.FEE_URL?.trim();
  const feeUrl = !feeRaw ? undefined : feeRaw.toLowerCase() === 'off' ? 'off' : urlEnv(env, 'FEE_URL');
  return {
    port: intEnv(env, 'PORT', 3060),
    host: env.HOST?.trim() || '0.0.0.0',
    network,
    esploraUrl,
    cpUrl: urlEnv(env, 'CP_API_URL'),
    feeUrl,
    corsOrigins: listEnv(env, 'CORS_ORIGINS'),
    trustedProxies: listEnv(env, 'TRUSTED_PROXIES'),
    publicUrl: urlEnv(env, 'PUBLIC_URL'),
    rateLimit: { ipPerMinute: intEnv(env, 'RATE_LIMIT_IP_PER_MIN', 300), writePerMinute: intEnv(env, 'RATE_LIMIT_WRITE_PER_MIN', 30) },
    limits: {
      maxComposeBytes: intEnv(env, 'MAX_COMPOSE_BYTES', DEFAULT_LIMITS.maxComposeBytes, 1024),
      maxBroadcastBytes: intEnv(env, 'MAX_BROADCAST_BYTES', DEFAULT_LIMITS.maxBroadcastBytes, 1024),
      maxBodyBytes: DEFAULT_LIMITS.maxBodyBytes,
      upstreamTimeoutMs: intEnv(env, 'UPSTREAM_TIMEOUT_MS', DEFAULT_LIMITS.upstreamTimeoutMs, 100),
    },
  };
}
