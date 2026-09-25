// Configuration: API keys (hashes only), approvers (public keys), and the environment
// (env.schema.json). The separation of duties is enforced here, at load time - a key that
// could both propose and settle, or delegate and propose/settle, never reaches the store
// (FlashyOS: `setAgentScopes` refuses the combination, SCOPE_CONFLICT).
import { readFileSync } from 'node:fs';
import type { ApiKeyEnv, ApiKeyRecord } from '@bsh/edge';
import { parseApprovers, type Approver } from './approval.ts';
import { NAME_RE, ORG_RE, SCOPE_DELEGATE, SCOPE_PROPOSE, SCOPE_SETTLE, WALLET_SCOPES } from './decide.ts';
import { PLANE_CHAINS } from './service.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Why a scope set may never be held by one key, or undefined. */
export function scopeConflict(scopes: readonly string[]): string | undefined {
  if (scopes.includes(SCOPE_PROPOSE) && scopes.includes(SCOPE_SETTLE)) return `SCOPE_CONFLICT: ${SCOPE_PROPOSE} and ${SCOPE_SETTLE} are never held by one key (the proposer never reports its own settlement)`;
  if (scopes.includes(SCOPE_DELEGATE) && (scopes.includes(SCOPE_PROPOSE) || scopes.includes(SCOPE_SETTLE)))
    return `SCOPE_CONFLICT: ${SCOPE_DELEGATE} is for people and is never held with ${SCOPE_PROPOSE} or ${SCOPE_SETTLE}`;
  return undefined;
}

/** `<org>/<name>`: the edge principal's ownerId for a plane key. */
export const ownerIdOf = (org: string, name: string): string => `${org}/${name}`;

export function principalOf(ownerId: string | undefined): { org: string; name: string } | undefined {
  if (!ownerId) return undefined;
  const i = ownerId.indexOf('/');
  if (i < 1) return undefined;
  const org = ownerId.slice(0, i);
  const name = ownerId.slice(i + 1);
  return ORG_RE.test(org) && NAME_RE.test(name) ? { org, name } : undefined;
}

/** One configured key: `{ id, hash, env, scopes, org, name, revokedAt?, expiresAt?, quota? }`. Throws ConfigError naming it. */
export function parsePlaneKey(raw: unknown, i: number): ApiKeyRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`key #${i}: expected an object`);
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(r.id) ? r.id : undefined;
  if (!id) throw new ConfigError(`key #${i}: "id" must be a short identifier`);
  if (typeof r.key === 'string') throw new ConfigError(`key ${id}: a plaintext "key" is never configured; store its SHA-256 "hash"`);
  if (typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash)) throw new ConfigError(`key ${id}: "hash" must be the lower-case hex SHA-256 of the key`);
  if (r.env !== 'live' && r.env !== 'test') throw new ConfigError(`key ${id}: "env" must be live or test`);
  if (typeof r.org !== 'string' || !ORG_RE.test(r.org)) throw new ConfigError(`key ${id}: "org" must be an organisation slug`);
  if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) throw new ConfigError(`key ${id}: "name" must be an agent or person name ([a-z0-9._-])`);
  if (!Array.isArray(r.scopes) || r.scopes.length === 0 || !r.scopes.every((s) => typeof s === 'string')) throw new ConfigError(`key ${id}: "scopes" must be a non-empty string array`);
  const scopes = r.scopes as string[];
  const unknown = scopes.filter((s) => !(WALLET_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new ConfigError(`key ${id}: unknown scope(s) ${unknown.join(', ')} (one of ${WALLET_SCOPES.join(', ')})`);
  const conflict = scopeConflict(scopes);
  if (conflict) throw new ConfigError(`key ${id}: ${conflict}`);
  const rec: ApiKeyRecord = { id, hash: r.hash, env: r.env, scopes, ownerId: ownerIdOf(r.org, r.name), name: r.name };
  for (const k of ['revokedAt', 'expiresAt'] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) throw new ConfigError(`key ${id}: "${k}" must be epoch milliseconds`);
    rec[k] = r[k] as number;
  }
  if (r.quota !== undefined) {
    const q = r.quota as Record<string, unknown>;
    if (!q || typeof q !== 'object' || typeof q.limit !== 'number' || typeof q.windowMs !== 'number' || q.limit < 1 || q.windowMs < 1000) throw new ConfigError(`key ${id}: "quota" must be { limit >= 1, windowMs >= 1000 }`);
    rec.quota = { limit: q.limit, windowMs: q.windowMs };
  }
  return rec;
}

