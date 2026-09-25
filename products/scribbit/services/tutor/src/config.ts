/**
 * Environment parsing for the Ask Blockspace server (documented in env.schema.json). Secrets never appear
 * here as values — the chat API key is read by @bsh/blockspace-tutor-kb from `CHAT_API_KEY` at port
 * construction and is never logged.
 */
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
  corsOrigins: string[];
  trustedProxies: string[];
  ratePerMinute: number;
  maxQuestionChars: number;
  /** Live facts: off, or a mempool-compatible base URL. */
  liveFacts: { enabled: boolean; url?: string; network?: string };
  /** True when a real chat provider is configured (CHAT_PROVIDER on + endpoint/key/model set). */
  chatConfigured: boolean;
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
  (env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const liveFactsOn = boolEnv(env, 'LIVE_FACTS', false);
  const liveUrl = env.LIVE_FACTS_URL?.trim();
  if (liveFactsOn && !liveUrl) throw new ConfigError('LIVE_FACTS is on but LIVE_FACTS_URL is not set');

  const provider = env.CHAT_PROVIDER?.trim().toLowerCase();
  const chatOn = !!provider && provider !== 'off' && provider !== 'false' && provider !== '0';
  const chatConfigured = chatOn && !!env.CHAT_BASE_URL?.trim() && !!env.CHAT_API_KEY?.trim() && !!env.CHAT_MODEL?.trim();
  if (chatOn && !chatConfigured) throw new ConfigError('CHAT_PROVIDER is set but CHAT_BASE_URL, CHAT_API_KEY and CHAT_MODEL are not all present');

  const cfg: ServerConfig = {
    port: intEnv(env, 'PORT', 3060),
    host: env.HOST?.trim() || '0.0.0.0',
    publicUrl: env.TUTOR_PUBLIC_URL?.trim() || undefined,
    corsOrigins: listEnv(env, 'TUTOR_CORS_ORIGINS'),
    trustedProxies: listEnv(env, 'TUTOR_TRUSTED_PROXIES'),
    ratePerMinute: intEnv(env, 'TUTOR_RATE_LIMIT_PER_MIN', 60),
    maxQuestionChars: intEnv(env, 'TUTOR_MAX_QUESTION_CHARS', 2000, 16),
    liveFacts: liveFactsOn ? { enabled: true, url: liveUrl!, ...(env.LIVE_FACTS_NETWORK?.trim() ? { network: env.LIVE_FACTS_NETWORK.trim() } : {}) } : { enabled: false },
    chatConfigured,
  };
  return cfg;
}
