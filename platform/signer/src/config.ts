/** Environment → typed config (env.schema.json is the documentation of record). */
import { InMemoryApiKeyStore, type ApiKeyEnv, type ApiKeyRecord } from '@bsh/edge';
import { readFileSync } from 'node:fs';
import { EnvKeyProvider, FileKeyProvider, type KeyProvider } from './key-provider.js';
import { maxFee, maxInputValue, outputAllowlist, type Policy, type TaprootKeyPathInspection } from './policy.js';
import type { BitcoinNetwork } from './taproot.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface SignerConfig {
  port: number;
  host: string;
  network: BitcoinNetwork;
  keyProvider: 'file' | 'env';
  keyFile?: string;
  keyIds: string[];
  allowedPurposes: string[];
  allowedSighashTypes: number[];
  maxInputSats?: bigint;
  maxFeeSats?: bigint;
  outputAllowlist?: string[];
  keyEnv: ApiKeyEnv;
  apiKeys: ApiKeyRecord[];
  trustedProxies: string[];
  rateLimit: { ipPerMinute: number; keyPerMinute: number };
  maxBodyBytes: number;
  auditCapacity: number;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function int(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  if (!/^[0-9]+$/.test(v)) throw new ConfigError(`${name} must be a non-negative integer`);
  return Number(v);
}

function big(env: NodeJS.ProcessEnv, name: string): bigint | undefined {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
  if (!/^[0-9]+$/.test(v)) throw new ConfigError(`${name} must be a non-negative integer (sats)`);
  return BigInt(v);
}