export function parsePlaneKeys(json: string, source = 'PLANE_API_KEYS_JSON'): ApiKeyRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ConfigError(`${source}: invalid JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw new ConfigError(`${source}: expected a JSON array of key records`);
  const keys = parsed.map(parsePlaneKey);
  const ids = new Set<string>();
  for (const k of keys) {
    if (ids.has(k.id)) throw new ConfigError(`${source}: duplicate key id "${k.id}"`);
    ids.add(k.id);
  }
  return keys;
}

export interface PlaneConfig {
  port: number;
  host: string;
  dbPath: string | undefined;
  name: string;
  publicUrl: string | null;
  signingKey: string;
  retiredPublicKeys: string[];
  keys: ApiKeyRecord[];
  keyEnv: ApiKeyEnv;
  approvers: Approver[];
  chains: string[];
  denylist: string[];
  firstTimeEscalateAbove: bigint | null;
  authorizationTtlMs: number;
  decisionTtlMs: number;
  rateLimitPerMinute: number;
  trustedProxies: string[];
  ledger: { url: string; apiKey: string } | undefined;
}

type Env = Record<string, string | undefined>;

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const int = (env: Env, name: string, fallback: number, min = 1): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return Number(raw);
};

/** Concatenated PEMs → one PEM each. */
export const splitPems = (text: string): string[] => text.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g) ?? [];

export function loadConfig(env: Env = process.env, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): PlaneConfig {
  const signingKey = env.PLANE_AUTHZ_PRIVATE_KEY?.trim() || (env.PLANE_AUTHZ_PRIVATE_KEY_FILE ? readFile(env.PLANE_AUTHZ_PRIVATE_KEY_FILE) : '');
  if (!signingKey) throw new ConfigError('PLANE_AUTHZ_PRIVATE_KEY (or PLANE_AUTHZ_PRIVATE_KEY_FILE) is required: the Ed25519 PKCS#8 PEM that signs authorizations (secret path services/plane/authz-private-key)');
  const keyEnvRaw = env.PLANE_KEY_ENV ?? 'live';
  if (keyEnvRaw !== 'live' && keyEnvRaw !== 'test') throw new ConfigError('PLANE_KEY_ENV must be live or test');
  const keys = env.PLANE_API_KEYS_JSON ? parsePlaneKeys(env.PLANE_API_KEYS_JSON) : env.PLANE_API_KEYS_FILE ? parsePlaneKeys(readFile(env.PLANE_API_KEYS_FILE), 'PLANE_API_KEYS_FILE') : [];
  if (keys.length === 0) throw new ConfigError('no API keys configured (PLANE_API_KEYS_JSON or PLANE_API_KEYS_FILE)');
  const wrong = keys.filter((k) => k.env !== keyEnvRaw);
  if (wrong.length) throw new ConfigError(`keys ${wrong.map((k) => k.id).join(', ')} are not ${keyEnvRaw} keys (PLANE_KEY_ENV)`);
  let approvers: Approver[] = [];
  if (env.PLANE_APPROVERS_JSON) {
    try {
      approvers = parseApprovers(JSON.parse(env.PLANE_APPROVERS_JSON));
    } catch (e) {
      throw new ConfigError(`PLANE_APPROVERS_JSON: ${(e as Error).message}`);
    }
  }
  const chains = list(env.PLANE_CHAINS).length ? list(env.PLANE_CHAINS) : [...PLANE_CHAINS];
  for (const c of chains) if (!(PLANE_CHAINS as readonly string[]).includes(c)) throw new ConfigError(`PLANE_CHAINS: ${c} is not one of ${PLANE_CHAINS.join(', ')}`);
  const ftRaw = env.PLANE_FIRST_TIME_ESCALATE_ABOVE?.trim();
  let firstTimeEscalateAbove: bigint | null = 100_000n;
  if (ftRaw === 'off') firstTimeEscalateAbove = null;
  else if (ftRaw) {
    if (!/^(0|[1-9][0-9]*)$/.test(ftRaw)) throw new ConfigError('PLANE_FIRST_TIME_ESCALATE_ABOVE is sats or "off"');
    firstTimeEscalateAbove = BigInt(ftRaw);
  }
  const ledgerUrl = env.PLANE_LEDGER_URL?.trim();
  const ledgerKey = env.PLANE_LEDGER_API_KEY?.trim();
  if (ledgerUrl && !ledgerKey) throw new ConfigError('PLANE_LEDGER_API_KEY is required with PLANE_LEDGER_URL (secret path services/plane/ledger-api-key)');
  if (!ledgerUrl && ledgerKey) throw new ConfigError('PLANE_LEDGER_API_KEY is set but PLANE_LEDGER_URL is not');
  return {
    port: int(env, 'PORT', 3070),
    host: env.HOST?.trim() || '127.0.0.1',
    dbPath: env.PLANE_DB_PATH?.trim() || undefined,
    name: env.PLANE_NAME?.trim() || 'blockspace-plane',
    publicUrl: env.PLANE_PUBLIC_URL?.trim() || null,
    signingKey,
    retiredPublicKeys: splitPems(env.PLANE_AUTHZ_RETIRED_PUBLIC_KEYS ?? ''),
    keys,
    keyEnv: keyEnvRaw,
    approvers,
    chains,
    denylist: list(env.PLANE_DENYLIST),
    firstTimeEscalateAbove,
    authorizationTtlMs: Math.min(int(env, 'PLANE_AUTHORIZATION_TTL_SECONDS', 300, 10), 300) * 1000,
    decisionTtlMs: int(env, 'PLANE_DECISION_TTL_HOURS', 24) * 3600_000,
    rateLimitPerMinute: int(env, 'PLANE_RATE_LIMIT_PER_MINUTE', 600),
    trustedProxies: list(env.PLANE_TRUSTED_PROXIES),
    ledger: ledgerUrl && ledgerKey ? { url: ledgerUrl, apiKey: ledgerKey } : undefined,
  };
}
