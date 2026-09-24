import { describe, expect, it } from 'vitest';
import { createBitcoindWallet, FaucetWalletError, RPC, satsToBtcString, type FetchLike } from '../src/index.js';

type Call = { url: string; body: { method: string; params: unknown[] }; auth: string | null };

function fakeNode(opts: { chain?: string; reply?: (c: Call) => { status?: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization ?? null };
    calls.push(call);
    if (call.body.method === 'getblockchaininfo') return Response.json({ result: { chain: opts.chain ?? 'signet', blocks: 1 }, error: null, id: 1 });
    const r = opts.reply?.(call) ?? { body: { result: 'cd'.repeat(32), error: null } };
    return Response.json(r.body, { status: r.status ?? 200 });
  };
  return { calls, fetch };
}

const base = { url: 'http://bitcoind.internal.example:38332/', wallet: 'faucet', user: 'u', password: 'p' };

describe('satsToBtcString', () => {
  it.each([
    [0, '0.00000000'],
    [1, '0.00000001'],
    [50_000, '0.00050000'],
    [100_000_000, '1.00000000'],
    [2_100_000_000_000_000, '21000000.00000000'],
  ])('%i → %s', (s, b) => expect(satsToBtcString(s)).toBe(b));
  it('refuses fractions and negatives', () => {
    expect(() => satsToBtcString(1.5)).toThrow(RangeError);
    expect(() => satsToBtcString(-1)).toThrow(RangeError);
  });
});

describe('bitcoind adapter', () => {
  it('checks the chain once, then calls sendtoaddress on the named wallet with an exact BTC string and basic auth', async () => {
    const node = fakeNode();
    const w = createBitcoindWallet({ ...base, fetch: node.fetch });
    expect(await w.send('tb1qexample', 50_000)).toEqual({ txid: 'cd'.repeat(32) });
    await w.send('tb1qexample2', 1_000);
    expect(node.calls.map((c) => c.body.method)).toEqual(['getblockchaininfo', 'sendtoaddress', 'sendtoaddress']);
    expect(node.calls[0]!.url).toBe('http://bitcoind.internal.example:38332/');
    expect(node.calls[1]!.url).toBe('http://bitcoind.internal.example:38332/wallet/faucet');
    expect(node.calls[1]!.body.params).toEqual(['tb1qexample', '0.00050000', '', '', false, true]);
    expect(node.calls[1]!.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('refuses to send when the node is not on signet (wrong_chain), for mainnet and testnet alike', async () => {
    for (const chain of ['main', 'test', 'testnet4', 'regtest']) {
      const node = fakeNode({ chain });
      const w = createBitcoindWallet({ ...base, fetch: node.fetch });
      await expect(w.send('tb1qexample', 1_000)).rejects.toMatchObject({ code: 'wrong_chain' });
      expect(node.calls.map((c) => c.body.method)).toEqual(['getblockchaininfo']);
    }
  });

  it('maps RPC errors: -6 insufficient funds, -5 rejected, others unavailable; HTTP 401 unavailable; bad txid unavailable', async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ result: null, error: { code: RPC.WALLET_INSUFFICIENT_FUNDS, message: 'Insufficient funds' } }, 500, 'insufficient_funds'],
      [{ result: null, error: { code: RPC.INVALID_ADDRESS_OR_KEY, message: 'Invalid address' } }, 500, 'rejected'],
      [{ result: null, error: { code: RPC.WALLET_NOT_FOUND, message: 'Requested wallet does not exist' } }, 500, 'unavailable'],
      [{ result: 'not-a-txid', error: null }, 200, 'unavailable'],
      ['<html>', 401, 'unavailable'],
    ];
    for (const [body, status, code] of cases) {
      const node = fakeNode({ reply: () => ({ status, body }) });
      const w = createBitcoindWallet({ ...base, fetch: node.fetch });
      await expect(w.send('tb1qexample', 1_000)).rejects.toMatchObject({ code });
    }
  });

  it('network failures and timeouts are unavailable', async () => {
    const down = createBitcoindWallet({ ...base, fetch: async () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(down.assertSignet()).rejects.toBeInstanceOf(FaucetWalletError);
    const slow = createBitcoindWallet({
      ...base,
      timeoutMs: 20,
      fetch: (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    await expect(slow.assertSignet()).rejects.toMatchObject({ code: 'unavailable', message: /timeout/ });
  });
});
