import { describe, expect, it } from 'vitest';
import { solvePow, verifyPow } from '@bsh/scribbit-playground-kit';
import { checkSignetAddress, FaucetWalletError } from '../src/index.js';
import { decodesOnRegtest } from '../src/address.js';
import { ADDR, challenge, DIFFICULTY, drip, makeFaucet, solvedDrip, wrongSolution } from './helpers.js';

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('network refusal (address HRP)', () => {
  it('accepts tb1 taproot and segwit v0, lower-cases upper-case bech32', () => {
    expect(checkSignetAddress(ADDR.signetTr)).toMatchObject({ ok: true, type: 'tr' });
    expect(checkSignetAddress(ADDR.signetWpkh)).toMatchObject({ ok: true, type: 'wpkh' });
    expect(checkSignetAddress(ADDR.signetWpkh.toUpperCase())).toMatchObject({ ok: true, address: ADDR.signetWpkh });
  });

  it.each([
    ['bc1p (taproot)', ADDR.mainnetTr],
    ['bc1q (segwit v0)', ADDR.mainnetWpkh],
    ['BC1Q upper-case', ADDR.mainnetWpkh.toUpperCase()],
    ['base58 1…', ADDR.mainnetLegacy],
    ['base58 3…', ADDR.mainnetP2sh],
  ])('refuses a mainnet address explicitly: %s', (_, a) => {
    expect(checkSignetAddress(a)).toMatchObject({ ok: false, code: 'mainnet_address_refused' });
  });

  it('refuses regtest as wrong_network, even though it is well-formed', () => {
    expect(decodesOnRegtest(ADDR.regtestTr)).toBe(true);
    expect(checkSignetAddress(ADDR.regtestTr)).toMatchObject({ ok: false, code: 'wrong_network' });
  });

  it.each([
    ['bad checksum', ADDR.signetTr.slice(0, -1) + (ADDR.signetTr.endsWith('q') ? 'p' : 'q')],
    ['mixed case', ADDR.signetTr.slice(0, 10).toUpperCase() + ADDR.signetTr.slice(10)],
    ['garbage', 'not an address at all'],
    ['too short', 'tb1q'],
    ['legacy testnet base58', ADDR.signetLegacy],
    ['a number', 42],
  ])('refuses %s as invalid_address', (_, a) => {
    expect(checkSignetAddress(a)).toMatchObject({ ok: false, code: 'invalid_address' });
  });

  it('POST /v1/drip refuses bc1 before touching the challenge or any limit', async () => {
    const f = makeFaucet();
    const { body: ch } = await challenge(f);
    const res = await drip(f, { address: ADDR.mainnetTr, nonce: ch.nonce, solution: '1' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('mainnet_address_refused');
    expect(body.error.message).toMatch(/MAINNET/);
    // The challenge is still usable: refusal happened before it was consumed.
    expect((await solvedDripWith(f, ch.nonce, ADDR.signetTr)).status).toBe(200);
  });
});

async function solvedDripWith(f: ReturnType<typeof makeFaucet>, nonce: string, address: string, ip?: string) {
  const { solution } = solvePow(nonce, address, DIFFICULTY);
  return drip(f, { address, nonce, solution }, ip ? { ip } : {});
}

describe('proof of work', () => {
  it('a solved challenge drips the fixed amount to the lower-cased address', async () => {
    const f = makeFaucet({ dripSats: 50_000, explorerUrl: 'https://mempool.space/signet' });
    const res = await solvedDrip(f, ADDR.signetWpkh.toUpperCase());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ network: 'signet', address: ADDR.signetWpkh, amountSats: 50_000 });
    expect(body.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(body.explorerUrl).toBe(`https://mempool.space/signet/tx/${body.txid}`);
    expect(f.wallet.sent).toEqual([{ address: ADDR.signetWpkh, sats: 50_000, txid: body.txid }]);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a wrong solution (pow_invalid) and consumes the nonce anyway', async () => {
    const f = makeFaucet();
    const { body: ch } = await challenge(f);
    const bad = wrongSolution(ch.nonce, ADDR.signetTr, ch.difficulty);
    const res = await drip(f, { address: ADDR.signetTr, nonce: ch.nonce, solution: bad });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('pow_invalid');
    // A correct solution for the same nonce is now too late.
    const again = await solvedDripWith(f, ch.nonce, ADDR.signetTr);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe('challenge_used');
    expect(f.wallet.sent).toHaveLength(0);
  });

  it('refuses a replayed nonce after a successful drip (challenge_used), even for another address', async () => {
    const f = makeFaucet({ addressDripsPerDay: 5, ipDripsPerDay: 5 });
    const { body: ch } = await challenge(f);
    expect((await solvedDripWith(f, ch.nonce, ADDR.signetTr)).status).toBe(200);
    const replay = await solvedDripWith(f, ch.nonce, ADDR.signetTr);
    expect(replay.status).toBe(409);
    expect(await code(replay)).toBe('challenge_used');
    const other = await solvedDripWith(f, ch.nonce, ADDR.signetTr2);
    expect(await code(other)).toBe('challenge_used');
    expect(f.wallet.sent).toHaveLength(1);
  });

  it('a solution found for one address does not fund another', async () => {
    const f = makeFaucet();
    const { body: ch } = await challenge(f);
    // The first solution for A that is not also (by a 1-in-256 chance) a solution for B.
    let s = solvePow(ch.nonce, ADDR.signetTr, DIFFICULTY).solution;
    while (verifyPow({ nonce: ch.nonce, address: ADDR.signetTr2, solution: s, difficulty: DIFFICULTY })) s = solvePow(ch.nonce, ADDR.signetTr, DIFFICULTY, { start: Number(s) + 1 }).solution;
    const res = await drip(f, { address: ADDR.signetTr2, nonce: ch.nonce, solution: s });
    expect(await code(res)).toBe('pow_invalid');
  });

  it('refuses expired and unknown challenges', async () => {
    const f = makeFaucet({ challengeTtlMs: 60_000 });
    const { body: ch } = await challenge(f);
    f.advance(60_001);
    const res = await solvedDripWith(f, ch.nonce, ADDR.signetTr);
    expect(res.status).toBe(410);
    expect(await code(res)).toBe('challenge_expired');
    const unknown = await solvedDripWith(f, 'ab'.repeat(16), ADDR.signetTr);
    expect(unknown.status).toBe(400);
    expect(await code(unknown)).toBe('challenge_unknown');
  });

  it('a challenge carries the difficulty, an expiry and the message template; no-store', async () => {
    const f = makeFaucet({ challengeTtlMs: 120_000 });
    const { res, body } = await challenge(f);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ algorithm: 'sha256-leading-zero-bits/v1', difficulty: DIFFICULTY, ttlSeconds: 120 });
    expect(new Date(body.expiresAt).getTime()).toBe(f.now() + 120_000);
    expect((body as unknown as { message: string }).message).toBe(`scribbit-faucet-pow/v1:${body.nonce}:{address}:{solution}`);
  });

  it('rate-limits challenge issuance per IP', async () => {
    const f = makeFaucet({ challengesPerMinute: 2 });
    expect((await challenge(f)).res.status).toBe(200);
    expect((await challenge(f)).res.status).toBe(200);
    const third = await challenge(f);
    expect(third.res.status).toBe(429);
    expect(third.res.headers.get('retry-after')).toBeTruthy();
    expect((await challenge(f, '192.0.2.99')).res.status).toBe(200);
  });
});

