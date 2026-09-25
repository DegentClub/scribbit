/**
 * A live-facts port backed by a mempool.space-compatible REST base (fee estimate + chain tip). Off unless
 * `LIVE_FACTS` is on and `LIVE_FACTS_URL` is set. Every fact is labelled with the source host and the time it
 * was observed; failures degrade to an empty list so the tutor keeps working.
 */
import type { LiveFact, LiveFactsPort } from '@bsh/blockspace-tutor-kb';

export interface HttpLiveFactsOptions {
  /** mempool.space-compatible base URL, e.g. https://mempool.space (no trailing slash). Public hosts only. */
  baseUrl: string;
  /** Label for the source shown to users (default: the base URL host). */
  sourceLabel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class HttpLiveFacts implements LiveFactsPort {
  private readonly base: string;
  private readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: HttpLiveFactsOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.label = opts.sourceLabel ?? hostOf(this.base);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.now = opts.now ?? (() => new Date());
  }

  async facts(_network: string): Promise<LiveFact[]> {
    const observedAt = this.now().toISOString();
    const out: LiveFact[] = [];
    const fee = await this.getJson<{ halfHourFee?: number; hourFee?: number }>('/api/v1/fees/recommended');
    if (fee && typeof fee.halfHourFee === 'number') out.push({ label: 'Recommended fee rate', value: `${fee.halfHourFee} sat/vB`, observedAt, source: this.label });
    const tip = await this.getText('/api/blocks/tip/height');
    if (tip && /^\d+$/.test(tip.trim())) out.push({ label: 'Chain tip height', value: tip.trim(), observedAt, source: this.label });
    return out;
  }

  private async getJson<T>(path: string): Promise<T | undefined> {
    const t = await this.getText(path);
    if (t === undefined) return undefined;
    try {
      return JSON.parse(t) as T;
    } catch {
      return undefined;
    }
  }

  private async getText(path: string): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, { signal: controller.signal });
      if (!res.ok) return undefined;
      return await res.text();
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'live source';
  }
}
