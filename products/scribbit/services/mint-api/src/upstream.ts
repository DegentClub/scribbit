/**
 * One way to call an upstream (Esplora or Counterparty): bounded by a timeout, mapped to uniform errors. The
 * `fetch` is injectable so tests run with fake upstreams and never touch the network.
 */
import { EdgeError } from '@bsh/edge';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpstreamOptions {
  fetch: FetchLike;
  timeoutMs: number;
  /** Name used in error messages ("Esplora", "Counterparty"). */
  label: string;
}

export async function callUpstream(url: string, init: RequestInit, opts: UpstreamOptions): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    return await opts.fetch(url, { ...init, signal: ctl.signal });
  } catch (cause) {
    if (ctl.signal.aborted) throw new EdgeError(504, 'upstream_timeout', `${opts.label} did not answer within ${opts.timeoutMs} ms`);
    throw new EdgeError(502, 'upstream_error', `${opts.label} is unreachable: ${(cause as Error)?.message ?? String(cause)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Trim an upstream error body to something safe to show. */
export async function upstreamText(res: Response, max = 400): Promise<string> {
  const t = (await res.text().catch(() => '')).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const TXID_RE = /^[0-9a-f]{64}$/i;
export const ADDRESS_RE = /^[A-Za-z0-9]{20,90}$/;
export const HEX_RE = /^[0-9a-fA-F]+$/;