describe('limits', () => {
  it('per address: one drip per day by default, then address_rate_limited with Retry-After; refills after 24 h', async () => {
    const f = makeFaucet();
    expect((await solvedDrip(f, ADDR.signetTr, '192.0.2.1')).status).toBe(200);
    const again = await solvedDrip(f, ADDR.signetTr, '192.0.2.2');
    expect(again.status).toBe(429);
    expect(await code(again)).toBe('address_rate_limited');
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(80_000);
    f.advance(86_400_000);
    expect((await solvedDrip(f, ADDR.signetTr, '192.0.2.3')).status).toBe(200);
  });

  it('per IP: three drips per day by default across addresses, then ip_rate_limited', async () => {
    const f = makeFaucet();
    const addrs = [ADDR.signetTr, ADDR.signetTr2, ADDR.signetWpkh];
    for (const a of addrs) expect((await solvedDrip(f, a, '198.51.100.7')).status).toBe(200);
    const fourth = await solvedDrip(f, ADDR.signetWpkh.replace(/.$/, ''), '198.51.100.7');
    // (a truncated address is invalid: the IP limit is not even consulted)
    expect(await code(fourth)).toBe('invalid_address');
    const f2 = makeFaucet({ ipDripsPerDay: 1 });
    expect((await solvedDrip(f2, ADDR.signetTr, '198.51.100.8')).status).toBe(200);
    const limited = await solvedDrip(f2, ADDR.signetTr2, '198.51.100.8');
    expect(limited.status).toBe(429);
    expect(await code(limited)).toBe('ip_rate_limited');
    expect((await solvedDrip(f2, ADDR.signetTr2, '198.51.100.9')).status).toBe(200);
  });

  it('a refusal by one bucket takes nothing from the other', async () => {
    const f = makeFaucet({ ipDripsPerDay: 1, addressDripsPerDay: 1 });
    expect((await solvedDrip(f, ADDR.signetTr, '203.0.113.1')).status).toBe(200);
    // Same address, new IP: refused by the address bucket; the new IP keeps its token.
    expect(await code(await solvedDrip(f, ADDR.signetTr, '203.0.113.2'))).toBe('address_rate_limited');
    expect((await solvedDrip(f, ADDR.signetTr2, '203.0.113.2')).status).toBe(200);
  });

  it('a general per-IP request bucket guards every route', async () => {
    const f = makeFaucet({ requestsPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await f.app.request('/v1/status')).status).toBe(200);
    const res = await f.app.request('/v1/status');
    expect(res.status).toBe(429);
    expect(await code(res)).toBe('rate_limited');
  });
});

