/**
 * `RemoteSignerClient`: what a product service uses instead of holding a key. fetch is injected (tests,
 * custom agents for mTLS), every call has a timeout, and retries happen ONLY for network-level failures
 * (connection refused/reset, DNS, timeout). Any HTTP response — including 403 policy denials and 5xx —
 * is final: a denial is a decision, and a 5xx may have already produced an audit record.
 */
import type { SignSchnorrDigestRequest, SignSchnorrDigestResult, SignTaprootKeyPathRequest, SignTaprootKeyPathResult } from './signer.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RemoteSignerClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  /** Per attempt. Default 10 s. */
  timeoutMs?: number;
  /** Additional attempts after the first, on network errors only. Default 2. */
  retries?: number;
  /** Base delay between attempts (doubles each time). Default 200 ms. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class RemoteSignerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | undefined,
    message: string,
    readonly requestId: string | null = null,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'RemoteSignerError';
  }
  /** True for the outcomes a caller must not retry blindly: the signer decided. */
  get isDenial(): boolean {
    return this.status === 403;
  }
}

export interface PublicKeyResult {
  keyId: string;
  xOnlyPublicKey: string;
  tweakedPublicKey: string;
}

export interface HealthResult {
  status: string;
  service: string;
  version: string;
  network: string;
  keys: number;
}

export class RemoteSignerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: RemoteSignerClientOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    const f = o.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('RemoteSignerClient: no fetch available; pass options.fetch');
    this.fetchImpl = f;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.retries = o.retries ?? 2;
    this.retryDelayMs = o.retryDelayMs ?? 200;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  signTaprootKeyPath(req: SignTaprootKeyPathRequest): Promise<SignTaprootKeyPathResult> {
    return this.call<SignTaprootKeyPathResult>('POST', '/v1/sign/taproot-keypath', req);
  }

  signSchnorrDigest(req: SignSchnorrDigestRequest): Promise<SignSchnorrDigestResult> {
    return this.call<SignSchnorrDigestResult>('POST', '/v1/sign/digest', req);
  }

  publicKey(keyId: string): Promise<PublicKeyResult> {
    return this.call<PublicKeyResult>('GET', `/v1/keys/${encodeURIComponent(keyId)}/pubkey`);
  }

  health(): Promise<HealthResult> {
    return this.call<HealthResult>('GET', '/v1/health');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`signer request timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.o.apiKey}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: ac.signal,
        });
      } catch (e) {
        lastNetworkError = e;
        continue; // network-level failure: no response, so no decision was made that we could contradict
      } finally {
        clearTimeout(timer);
      }
      return this.decode<T>(res);
    }
    throw new RemoteSignerError('network_error', undefined, `signer unreachable after ${this.retries + 1} attempt(s): ${String((lastNetworkError as Error)?.message ?? lastNetworkError)}`, null, {
      cause: lastNetworkError,
    });
  }

  private async decode<T>(res: Response): Promise<T> {
    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    if (res.ok) {
      if (json === undefined) throw new RemoteSignerError('bad_response', res.status, 'signer returned a non-JSON success body', requestId);
      return json as T;
    }
    const err = (json as { error?: { code?: string; message?: string; requestId?: string | null } } | undefined)?.error;
    throw new RemoteSignerError(err?.code ?? `http_${res.status}`, res.status, err?.message ?? `signer responded ${res.status}`, err?.requestId ?? requestId);
  }
}
