import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '@bsh/mesh';
import { canonicalAuthorization, MemoryNonceStore, signAuthorization, verifyAuthorization, type SpendAuthorizationPayload } from '../src/authorization.ts';
import { MAIN_P2TR, MAIN_P2WPKH, PLANE_KEY, RETIRED_KEY, STRANGER_KEY, T0 } from './helpers.ts';

const payload = (over: Partial<SpendAuthorizationPayload> = {}): SpendAuthorizationPayload => ({
  id: 'auth_0001',
  orgId: 'scribbit',
  agentName: 'settlement',
  chain: 'btc:mainnet',
  kind: 'transfer',
  asset: 'native',
  maxAmount: '25000',
  destination: MAIN_P2WPKH,
  reservationId: 'rsv_0001',
  decisionId: 'dec_0001',
  issuedAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 300_000).toISOString(),
  ...over,
});
const at = (ms: number) => new Date(T0 + ms);
const trusted = [PLANE_KEY.publicKey];
const op = (over: Record<string, unknown> = {}) => ({ chain: 'btc:mainnet', kind: 'transfer' as const, asset: 'native', amount: '25000', destination: MAIN_P2WPKH, ...over });

describe('SpendAuthorization signing (FlashyOS spec §6)', () => {
  it('signs the canonical JSON of every field but sig, keys sorted, no whitespace', () => {
    const a = signAuthorization(payload(), PLANE_KEY.privateKey);
    expect(canonicalAuthorization(a).toString('utf8')).toBe(canonicalStringify(payload()));
    expect(canonicalAuthorization(a).toString('utf8').startsWith('{"agentName":"settlement","asset":"native","chain":"btc:mainnet"')).toBe(true);
    expect(a.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });
  it('verifies under the plane key, and under a retired key it still trusts', async () => {
    expect(await verifyAuthorization(signAuthorization(payload(), PLANE_KEY.privateKey), { trustedKeys: trusted, now: at(0) })).toEqual({ ok: true });
    expect(await verifyAuthorization(signAuthorization(payload(), RETIRED_KEY.privateKey), { trustedKeys: [PLANE_KEY.publicKey, RETIRED_KEY.publicKey], now: at(0) })).toEqual({ ok: true });
  });
  it('BAD_SIGNATURE: any signed field altered, a stranger\'s key, or garbage sig', async () => {
    const a = signAuthorization(payload(), PLANE_KEY.privateKey);
    for (const tamper of [{ maxAmount: '25001' }, { destination: MAIN_P2TR }, { agentName: 'other' }, { expiresAt: new Date(T0 + 299_000).toISOString() }, { reservationId: 'rsv_x' }])
      expect(await verifyAuthorization({ ...a, ...tamper }, { trustedKeys: trusted, now: at(0) })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(await verifyAuthorization(signAuthorization(payload(), STRANGER_KEY.privateKey), { trustedKeys: trusted, now: at(0) })).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(await verifyAuthorization({ ...a, sig: 'not base64url!' }, { trustedKeys: trusted, now: at(0) })).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(await verifyAuthorization(a, { trustedKeys: ['not a pem'], now: at(0) })).toMatchObject({ code: 'BAD_SIGNATURE' });
  });
  it('MALFORMED: wrong shape, extra members, a window longer than 300 s or inverted', async () => {
    expect(await verifyAuthorization(null, { trustedKeys: trusted })).toMatchObject({ code: 'MALFORMED' });
    expect(await verifyAuthorization({ ...signAuthorization(payload(), PLANE_KEY.privateKey), extra: 1 }, { trustedKeys: trusted })).toMatchObject({ code: 'MALFORMED' });
    expect(await verifyAuthorization({ ...signAuthorization(payload(), PLANE_KEY.privateKey), maxAmount: '1.5' }, { trustedKeys: trusted })).toMatchObject({ code: 'MALFORMED' });
    expect(await verifyAuthorization(signAuthorization(payload({ expiresAt: new Date(T0 + 300_001).toISOString() }), PLANE_KEY.privateKey), { trustedKeys: trusted, now: at(0) })).toMatchObject({ code: 'MALFORMED' });
    expect(await verifyAuthorization(signAuthorization(payload({ expiresAt: new Date(T0).toISOString() }), PLANE_KEY.privateKey), { trustedKeys: trusted, now: at(0) })).toMatchObject({ code: 'MALFORMED' });
  });
  it('the window: EXPIRED after expiresAt, NOT_YET_VALID beyond 30 s of skew', async () => {
    const a = signAuthorization(payload(), PLANE_KEY.privateKey);
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(300_000) })).toEqual({ ok: true });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(300_001) })).toMatchObject({ code: 'EXPIRED' });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(-30_000) })).toEqual({ ok: true });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(-30_001) })).toMatchObject({ code: 'NOT_YET_VALID' });
  });
});

describe('the signer re-derives the operation from the call (never from the authorization)', () => {
  const a = signAuthorization(payload(), PLANE_KEY.privateKey);
  it('matches: same chain, kind, asset, destination (normalised) and amount <= maxAmount', async () => {
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(1), operation: op({ amount: 25_000n }) })).toEqual({ ok: true });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(1), operation: op({ amount: '1', destination: MAIN_P2WPKH.toUpperCase() }) })).toEqual({ ok: true });
  });
  it.each([
    ['chain', { chain: 'btc:signet' }],
    ['kind', { kind: 'swap' }],
    ['asset', { asset: 'rune:1' }],
    ['destination', { destination: MAIN_P2TR }],
    ['destination null', { destination: null }],
    ['amount above maxAmount', { amount: '25001' }],
    ['amount not an amount', { amount: '-1' }],
  ])('MISMATCH on %s', async (_what, over) => {
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(1), operation: op(over) })).toMatchObject({ ok: false, code: 'MISMATCH' });
  });
});

describe('single use (the id is the nonce)', () => {
  it('a second use is REPLAY; a refused call does not burn the nonce', async () => {
    const nonces = new MemoryNonceStore(() => T0);
    const a = signAuthorization(payload(), PLANE_KEY.privateKey);
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(1), nonces, operation: op({ destination: MAIN_P2TR }) })).toMatchObject({ code: 'MISMATCH' });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(1), nonces, operation: op() })).toEqual({ ok: true });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(2), nonces, operation: op() })).toMatchObject({ ok: false, code: 'REPLAY' });
    // a different authorization is its own nonce
    expect(await verifyAuthorization(signAuthorization(payload({ id: 'auth_0002' }), PLANE_KEY.privateKey), { trustedKeys: trusted, now: at(2), nonces })).toEqual({ ok: true });
  });
  it('an expired authorization is EXPIRED, not REPLAY, even after its nonce was forgotten', async () => {
    const nonces = new MemoryNonceStore(() => T0 + 400_000);
    const a = signAuthorization(payload(), PLANE_KEY.privateKey);
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(1), nonces })).toEqual({ ok: true });
    expect(await verifyAuthorization(a, { trustedKeys: trusted, now: at(400_000), nonces })).toMatchObject({ code: 'EXPIRED' });
  });
});
