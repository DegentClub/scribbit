import { describe, expect, it } from 'vitest';
import { Budget, budgetKey } from '../src/budget.ts';
import { CHECK_ORDER, decide, type AgentIdentity } from '../src/decide.ts';
import { parseEnvelopeInput, type Envelope, type SpendEnvelopeInput } from '../src/envelope.ts';
import { composeGraders, defaultGrader, type Grader } from '../src/grading.ts';
import { MemoryPlaneStore } from '../src/store/memory.ts';
import { agent, envelopeInput, MAIN_P2TR, MAIN_P2WPKH, MAIN_P2WSH, T0, transfer } from './helpers.ts';

const NOW = new Date(T0);

function envelope(over: Partial<SpendEnvelopeInput> = {}, extra: Partial<Envelope> = {}): Envelope {
  const r = parseEnvelopeInput(envelopeInput(over));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { ...r.value, orgId: 'scribbit', agentName: 'settlement', version: 1, setAt: NOW.toISOString(), setBy: { apiKeyId: 'k', approver: 'alice' }, supersededAt: null, ...extra };
}

function setup() {
  const store = new MemoryPlaneStore();
  let n = 0;
  const budget = new Budget(store, { ids: () => `rsv_${++n}` });
  const used = async () => (await store.readBudget(budgetKey('scribbit', 'settlement', 'btc:mainnet', '2026-09-24'))).used;
  return { store, budget, used };
}

const run = async (input: unknown, who: AgentIdentity = agent(), env: Envelope | null = envelope(), opts: Parameters<typeof decide>[5] = {}) => {
  const s = setup();
  const r = await decide(input, who, env ?? undefined, s.budget, NOW, opts);
  return { ...r, used: await s.used() };
};

