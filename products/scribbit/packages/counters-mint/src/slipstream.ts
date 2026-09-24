/**
 * MARA Slipstream — the route for reveals the public relay network refuses.
 *
 * An oversized taproot reveal is a perfectly VALID transaction that merely
 * exceeds the 400,000 WU standard-relay cap, so no ordinary node will carry it
 * and no fee rate changes that: the limit is policy on witness weight, not
 * price. Slipstream takes such transactions directly into MARA's own mempool.
 *
 * Four facts shape everything here, each learned the hard way in counters.fun:
 *
 *   - **No API key is required.** A key, where one exists, buys only a fee
 *     discount — it is never required to mint.
 *   - **Two rates, and they are not interchangeable.** `submit_fee_rate` is the
 *     floor a submission must meet to be ACCEPTED; `effective_rate` is what MARA
 *     is mining at now. Gate on the floor; treat the mineable rate as advice.
 *   - **No package submission.** A reveal is priced from the chain and from
 *     MARA's own submissions — NEVER from the public mempool — so the commit
 *     must be MINED before the reveal can go up.
 *   - **A submission is invisible until it is mined.** Only the chain confirms
 *     it worked.
 *
 * Nothing here talks to slipstream.mara.com directly — it sends no CORS
 * headers and a key must never reach a page. The client below speaks to the
 * product's own proxy route (counters.fun: `/api/slipstream`, `/api/reveal`).
 *
 * Ported from counters.fun `packages/counters/src/slipstream.ts` and
 * `apps/web/src/lib/slipstream.ts`.
 */

import { STANDARD_WITNESS_LIMIT_WU } from './estimate.js';

/** Slipstream's published policy cap — ~99.8% of a block. Past this, refused. */
export const MAX_WEIGHT = 3_991_000;

/** At or below this the public network relays free; Slipstream is for beyond. */
export const STANDARD_MAX_WEIGHT = STANDARD_WITNESS_LIMIT_WU;

/** Cloudflare gives up at roughly 100 seconds. A 524 later than this means the origin was still working on a body it had. */
export const FULL_UPLOAD_SECONDS = 90;

export interface SlipstreamRates {
  /** The minimum sat/vB a submission must pay to be accepted. A hard gate. */
  submitFloor: number;
  /** The rate actually being mined now. Paying between the two is legitimate. */
  mineable: number;
  marketRate: number | null;
  multiplier: number | null;
}

/** What a submission response actually means. */
export type Verdict = 'accepted' | 'rejected' | 'probably-accepted' | 'ambiguous';

/**
 * Classify a submission response. The hard case is 524: after a full upload it
 * is what every accepted large submission looks like; a FAST 524 means the body
 * never arrived. "not found" says nothing either way, so it stays ambiguous.
 */
export function classify(status: number | null, body: string, seconds: number): Verdict {
  const low = (body || '').toLowerCase();
  if (status === 200 || status === 201) return 'accepted';
  if (status === 400 && (low.includes('already') || low.includes('known'))) return 'accepted';
  if (status === 400 && !low.includes('not found')) return 'rejected';
  if (status === 524 && seconds > FULL_UPLOAD_SECONDS) return 'probably-accepted';
  return 'ambiguous';
}

/** Read the two rates out of `/api/rates`, tolerating older deployments. */
export function parseRates(body: unknown): SlipstreamRates {
  const r = (body ?? {}) as Record<string, unknown>;
  const mineable = Number(r.effective_rate);
  if (!Number.isFinite(mineable)) throw new Error('Slipstream returned no effective_rate');
  const floor = r.submit_fee_rate == null ? mineable : Number(r.submit_fee_rate);
  return {
    submitFloor: floor,
    mineable,
    marketRate: r.market_rate == null ? null : Number(r.market_rate),
    multiplier: r.multiplier == null ? null : Number(r.multiplier),
  };
}

export type RevealRoute = 'public' | 'slipstream';
export type RouteFit = RevealRoute | 'too-large';

/** Which routes a reveal of this WEIGHT can take (`too-large`: nothing can carry it). */
export function routeFitForWeight(weight: number): RouteFit {
  if (weight > MAX_WEIGHT) return 'too-large';
  if (weight > STANDARD_MAX_WEIGHT) return 'slipstream';
  return 'public';
}

/**
 * Where a reveal of this VSIZE goes: the public network at or below 100,000 vB
 * (400,000 WU), Slipstream beyond. Throws `OversizedRevealError` past MARA's
 * own cap, because no route exists and the mint must be refused before any
 * money moves.
 */
