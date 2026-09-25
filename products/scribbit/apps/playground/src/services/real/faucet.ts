/** Real FaucetApi over HTTP: contracts/openapi/scribbit-signet-faucet.yaml. */
import { FaucetError, type FaucetApi, type FaucetChallenge, type FaucetDrip } from '../types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function refusal(res: Response): Promise<FaucetError> {
  const retry = Number(res.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) return new FaucetError(body.error.code, body.error.message ?? `HTTP ${res.status}`, retryAfter);
  } catch {
    /* not JSON */
  }
  return new FaucetError(res.status === 429 ? 'rate_limited' : 'unreachable', `The faucet answered HTTP ${res.status}`, retryAfter);
}

export function createHttpFaucet(baseUrl: string, fetchImpl?: FetchLike): FaucetApi {
  const f: FetchLike = fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await f(`${base}${path}`, { cache: 'no-store', ...init });
    } catch {
      throw new FaucetError('unreachable', 'The faucet could not be reached.');
    }
  };
  return {
    configured: base !== '',
    async challenge() {
      if (!base) throw new FaucetError('faucet_disabled', 'No faucet is configured for this page.');
      const res = await call('/v1/challenge');
      if (!res.ok) throw await refusal(res);
      return (await res.json()) as FaucetChallenge;
    },
    async drip(req) {
      if (!base) throw new FaucetError('faucet_disabled', 'No faucet is configured for this page.');
      const res = await call('/v1/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      if (!res.ok) throw await refusal(res);
      return (await res.json()) as FaucetDrip;
    },
  };
}