describe('decide: each check and each code', () => {
  it('ALLOW: every check runs, the amount is reserved, impact LOW', async () => {
    const r = await run(transfer(25_000));
    expect(r).toMatchObject({ verdict: 'ALLOW', impact: 'LOW', checks: [...CHECK_ORDER], used: '25000' });
    expect(r.reservation).toMatchObject({ amount: '25000', status: 'RESERVED', expiresAt: new Date(T0 + 300_000).toISOString() });
    expect(r.code).toBeUndefined();
  });
  it('1. identity: an agent of another organisation, a malformed identity, or another agent\'s envelope is SCOPE_MISSING', async () => {
    expect(await run(transfer(1), agent({ orgId: 'degent' }), null, { orgId: 'scribbit' })).toMatchObject({ verdict: 'DENY', code: 'SCOPE_MISSING', checks: ['identity'], reasons: [expect.stringMatching(/^identity: /)] });
    expect(await run(transfer(1), agent({ agentName: 'Bad Name' }))).toMatchObject({ code: 'SCOPE_MISSING', checks: ['identity'] });
    expect(await run(transfer(1), agent(), envelope({}, { agentName: 'fee-oracle' }))).toMatchObject({ code: 'SCOPE_MISSING', checks: ['identity'] });
  });
  it('2. authority: no wallet:propose, or wallet:settle on the same key, is SCOPE_MISSING (exact match, default deny)', async () => {
    expect(await run(transfer(1), agent({ scopes: [] }))).toMatchObject({ code: 'SCOPE_MISSING', checks: ['identity', 'authority'], reasons: [expect.stringMatching(/^authority: /)] });
    expect(await run(transfer(1), agent({ scopes: ['wallet:propose:all', 'WALLET:PROPOSE'] }))).toMatchObject({ code: 'SCOPE_MISSING' });
    expect(await run(transfer(1), agent({ scopes: ['wallet:settle'] }))).toMatchObject({ code: 'SCOPE_MISSING' });
    expect(await run(transfer(1), agent({ scopes: ['wallet:propose', 'wallet:settle'] }))).toMatchObject({ code: 'SCOPE_MISSING', reasons: [expect.stringContaining('may never propose')] });
  });
  it('record: INVALID_RECORD and INVALID_AMOUNT before the envelope is consulted', async () => {
    expect(await run({ kind: 'transfer' })).toMatchObject({ code: 'INVALID_RECORD', checks: ['identity', 'authority', 'record'] });
    expect(await run(transfer('-5'))).toMatchObject({ code: 'INVALID_AMOUNT', checks: ['identity', 'authority', 'record'] });
    expect(await run(transfer(1, 'bc1notanaddress'))).toMatchObject({ code: 'INVALID_RECORD' });
  });
  it('3. envelope: NO_ENVELOPE (none, or another chain\'s)', async () => {
    expect(await run(transfer(1), agent(), null)).toMatchObject({ code: 'NO_ENVELOPE', checks: ['identity', 'authority', 'record', 'envelope'] });
    expect(await run(transfer(1), agent(), envelope({ chain: 'btc:signet', destinations: [] }))).toMatchObject({ code: 'NO_ENVELOPE' });
  });
  it('3. envelope: ENVELOPE_INACTIVE, KIND_NOT_PERMITTED, ASSET_NOT_PERMITTED, DESTINATION_NOT_PERMITTED, PER_TX_CAP', async () => {
    expect(await run(transfer(1), agent(), envelope({ active: false }))).toMatchObject({ code: 'ENVELOPE_INACTIVE' });
    expect(await run(transfer(1, MAIN_P2WPKH, { kind: 'meter' }))).toMatchObject({ code: 'KIND_NOT_PERMITTED' });
    expect(await run(transfer(1, MAIN_P2WPKH, { asset: 'rune:840000:3' }))).toMatchObject({ code: 'ASSET_NOT_PERMITTED' });
    expect(await run(transfer(1, MAIN_P2WSH))).toMatchObject({ code: 'DESTINATION_NOT_PERMITTED' });
    expect(await run(transfer(1, MAIN_P2WSH, { payee: { kind: 'club', ref: 'c' } }))).toMatchObject({ code: 'DESTINATION_NOT_PERMITTED', reasons: [expect.stringContaining('payee:club')] });
    expect(await run(transfer(100_001))).toMatchObject({ code: 'PER_TX_CAP', used: '0' });
    expect(await run(transfer(100_000), agent(), envelope({ autoApproveMax: '100000' }))).toMatchObject({ verdict: 'ALLOW' });
  });
  it('a payee:<kind> destination class admits any address of a payee of that kind', async () => {
    expect(await run(transfer(1_000, MAIN_P2WSH, { payee: { kind: 'artist', ref: 'ada' } }))).toMatchObject({ verdict: 'ALLOW', reasons: [expect.stringContaining('payee:artist'), expect.any(String)] });
  });
  it('4. budget: DAILY_CAP when today\'s reserved + committed + amount exceeds dailyMax; nothing reserved', async () => {
    const s = setup();
    const env = envelope();
    for (const amount of [100_000, 100_000]) expect((await decide(transfer(amount), agent(), env, s.budget, NOW, { orgId: 'scribbit' })).verdict).toBe('ESCALATE');
    const r = await decide(transfer(50_001), agent(), env, s.budget, NOW);
    expect(r).toMatchObject({ verdict: 'DENY', code: 'DAILY_CAP', checks: ['identity', 'authority', 'record', 'envelope', 'budget'] });
    expect(r.reservation).toBeUndefined();
    expect(await s.used()).toBe('200000');
    expect((await decide(transfer(50_000), agent(), env, s.budget, NOW)).verdict).toBe('ALLOW');
    expect(await s.used()).toBe('250000');
  });
  it('5. grading: above autoApproveMax escalates and the reservation is held for the decision (24 h)', async () => {
    const r = await run(transfer(60_000));
    expect(r).toMatchObject({ verdict: 'ESCALATE', impact: 'MEDIUM', checks: [...CHECK_ORDER], used: '60000' });
    expect(r.reservation?.expiresAt).toBe(new Date(T0 + 24 * 3600_000).toISOString());
  });
  it('5. grading: the role threshold from the charter (humanApprovalAtOrAbove) is applied', async () => {
    expect(await run(transfer(60_000), agent(), envelope({ humanApprovalAtOrAbove: 'CRITICAL' }))).toMatchObject({ verdict: 'ALLOW', impact: 'MEDIUM' });
    expect(await run(transfer(10), agent(), envelope({ humanApprovalAtOrAbove: 'LOW' }))).toMatchObject({ verdict: 'ESCALATE', impact: 'LOW' });
    expect(await run(transfer(10), agent(), envelope({ alwaysEscalate: true, escalationImpact: 'HIGH' }))).toMatchObject({ verdict: 'ESCALATE', impact: 'HIGH' });
  });
});

