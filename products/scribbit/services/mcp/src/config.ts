/**
 * Environment parsing for the HTTP server (documented in env.schema.json). Secrets never appear here: API
 * keys are configured as SHA-256 hashes (`MCP_API_KEYS_JSON` / `MCP_API_KEYS_FILE`), the key itself is shown
 * once by `pnpm --filter @bsh/scribbit-mcp mint-key` and lives only with its holder.
 */
import { readFileSync } from 'node:fs';
import type { Network } from '@bsh/inscription';
import { InMemoryApiKeyStore, type ApiKeyEnv, type ApiKeyRecord } from '@bsh/edge';
import { isNetwork, NETWORKS } from './content.js';
import { DEFAULT_MAX_BODY_BYTES } from './limits.js';
import { scopeConflict } from './scopes.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  port: number;
  host: string;
  publicUrl: string | undefined;
  networks: Network[];
  keyEnv: ApiKeyEnv;
  requireApiKey: boolean;
  keys: ApiKeyRecord[];
  /** Per network: a fee source URL, `'off'`, or undefined (= public mempool.space when it exists). */
  feeUrls: Partial<Record<Network, string | 'off'>>;
  trustedProxies: string[];
  corsOrigins: string[];
  rateLimit: { ipPerMinute: number; keyPerMinute: number };
  maxBodyBytes: number;
  /** The platform ledger (order tools). Undefined = orders disabled (`ledger_unavailable`). The key is a secret: never logged. */
  ledger: { url: string; apiKey: string } | undefined;
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

const boolEnv = (env: Env, name: string, fallback: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}")`);
};

const listEnv = (env: Env, name: string): string[] =>
  (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Validate one API key record from configuration. Only the hash is ever configured. */
export function parseKeyRecord(raw: unknown, i: number): ApiKeyRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError(`API key #${i}: expected an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(r.id)) throw new ConfigError(`API key #${i}: "id" must be a short identifier`);
  if (typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash))
    throw new ConfigError(`API key ${r.id}: "hash" must be the lower-case hex SHA-256 of the key (never the key itself)`);
  if (typeof r.key === 'string') throw new ConfigError(`API key ${r.id}: plaintext "key" is not accepted in configuration; store only the hash`);
  if (r.env !== 'live' && r.env !== 'test') throw new ConfigError(`API key ${r.id}: "env" must be live or test`);
  const scopes = Array.isArray(r.scopes) && r.scopes.every((s) => typeof s === 'string') ? (r.scopes as string[]) : undefined;
  if (!scopes) throw new ConfigError(`API key ${r.id}: "scopes" must be a string array`);
  const conflict = scopeConflict(scopes);
  if (conflict) throw new ConfigError(`API key ${r.id}: ${conflict}`);
  const rec: ApiKeyRecord = { id: r.id, hash: r.hash, env: r.env, scopes };
  if (typeof r.ownerId === 'string') rec.ownerId = r.ownerId;
  if (typeof r.name === 'string') rec.name = r.name;
  for (const k of ['revokedAt', 'expiresAt'] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) throw new ConfigError(`API key ${r.id}: "${k}" must be epoch milliseconds`);
    rec[k] = r[k];
  }
  if (r.quota !== undefined) {
    const q = r.quota as Record<string, unknown>;
    if (typeof q !== 'object' || q === null || typeof q.limit !== 'number' || typeof q.windowMs !== 'number' || q.limit < 1 || q.windowMs < 1000)
      throw new ConfigError(`API key ${r.id}: "quota" must be { limit >= 1, windowMs >= 1000 }`);
    rec.quota = { limit: q.limit, windowMs: q.windowMs };
  }
  return rec;
}