export function routeFor(revealVsize: number): RevealRoute {
  const fit = routeFitForWeight(revealVsize * 4);
  if (fit === 'too-large') throw new OversizedRevealError(revealVsize * 4);
  return fit;
}

/** Whether a fee rate clears Slipstream's acceptance floor. */
export function meetsFloor(rate: number, rates: Pick<SlipstreamRates, 'submitFloor'>): boolean {
  return rate >= rates.submitFloor;
}

/** A reveal past MARA's own policy cap. Nothing can carry it; the only remedy is a smaller file. */
export class OversizedRevealError extends Error {
  constructor(readonly weight: number) {
    super(`This reveal is ${weight.toLocaleString('en-US')} weight units, past the ${MAX_WEIGHT.toLocaleString('en-US')} limit Slipstream itself enforces. No route can carry it. Use a smaller file.`);
    this.name = 'OversizedRevealError';
  }
}

/** A reveal over the standard relay cap sent down the public route. It needs a direct-to-miner route, not a higher fee. */
export class NonStandardRevealError extends Error {
  constructor(readonly weight: number) {
    super(`This reveal is ${weight.toLocaleString('en-US')} weight units, past the ${STANDARD_MAX_WEIGHT.toLocaleString('en-US')} standard relay cap. It needs a direct-to-miner route, not a higher fee.`);
    this.name = 'NonStandardRevealError';
  }
}

/** The chosen fee rate is below Slipstream's ACCEPTANCE floor. Thrown before composing: the commit cannot be resized once on chain. */
export class BelowSlipstreamFloorError extends Error {
  constructor(readonly rate: number, readonly submitFloor: number, readonly mineable: number) {
    super(`Slipstream will not accept a submission under ${submitFloor} sat/vB, and this mint is paying ${rate}. It is currently mining at ${mineable} sat/vB — anything between the two is accepted and then waits for the market.`);
    this.name = 'BelowSlipstreamFloorError';
  }
}

/* -------------------------------------------------------------------- */
/* Client, through the product's own proxy route                        */
/* -------------------------------------------------------------------- */

export interface RatesResult extends SlipstreamRates {
  /** Whether the server holds a discount code. Never the code itself. */
  haveKey: boolean;
}

export interface SubmitResult {
  verdict: Verdict;
  status: number | null;
  seconds: number;
  message: string;
}

export type JobPhase = 'awaiting-commit' | 'probing' | 'watching' | 'confirmed' | 'rejected' | 'dead';

export interface RevealJob {
  commitTxid: string;
  source: string;
  phase: JobPhase;
  submitted: boolean;
  attempts: number;
  error: string | null;
  log: string[];
}

export interface SlipstreamClient {
  /** The two live rates. Read BEFORE composing: the commit is sized for the reveal's fee and cannot be resized later. */
  rates(): Promise<RatesResult>;
  /** Whether MARA's origin is answering right now. */
  probe(): Promise<{ alive: boolean; status: number | null; seconds: number }>;
  /** Submit a signed transaction. Read `verdict`, not the HTTP status. */
  submit(hex: string): Promise<SubmitResult>;
  /** MARA's own view of a submission — for display only, never for decisions. */
  status(txid: string): Promise<Record<string, unknown>>;
  /** Hand a signed reveal to the server, which waits for the commit to be MINED and finishes without the page. */
  handOffReveal(input: { commitTxid: string; revealHex: string; source: string; asset?: string }): Promise<RevealJob>;
  /** How a handed-off reveal is getting on. */
  revealJob(commitTxid: string): Promise<RevealJob>;
}

export interface SlipstreamClientOptions {
  /** The proxy route for rates/probe/submit/status, e.g. `/api/slipstream`. */
  baseUrl: string;
  /** The reveal hand-off route, e.g. `/api/reveal`. Defaults to `${baseUrl}/reveal`. */
  revealUrl?: string;
  fetch?: typeof fetch;
}

export function createSlipstreamClient(opts: SlipstreamClientOptions): SlipstreamClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const revealUrl = opts.revealUrl ?? `${base}/reveal`;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(url, { cache: 'no-store', ...init });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new Error(body?.error || `Slipstream request failed (${res.status})`);
    return body as T;
  }

  return {
    rates: () => json<RatesResult>(`${base}?action=rates`),
    probe: () => json(`${base}?action=probe`),
    submit: (hex) => json<SubmitResult>(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hex }) }),
    status: (txid) => json(`${base}?action=status&txid=${encodeURIComponent(txid)}`),
    handOffReveal: (input) => json<RevealJob>(revealUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    revealJob: (commitTxid) => json<RevealJob>(`${revealUrl}?commit=${encodeURIComponent(commitTxid)}`),
  };
}