function parseApiKeys(env: NodeJS.ProcessEnv, keyEnv: ApiKeyEnv): ApiKeyRecord[] {
  const raw: unknown[] = [];
  for (const src of [env.SIGNER_API_KEYS_JSON, env.SIGNER_API_KEYS_FILE ? readFileSync(env.SIGNER_API_KEYS_FILE, 'utf8') : undefined]) {
    if (!src) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(src);
    } catch {
      throw new ConfigError('SIGNER_API_KEYS_JSON / SIGNER_API_KEYS_FILE must be a JSON array');
    }
    if (!Array.isArray(parsed)) throw new ConfigError('API key config must be a JSON array');
    raw.push(...parsed);
  }
  const out: ApiKeyRecord[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) throw new ConfigError('every API key record must be an object');
    const rec = r as Record<string, unknown>;
    if ('key' in rec) throw new ConfigError(`API key record "${String(rec.id)}" contains a plaintext key; configure the SHA-256 hash only`);
    if (typeof rec.id !== 'string' || typeof rec.hash !== 'string' || !/^[0-9a-f]{64}$/.test(rec.hash))
      throw new ConfigError('API key records need id and hash (lower-case SHA-256 hex)');
    if (rec.env !== keyEnv) throw new ConfigError(`API key "${rec.id}" is a ${String(rec.env)} key but SIGNER_API_KEY_ENV is ${keyEnv}`);
    if (!Array.isArray(rec.scopes) || !rec.scopes.every((s) => typeof s === 'string')) throw new ConfigError(`API key "${rec.id}" needs a scopes array`);
    out.push(rec as unknown as ApiKeyRecord);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv): SignerConfig {
  const network = (env.SIGNER_NETWORK ?? 'mainnet') as BitcoinNetwork;
  if (!['mainnet', 'testnet', 'signet', 'regtest'].includes(network)) throw new ConfigError('SIGNER_NETWORK must be mainnet, testnet, signet or regtest');
  const keyProvider = (env.SIGNER_KEY_PROVIDER ?? 'env') as 'file' | 'env';
  if (!['file', 'env'].includes(keyProvider)) throw new ConfigError('SIGNER_KEY_PROVIDER must be file or env (HSM providers are wired in code)');
  const keyIds = list(env.SIGNER_KEY_IDS);
  if (keyProvider === 'env' && keyIds.length === 0) throw new ConfigError('SIGNER_KEY_IDS is required with the env key provider');
  if (keyProvider === 'file' && !env.SIGNER_KEY_FILE) throw new ConfigError('SIGNER_KEY_FILE is required with the file key provider');
  if (keyProvider === 'file' && network === 'mainnet' && env.SIGNER_ALLOW_FILE_KEYS_ON_MAINNET !== 'true')
    throw new ConfigError('the file key provider is for development; refusing on mainnet without SIGNER_ALLOW_FILE_KEYS_ON_MAINNET=true');
  const keyEnv = (env.SIGNER_API_KEY_ENV ?? 'live') as ApiKeyEnv;
  if (!['live', 'test'].includes(keyEnv)) throw new ConfigError('SIGNER_API_KEY_ENV must be live or test');
  const sighash = list(env.SIGNER_ALLOWED_SIGHASH ?? '0x00,0x01').map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new ConfigError(`SIGNER_ALLOWED_SIGHASH: bad value "${s}"`);
    return n;
  });
  const apiKeys = parseApiKeys(env, keyEnv);
  if (apiKeys.length === 0) throw new ConfigError('no API keys configured (SIGNER_API_KEYS_JSON or SIGNER_API_KEYS_FILE)');
  const maxInputSats = big(env, 'SIGNER_MAX_INPUT_SATS');
  const maxFeeSats = big(env, 'SIGNER_MAX_FEE_SATS');
  const outputs = list(env.SIGNER_OUTPUT_ALLOWLIST);
  return {
    port: int(env, 'PORT', 3060),
    host: env.HOST ?? '127.0.0.1',
    network,
    keyProvider,
    ...(env.SIGNER_KEY_FILE ? { keyFile: env.SIGNER_KEY_FILE } : {}),
    keyIds,
    allowedPurposes: list(env.SIGNER_ALLOWED_PURPOSES),
    allowedSighashTypes: sighash,
    ...(maxInputSats !== undefined ? { maxInputSats } : {}),
    ...(maxFeeSats !== undefined ? { maxFeeSats } : {}),
    ...(outputs.length ? { outputAllowlist: outputs } : {}),
    keyEnv,
    apiKeys,
    trustedProxies: list(env.SIGNER_TRUSTED_PROXIES),
    rateLimit: { ipPerMinute: int(env, 'SIGNER_RATE_LIMIT_IP_PER_MIN', 600), keyPerMinute: int(env, 'SIGNER_RATE_LIMIT_KEY_PER_MIN', 120) },
    maxBodyBytes: int(env, 'SIGNER_MAX_BODY_BYTES', 256 * 1024),
    auditCapacity: int(env, 'SIGNER_AUDIT_CAPACITY', 10_000),
  };
}

export function keyProviderFrom(cfg: SignerConfig, env: NodeJS.ProcessEnv): KeyProvider {
  if (cfg.keyProvider === 'file') return FileKeyProvider.fromFile(cfg.keyFile!);
  const p = EnvKeyProvider.fromEnv(env, cfg.keyIds);
  for (const id of cfg.keyIds) delete env[EnvKeyProvider.envName('SIGNER_KEY_', id)]; // scrub: child processes and /proc must not see them
  return p;
}

export function taprootPoliciesFrom(cfg: SignerConfig): Policy<TaprootKeyPathInspection>[] {
  const out: Policy<TaprootKeyPathInspection>[] = [];
  if (cfg.maxInputSats !== undefined) out.push(maxInputValue(cfg.maxInputSats));
  if (cfg.maxFeeSats !== undefined) out.push(maxFee(cfg.maxFeeSats));
  if (cfg.outputAllowlist) out.push(outputAllowlist(cfg.outputAllowlist));
  return out;
}

export function apiKeyStoreFrom(records: readonly ApiKeyRecord[]): InMemoryApiKeyStore {
  const store = new InMemoryApiKeyStore();
  for (const r of records) store.add(r);
  return store;
}