export function parseKeyRecords(json: string, source: string): ApiKeyRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ConfigError(`${source}: invalid JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw new ConfigError(`${source}: expected a JSON array of key records`);
  const records = parsed.map(parseKeyRecord);
  const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) throw new ConfigError(`${source}: duplicate key id "${r.id}"`);
    ids.add(r.id);
  }
  return records;
}

export function keyStoreFrom(records: readonly ApiKeyRecord[]): InMemoryApiKeyStore {
  const store = new InMemoryApiKeyStore();
  for (const r of records) store.add(r);
  return store;
}

export function loadServerConfig(env: Env = process.env, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): ServerConfig {
  const networks = (listEnv(env, 'MCP_NETWORKS').length ? listEnv(env, 'MCP_NETWORKS') : ['mainnet']).map((n) => {
    if (!isNetwork(n)) throw new ConfigError(`MCP_NETWORKS: unknown network "${n}" (${NETWORKS.join(' | ')})`);
    return n;
  });
  if (new Set(networks).size !== networks.length) throw new ConfigError('MCP_NETWORKS: duplicate network');

  const keyEnvRaw = env.MCP_API_KEY_ENV ?? 'live';
  if (keyEnvRaw !== 'live' && keyEnvRaw !== 'test') throw new ConfigError(`MCP_API_KEY_ENV must be live or test (got "${keyEnvRaw}")`);
  const requireApiKey = boolEnv(env, 'MCP_REQUIRE_API_KEY', true);

  let keys: ApiKeyRecord[] = [];
  if (env.MCP_API_KEYS_JSON) keys = keys.concat(parseKeyRecords(env.MCP_API_KEYS_JSON, 'MCP_API_KEYS_JSON'));
  if (env.MCP_API_KEYS_FILE) {
    let text: string;
    try {
      text = readFile(env.MCP_API_KEYS_FILE);
    } catch (e) {
      throw new ConfigError(`MCP_API_KEYS_FILE: cannot read ${env.MCP_API_KEYS_FILE} (${(e as Error).message})`);
    }
    keys = keys.concat(parseKeyRecords(text, 'MCP_API_KEYS_FILE'));
  }
  if (requireApiKey && keys.length === 0)
    throw new ConfigError('no API keys configured (MCP_API_KEYS_JSON or MCP_API_KEYS_FILE); set MCP_REQUIRE_API_KEY=false only for local development');
  const wrongEnv = keys.filter((k) => k.env !== keyEnvRaw);
  if (wrongEnv.length) throw new ConfigError(`API keys ${wrongEnv.map((k) => k.id).join(', ')} are ${wrongEnv[0]!.env} keys but MCP_API_KEY_ENV=${keyEnvRaw}`);

  const feeUrls: Partial<Record<Network, string | 'off'>> = {};
  for (const n of networks) {
    const raw = env[`MCP_FEE_URL_${n.toUpperCase()}`]?.trim();
    if (!raw) continue;
    feeUrls[n] = raw.toLowerCase() === 'off' ? 'off' : raw;
  }

  const ledgerUrl = env.MCP_LEDGER_URL?.trim();
  const ledgerKey = env.MCP_LEDGER_API_KEY?.trim();
  let ledger: ServerConfig['ledger'];
  if (ledgerUrl) {
    let u: URL;
    try {
      u = new URL(ledgerUrl);
    } catch {
      throw new ConfigError(`MCP_LEDGER_URL: not a URL ("${ledgerUrl}")`);
    }
    if (!/^https?:$/.test(u.protocol)) throw new ConfigError('MCP_LEDGER_URL must be http(s)');
    if (!ledgerKey) throw new ConfigError('MCP_LEDGER_API_KEY is required when MCP_LEDGER_URL is set (secret path services/scribbit-mcp/ledger-api-key)');
    ledger = { url: ledgerUrl, apiKey: ledgerKey };
  } else if (ledgerKey) {
    throw new ConfigError('MCP_LEDGER_API_KEY is set but MCP_LEDGER_URL is not');
  }

  return {
    port: intEnv(env, 'PORT', 3050),
    host: env.HOST?.trim() || '0.0.0.0',
    publicUrl: env.MCP_PUBLIC_URL?.trim() || undefined,
    networks,
    keyEnv: keyEnvRaw,
    requireApiKey,
    keys,
    feeUrls,
    trustedProxies: listEnv(env, 'MCP_TRUSTED_PROXIES'),
    corsOrigins: listEnv(env, 'MCP_CORS_ORIGINS'),
    rateLimit: { ipPerMinute: intEnv(env, 'MCP_RATE_LIMIT_IP_PER_MIN', 600), keyPerMinute: intEnv(env, 'MCP_RATE_LIMIT_KEY_PER_MIN', 120) },
    maxBodyBytes: intEnv(env, 'MCP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 1024),
    ledger,
  };
}
