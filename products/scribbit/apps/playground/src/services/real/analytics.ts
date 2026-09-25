/** Optional anonymous quiz analytics: one POST of { event, version, passed, score, total }. Off unless a URL is set. */
import type { Analytics, QuizEvent } from '../types';
import type { FetchLike } from './faucet';

export function createAnalytics(url: string, fetchImpl?: FetchLike): Analytics {
  const f: FetchLike = fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  return {
    enabled: url !== '',
    async send(e: QuizEvent) {
      if (!url) return;
      // Exactly these five fields; no cookies, no referrer, and failures are ignored (it is not worth a retry).
      const body: QuizEvent = { event: e.event, version: e.version, passed: e.passed, score: e.score, total: e.total };
      try {
        await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true });
      } catch {
        /* ignored */
      }
    },
  };
}