describe('daily budget', () => {
  it('stops at the budget with budget_exhausted + Retry-After to 00:00 UTC, and resets the next UTC day', async () => {
    const f = makeFaucet({ dripSats: 10_000, dailyBudgetSats: 25_000, ipDripsPerDay: 10 });
    expect((await solvedDrip(f, ADDR.signetTr)).status).toBe(200);
    expect((await solvedDrip(f, ADDR.signetTr2)).status).toBe(200);
    const status = await (await f.app.request('/v1/status')).json();
    expect(status).toMatchObject({ open: false, reason: 'budget_exhausted', budgetRemainingSats: 5_000, budgetLimitSats: 25_000 });
    const res = await solvedDrip(f, ADDR.signetWpkh);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('budget_exhausted');
    // 12:00 UTC now: twelve hours to midnight.
    expect(Number(res.headers.get('retry-after'))).toBe(12 * 3600);
    expect(f.wallet.sent).toHaveLength(2);
    f.advance(12 * 3600 * 1000);
    expect((await solvedDrip(f, ADDR.signetWpkh)).status).toBe(200);
  });

  it('a budget refusal leaves the address and IP buckets untouched', async () => {
    const f = makeFaucet({ dripSats: 10_000, dailyBudgetSats: 10_000 });
    expect((await solvedDrip(f, ADDR.signetTr)).status).toBe(200);
    expect(await code(await solvedDrip(f, ADDR.signetTr2))).toBe('budget_exhausted');
    f.advance(12 * 3600 * 1000);
    expect((await solvedDrip(f, ADDR.signetTr2)).status).toBe(200);
  });
});