describe('decide: the order of the checks is load-bearing', () => {
  it('a record failing everything is refused by the earliest check', async () => {
    const worst = transfer('-1', MAIN_P2WSH, { kind: 'meter' });
    expect((await run(worst, agent({ orgId: 'degent' }), null, { orgId: 'scribbit' })).code).toBe('SCOPE_MISSING');
    expect((await run(worst, agent({ scopes: [] }))).code).toBe('SCOPE_MISSING');
    expect((await run(worst)).code).toBe('INVALID_AMOUNT');
    expect((await run(transfer(200_000, MAIN_P2WSH, { kind: 'meter' }), agent(), null)).code).toBe('NO_ENVELOPE');
    expect((await run(transfer(200_000, MAIN_P2WSH, { kind: 'meter' }), agent(), envelope({ active: false }))).code).toBe('ENVELOPE_INACTIVE');
    expect((await run(transfer(200_000, MAIN_P2WSH, { kind: 'meter', asset: 'x' }))).code).toBe('KIND_NOT_PERMITTED');
    expect((await run(transfer(200_000, MAIN_P2WSH, { asset: 'x' }))).code).toBe('ASSET_NOT_PERMITTED');
    expect((await run(transfer(200_000, MAIN_P2WSH))).code).toBe('DESTINATION_NOT_PERMITTED');
    expect((await run(transfer(200_000))).code).toBe('PER_TX_CAP');
  });
  it('the envelope refuses before the budget is touched, and grading runs only after a reservation', async () => {
    let graded = 0;
    const counting: Grader = { name: 'count', grade: () => (graded++, { verdict: 'ALLOW', reasons: [] }) };
    const s = setup();
    await decide(transfer(200_000), agent(), envelope(), s.budget, NOW, { grader: counting });
    expect([graded, await s.used()]).toEqual([0, '0']);
    await decide(transfer(1_000), agent(), envelope(), s.budget, NOW, { grader: counting });
    expect([graded, await s.used()]).toEqual([1, '1000']);
  });
});

describe('grading: the pluggable post-check', () => {
  it('default: a denylisted destination is DENY DESTINATION_NOT_PERMITTED and the reservation is released', async () => {
    const s = setup();
    const r = await decide(transfer(1_000, MAIN_P2WPKH), agent(), envelope(), s.budget, NOW, { grader: defaultGrader({ denylist: [MAIN_P2WPKH.toUpperCase()] }) });
    expect(r).toMatchObject({ verdict: 'DENY', code: 'DESTINATION_NOT_PERMITTED', checks: [...CHECK_ORDER], reasons: expect.arrayContaining([expect.stringContaining('denylist')]) });
    expect(r.reservation).toBeUndefined();
    expect(await s.used()).toBe('0');
    expect((await s.store.getReservation('rsv_1'))?.status).toBe('RELEASED');
  });
  it('default: a first-time destination above the threshold escalates; a known one, or a small amount, does not', async () => {
    const known = new Set([MAIN_P2TR]);
    const grader = defaultGrader({ firstTimeEscalateAbove: 10_000n, seen: async (_o, _c, d) => known.has(d) });
    expect(await run(transfer(20_000, MAIN_P2WPKH), agent(), envelope(), { grader })).toMatchObject({ verdict: 'ESCALATE', reasons: expect.arrayContaining([expect.stringContaining('first payment')]) });
    expect(await run(transfer(20_000, MAIN_P2TR), agent(), envelope(), { grader })).toMatchObject({ verdict: 'ALLOW' });
    expect(await run(transfer(10_000, MAIN_P2WPKH), agent(), envelope(), { grader })).toMatchObject({ verdict: 'ALLOW' });
  });
  it('composeGraders: the first DENY wins; any ESCALATE escalates; a grader can never loosen the policy', async () => {
    const esc: Grader = { name: 'esc', grade: () => ({ verdict: 'ESCALATE', impact: 'HIGH', reasons: ['esc'] }) };
    const no: Grader = { name: 'no', grade: () => ({ verdict: 'DENY', code: 'DESTINATION_NOT_PERMITTED', reasons: ['no'] }) };
    const yes: Grader = { name: 'yes', grade: () => ({ verdict: 'ALLOW', reasons: ['yes'] }) };
    expect(await run(transfer(1), agent(), envelope(), { grader: composeGraders(yes, esc, no) })).toMatchObject({ verdict: 'DENY', reasons: expect.arrayContaining(['yes', 'esc', 'no']) });
    expect(await run(transfer(1), agent(), envelope(), { grader: composeGraders(yes, esc) })).toMatchObject({ verdict: 'ESCALATE', impact: 'HIGH' });
    expect(await run(transfer(60_000), agent(), envelope(), { grader: yes })).toMatchObject({ verdict: 'ESCALATE' });
  });
  it('a grader that throws releases the reservation and propagates', async () => {
    const s = setup();
    const boom: Grader = { name: 'boom', grade: () => { throw new Error('down'); } };
    await expect(decide(transfer(1_000), agent(), envelope(), s.budget, NOW, { grader: boom })).rejects.toThrow('down');
    expect(await s.used()).toBe('0');
  });
});
