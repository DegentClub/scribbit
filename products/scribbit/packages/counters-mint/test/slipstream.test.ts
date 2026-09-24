import { describe, expect, it } from 'vitest';
import { MAX_WEIGHT, OversizedRevealError, STANDARD_MAX_WEIGHT, classify, createSlipstreamClient, meetsFloor, parseRates, routeFitForWeight, routeFor } from '../src/slipstream.js';

describe('routeFor (vsize)', () => {
  it('sends standard sizes down the public network and larger ones to Slipstream', () => {
    expect(routeFor(100)).toBe('public');
    expect(routeFor(100_000)).toBe('public'); // exactly 400,000 WU
    expect(routeFor(100_001)).toBe('slipstream');
    expect(routeFor(MAX_WEIGHT / 4)).toBe('slipstream');
    expect(() => routeFor(MAX_WEIGHT / 4 + 1)).toThrow(OversizedRevealError);
  });
  it('routeFitForWeight names the three fits', () => {
    expect(routeFitForWeight(STANDARD_MAX_WEIGHT)).toBe('public');
    expect(routeFitForWeight(STANDARD_MAX_WEIGHT + 1)).toBe('slipstream');
    expect(routeFitForWeight(MAX_WEIGHT + 1)).toBe('too-large');
  });
});

describe('classify', () => {
  it('reads MARA responses the way counters.fun learned to', () => {
    expect(classify(200, '', 1)).toBe('accepted');
    expect(classify(201, '', 1)).toBe('accepted');
    expect(classify(400, 'Transaction already known', 1)).toBe('accepted');
    expect(classify(400, 'Fee rate of 0 is below the threshold', 1)).toBe('rejected');
    expect(classify(400, 'tx not found', 1)).toBe('ambiguous');
    expect(classify(524, '', 120)).toBe('probably-accepted');
    expect(classify(524, '', 5)).toBe('ambiguous');
    expect(classify(null, '', 30)).toBe('ambiguous');
  });
});

describe('rates', () => {
  it('keeps the floor and the mineable rate apart and falls back to the mineable rate', () => {
    const r = parseRates({ submit_fee_rate: 1, effective_rate: 2.5, market_rate: 2, multiplier: 1.25 });
    expect(r).toEqual({ submitFloor: 1, mineable: 2.5, marketRate: 2, multiplier: 1.25 });
    expect(meetsFloor(1, r)).toBe(true);
    expect(meetsFloor(0.99, r)).toBe(false);
    expect(parseRates({ effective_rate: 3 }).submitFloor).toBe(3);
    expect(() => parseRates({})).toThrow(/effective_rate/);
  });
});

describe('createSlipstreamClient', () => {
  it('speaks to the proxy routes with the expected shapes', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ verdict: 'accepted', status: 200, seconds: 3, message: '', submitFloor: 1, mineable: 2, haveKey: false, phase: 'awaiting-commit' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createSlipstreamClient({ baseUrl: '/api/slipstream', revealUrl: '/api/reveal', fetch: fetchFake });
    await client.rates();
    await client.submit('00');
    await client.handOffReveal({ commitTxid: 'a'.repeat(64), revealHex: '02', source: 'bc1p' });
    await client.revealJob('a'.repeat(64));
    expect(calls[0]!.url).toBe('/api/slipstream?action=rates');
    expect(calls[1]!.url).toBe('/api/slipstream');
    expect(calls[1]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ hex: '00' });
    expect(calls[2]!.url).toBe('/api/reveal');
    expect(calls[3]!.url).toBe(`/api/reveal?commit=${'a'.repeat(64)}`);
  });

  it('throws the proxy\'s error on failure', async () => {
    const fetchFake = (async () => new Response(JSON.stringify({ error: 'origin down' }), { status: 502 })) as unknown as typeof fetch;
    const client = createSlipstreamClient({ baseUrl: '/api/slipstream', fetch: fetchFake });
    await expect(client.rates()).rejects.toThrow('origin down');
  });
});