describe('wallet failures', () => {
  it('faucet_disabled by default (no wallet), before the nonce is consumed', async () => {
    const f = makeFaucet({ wallet: undefined });
    const f2 = { ...f, app: (await import('../src/index.js')).createApp({ powDifficulty: DIFFICULTY }) };
    const { body: ch } = await challenge(f2);
    const res = await solvedDripWith(f2, ch.nonce, ADDR.signetTr);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('faucet_disabled');
    expect(await (await f2.app.request('/v1/status')).json()).toMatchObject({ open: false, reason: 'faucet_disabled' });
    expect((await (await f2.app.request('/')).json()).wallet).toBe('off');
  });

  it('faucet_empty when the wallet runs dry; the limits and budget are refunded', async () => {
    const f = makeFaucet();
    f.wallet.balanceSats = 10;
    const res = await solvedDrip(f, ADDR.signetTr);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('faucet_empty');
    const st = await (await f.app.request('/v1/status')).json();
    expect(st.budgetRemainingSats).toBe(st.budgetLimitSats);
    f.wallet.balanceSats = 1_000_000;
    expect((await solvedDrip(f, ADDR.signetTr)).status).toBe(200);
  });

  it('wallet_unavailable (502) when bitcoind fails; reported to onUnexpected without leaking the message', async () => {
    const seen: unknown[] = [];
    const f = makeFaucet({ onUnexpected: (i) => seen.push(i.error) });
    f.wallet.failWith = new FaucetWalletError('unavailable', 'connect ECONNREFUSED 192.0.2.50:38332');
    const res = await solvedDrip(f, ADDR.signetTr);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('wallet_unavailable');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(seen).toHaveLength(1);
  });
});

describe('request validation', () => {
  it.each([
    ['not JSON', 'nope', 'bad_request'],
    ['an array', '[]', 'bad_request'],
    ['an unknown field', JSON.stringify({ address: 'x', nonce: 'y', solution: '1', email: 'a@b.c' }), 'bad_request'],
  ])('refuses %s', async (_, body, c) => {
    const f = makeFaucet();
    const res = await drip(f, body);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe(c);
  });

  it('refuses a non-JSON content type (415), a malformed nonce or solution (400), an oversized body (413)', async () => {
    const f = makeFaucet();
    expect(await code(await drip(f, { address: ADDR.signetTr, nonce: 'ab'.repeat(16), solution: '1' }, { contentType: 'text/plain' }))).toBe('unsupported_media_type');
    expect(await code(await drip(f, { address: ADDR.signetTr, nonce: 'XYZ', solution: '1' }))).toBe('bad_request');
    expect(await code(await drip(f, { address: ADDR.signetTr, nonce: 'ab'.repeat(16), solution: '007' }))).toBe('bad_request');
    const big = await drip(f, JSON.stringify({ address: ADDR.signetTr, nonce: 'ab'.repeat(16), solution: '1', pad: 'x'.repeat(5000) }));
    expect(big.status).toBe(413);
  });

  it('configuration guards: dust drip, budget below one drip, bad difficulty', async () => {
    const { createApp } = await import('../src/index.js');
    expect(() => createApp({ dripSats: 329 })).toThrow(/dust/);
    expect(() => createApp({ dripSats: 10_000, dailyBudgetSats: 9_999 })).toThrow(/dailyBudgetSats/);
    expect(() => createApp({ powDifficulty: 0 })).toThrow(/powDifficulty/);
  });
});

describe('metrics', () => {
  it('counts challenges, drips by result and sats; reports the budget; no addresses or IPs', async () => {
    const f = makeFaucet({ dripSats: 20_000 });
    await solvedDrip(f, ADDR.signetTr, '192.0.2.44');
    await solvedDrip(f, ADDR.signetTr, '192.0.2.45');
    await drip(f, { address: ADDR.mainnetTr, nonce: 'ab'.repeat(16), solution: '1' });
    const res = await f.app.request('/metrics');
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    expect(text).toMatch(/^faucet_challenges_issued_total 2$/m);
    expect(text).toMatch(/^faucet_drips_total\{result="ok"\} 1$/m);
    expect(text).toMatch(/^faucet_drips_total\{result="address_rate_limited"\} 1$/m);
    expect(text).toMatch(/^faucet_drips_total\{result="mainnet_address_refused"\} 1$/m);
    expect(text).toMatch(/^faucet_sats_sent_total 20000$/m);
    expect(text).toMatch(/^faucet_budget_remaining_sats 4980000$/m);
    expect(text).toMatch(/^faucet_wallet_enabled 1$/m);
    expect(text).not.toContain('tb1');
    expect(text).not.toContain('192.0.2');
  });
});
