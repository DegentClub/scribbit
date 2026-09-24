import type { FetchLike } from '../types.js';

export const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') throw new Error('no global fetch: pass `fetch` explicitly');
  return (url, init) => globalThis.fetch(url, init);
}

/** GET/POST returning parsed JSON; throws with a short, log-safe message on any failure. */
export async function requestJson(fetchFn: FetchLike, url: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchFn(url, { ...init, signal, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`invalid JSON from ${redact(url)}`);
  }
}

/** Strip credentials from a URL before it reaches an error message or a health report. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** A positive, finite sat/vB value or undefined. */
export function rate(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** BTC/kvB (bitcoind units) -> sat/vB. 1 BTC = 1e8 sat, 1 kvB = 1000 vB. */
export function btcPerKvbToSatPerVb(v: unknown): number | undefined {
  const r = rate(v);
  return r === undefined ? undefined : Math.round(r * 1e5 * 1e6) / 1e6;
}

export interface RpcOptions {
  /** JSON-RPC endpoint, e.g. http://192.0.2.227:8332 (credentials may be given here or via `auth`). */
  url: string;
  auth?: { user: string; password: string };
  fetch?: FetchLike;
}

/** Minimal bitcoind JSON-RPC 1.0 client over an injectable fetch. */
export function rpcClient(opts: RpcOptions) {
  const fetchFn = opts.fetch ?? defaultFetch();
  let url = opts.url;
  let auth = opts.auth;
  try {
    const u = new URL(opts.url);
    if (!auth && (u.username || u.password)) auth = { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    u.username = '';
    u.password = '';
    url = u.toString();
  } catch {
    throw new Error(`invalid RPC url: ${redact(opts.url)}`);
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Basic ${btoa(`${auth.user}:${auth.password}`)}`;
  return async function call<T>(method: string, params: unknown[], signal: AbortSignal): Promise<T> {
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: 'scribbit-fee-oracle', method, params }),
      signal,
    });
    // bitcoind answers RPC errors with HTTP 500 and a JSON body; read it before judging the status.
    let body: { result?: T; error?: { code?: number; message?: string } | null } | undefined;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = undefined;
    }
    if (body?.error) throw new Error(`rpc ${method}: ${body.error.message ?? 'error'}`);
    if (!res.ok || !body) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    return body.result as T;
  };
}
