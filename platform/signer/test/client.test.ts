import { describe, expect, it } from 'vitest';
import { RemoteSignerClient, RemoteSignerError, type FetchLike } from '../src/index.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(script: Array<(() => Response) | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error('fake fetch: script exhausted');
    if (next instanceof Error) throw next;
    return next();
  };
  return { fetch, calls };
}

const client = (fetch: FetchLike, over: Partial<ConstructorParameters<typeof RemoteSignerClient>[0]> = {}) =>
  new RemoteSignerClient({ baseUrl: 'http://signer.internal:3060/', apiKey: 'bsh_live_abc', fetch, retries: 2, retryDelayMs: 1, sleep: async () => undefined, ...over });

describe('RemoteSignerClient', () => {
  it('sends bearer auth + JSON and returns the parsed result', async () => {
    const { fetch, calls } = fakeFetch([() => json(200, { keyId: 'a', signature: 'ff' })]);
    const res = await client(fetch).signSchnorrDigest({ keyId: 'a', digest32: '00'.repeat(32), purpose: 'blockspace.certify' });
    expect(res).toMatchObject({ keyId: 'a', signature: 'ff' });
    expect(calls[0]!.url).toBe('http://signer.internal:3060/v1/sign/digest');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer bsh_live_abc');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ keyId: 'a', digest32: '00'.repeat(32), purpose: 'blockspace.certify' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries on network errors (up to `retries`) and then surfaces network_error', async () => {
    const { fetch, calls } = fakeFetch([new Error('ECONNREFUSED'), new Error('ECONNRESET'), () => json(200, { keyId: 'a', xOnlyPublicKey: 'aa', tweakedPublicKey: 'bb' })]);
    await expect(client(fetch).publicKey('a')).resolves.toMatchObject({ keyId: 'a' });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('http://signer.internal:3060/v1/keys/a/pubkey');

    const dead = fakeFetch([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('never')]);
    const e = await client(dead.fetch).health().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RemoteSignerError);
    expect(e).toMatchObject({ code: 'network_error', status: undefined, message: expect.stringContaining('3 attempt(s)') });
    expect(dead.calls).toHaveLength(3);
  });

  it('never retries an HTTP response: policy denials, 5xx and 429 are final', async () => {
    for (const [status, code] of [
      [403, 'policy_denied'],
      [500, 'internal_error'],
      [503, 'unavailable'],
      [429, 'rate_limited'],
    ] as const) {
      const { fetch, calls } = fakeFetch([() => json(status, { error: { code, message: 'no', requestId: 'r-1' } }, { 'x-request-id': 'r-1' })]);
      const e = await client(fetch).signTaprootKeyPath({ psbtBase64: 'x', inputIndex: 0, keyId: 'a' }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RemoteSignerError);
      expect(e).toMatchObject({ code, status, message: 'no', requestId: 'r-1', isDenial: status === 403 });
      expect(calls).toHaveLength(1);
    }
  });

  it('times out an attempt and retries it as a network error', async () => {
    let n = 0;
    const fetch: FetchLike = (_url, init) =>
      new Promise((resolve, reject) => {
        n++;
        if (n === 2) return resolve(json(200, { status: 'ok', service: 'signer', version: '0', network: 'signet', keys: 1 }));
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const res = await client(fetch, { timeoutMs: 5 }).health();
    expect(res.status).toBe('ok');
    expect(n).toBe(2);
  });

  it('non-JSON error bodies still become a RemoteSignerError with the status', async () => {
    const { fetch } = fakeFetch([() => new Response('gateway says no', { status: 502 })]);
    await expect(client(fetch).health()).rejects.toMatchObject({ code: 'http_502', status: 502 });
    const { fetch: f2 } = fakeFetch([() => new Response('', { status: 200 })]);
    await expect(client(f2).health()).rejects.toMatchObject({ code: 'bad_response' });
  });
});
