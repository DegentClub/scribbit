/** Runtime configuration from Vite env vars, with safe defaults. See README "Configuration". Signet only. */
import { DEFAULT_MAX_FILE_BYTES, GOAL_SECONDS } from '@bsh/scribbit-playground-kit';

export interface PlaygroundConfig {
  demo: boolean;
  /** `@bsh/scribbit-signet-faucet` base, no trailing slash. Empty: no faucet configured (live mode explains where else to get coins). */
  faucetUrl: string;
  /** Esplora-compatible SIGNET REST base (UTXOs, fee estimates, broadcast). */
  esploraUrl: string;
  /** Signet block explorer: `${explorerUrl}/tx/<txid>`, `/address/<addr>`. */
  explorerUrl: string;
  /** Signet ord server: `${ordUrl}/inscription/<id>`. */
  ordUrl: string;
  /** Transaction X-Ray: `${xrayUrl}/<txid>`. */
  xrayUrl: string;
  /** Optional endpoint for the anonymous quiz result; empty = off (the default). */
  analyticsUrl: string;
  maxFileBytes: number;
  /** Fixed fee rate (sat/vB); null = ask the Esplora `/fee-estimates` (floored at `minFeeRate`). */
  feeRate: number | null;
  minFeeRate: number;
  goalSeconds: number;
  /** Absolute canonical URL of the page (sitemap, OpenGraph); informational. */
  siteUrl: string;
  /** Path the app is served under, always ending in `/`. */
  base: string;
  /** `?format=json`: render the page's data as JSON instead of the flow. */
  format: 'html' | 'json';
}

export interface EnvLike {
  VITE_DEMO_DEFAULT?: string;
  VITE_FAUCET_URL?: string;
  VITE_ESPLORA_URL?: string;
  VITE_EXPLORER_URL?: string;
  VITE_ORD_URL?: string;
  VITE_XRAY_URL?: string;
  VITE_ANALYTICS_URL?: string;
  VITE_MAX_FILE_BYTES?: string;
  VITE_FEE_RATE?: string;
  VITE_MIN_FEE_RATE?: string;
  VITE_SITE_URL?: string;
  BASE_URL?: string;
  [key: string]: string | undefined;
}

export const DEFAULTS = Object.freeze({
  esploraUrl: 'https://mempool.space/signet/api',
  explorerUrl: 'https://mempool.space/signet',
  ordUrl: 'https://signet.ordinals.com',
  xrayUrl: 'https://block.space/xray',
  siteUrl: 'https://degentclub.github.io/scribbit/playground/',
});

const TRUE = new Set(['1', 'true']);
const FALSE = new Set(['0', 'false']);
const trim = (u: string) => u.trim().replace(/\/+$/, '');

export function demoFlag(param: string | null, envDefault: string | undefined): boolean {
  if (param !== null && TRUE.has(param)) return true;
  if (param !== null && FALSE.has(param)) return false;
  return TRUE.has((envDefault ?? '').trim().toLowerCase());
}

/** Only http(s) URLs are accepted from env; anything else falls back to the default (never `javascript:`). */
function url(raw: string | undefined, fallback: string): string {
  const v = raw?.trim();
  if (!v) return fallback;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? trim(v) : fallback;
  } catch {
    return fallback;
  }
}

const positive = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

/** `'/x'` → `/x/`; a relative build (`./`, Vite's default here) stays relative so links work under any prefix. */
export function normalizeBase(base: string | undefined): string {
  const b = (base ?? '/').trim();
  if (b === '' || b === './' || b === '.') return './';
  if (!b.startsWith('/')) return '/';
  return b.endsWith('/') ? b : `${b}/`;
}

export function readConfig(env: EnvLike, search: string): PlaygroundConfig {
  const params = new URLSearchParams(search);
  return {
    demo: demoFlag(params.get('demo'), env.VITE_DEMO_DEFAULT),
    faucetUrl: url(env.VITE_FAUCET_URL, ''),
    esploraUrl: url(env.VITE_ESPLORA_URL, DEFAULTS.esploraUrl),
    explorerUrl: url(env.VITE_EXPLORER_URL, DEFAULTS.explorerUrl),
    ordUrl: url(env.VITE_ORD_URL, DEFAULTS.ordUrl),
    xrayUrl: url(env.VITE_XRAY_URL, DEFAULTS.xrayUrl),
    analyticsUrl: url(env.VITE_ANALYTICS_URL, ''),
    maxFileBytes: Math.floor(positive(env.VITE_MAX_FILE_BYTES) ?? DEFAULT_MAX_FILE_BYTES),
    feeRate: positive(env.VITE_FEE_RATE),
    minFeeRate: positive(env.VITE_MIN_FEE_RATE) ?? 1,
    goalSeconds: GOAL_SECONDS,
    siteUrl: url(env.VITE_SITE_URL, DEFAULTS.siteUrl),
    base: normalizeBase(env.BASE_URL),
    format: params.get('format') === 'json' ? 'json' : 'html',
  };
}

export const txUrl = (c: PlaygroundConfig, txid: string) => `${c.explorerUrl}/tx/${txid}`;
export const addressUrl = (c: PlaygroundConfig, address: string) => `${c.explorerUrl}/address/${address}`;
export const inscriptionUrl = (c: PlaygroundConfig, id: string) => `${c.ordUrl}/inscription/${id}`;
export const xrayUrl = (c: PlaygroundConfig, txid: string) => `${c.xrayUrl}/${txid}`;
