import { describe, expect, it } from 'vitest';
import { validatePlaneDocument, verifyPlaneDocument } from '@bsh/mesh';
import { verifyAuditChain } from '../src/audit.ts';
import { MemoryNonceStore, verifyAuthorization } from '../src/authorization.ts';
import { budgetKey } from '../src/budget.ts';
import { LedgerPortError, type LedgerObservation, type LedgerPort } from '../src/ledger.ts';
import { PlaneError, PlaneService, type VerdictBody } from '../src/service.ts';
import { MemoryPlaneStore } from '../src/store/memory.ts';
import { SqlitePlaneStore } from '../src/store/sqlite.ts';
import type { PlaneStore } from '../src/store/types.ts';
import { agent, AGENT, harness, MAIN_P2TR, MAIN_P2WPKH, MAIN_P2WSH, ORG, PLANE_KEY, RETIRED_KEY, T0, transfer } from './helpers.ts';

const KEY = budgetKey(ORG, AGENT, 'btc:mainnet', '2026-09-24');
const TX = 'ab'.repeat(32);
const allow = (v: VerdictBody) => {
  if (v.verdict !== 'ALLOW') throw new Error(`expected ALLOW, got ${JSON.stringify(v)}`);
  return v;
};

const stores: [string, () => PlaneStore][] = [
  ['memory', () => new MemoryPlaneStore()],
  ['sqlite', () => new SqlitePlaneStore(':memory:')],
];

describe.each(stores)('PlaneService on the %s store', (_name, make) => {
  it('ALLOW issues a signed, verifiable, 5-minute authorization over the reservation, and audits both', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    expect(v.authorization).toMatchObject({ orgId: ORG, agentName: AGENT, chain: 'btc:mainnet', kind: 'transfer', asset: 'native', maxAmount: '25000', destination: MAIN_P2WPKH, decisionId: v.decisionId, issuedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 300_000).toISOString() });
    expect(await verifyAuthorization(v.authorization, { trustedKeys: h.service.trustedKeys(), now: h.clock.now(), operation: { chain: 'btc:mainnet', kind: 'transfer', asset: 'native', amount: '25000', destination: MAIN_P2WPKH } })).toEqual({ ok: true });
    expect((await h.store.readBudget(KEY)).used).toBe('25000');
    const log = await h.service.listAudit(ORG);
    expect(log.entries.map((e) => e.kind)).toEqual(['envelope', 'decision', 'authorization']);
    expect(verifyAuditChain(log.entries, { head: log.head!, trustedKeys: h.service.trustedKeys() })).toMatchObject({ ok: true, entries: 3 });
  });
  it('DENY is recorded like any verdict (refusals are evidence) and reserves nothing', async () => {
    const h = harness({ store: make() });
    const v = await h.propose(transfer(1));
    expect(v).toMatchObject({ verdict: 'DENY', code: 'NO_ENVELOPE', reason: expect.stringContaining('no envelope'), decisionId: expect.stringMatching(/^dec_/) });
    const [entry] = (await h.service.listAudit(ORG)).entries;
    expect(entry).toMatchObject({ kind: 'decision', data: { verdict: 'DENY', code: 'NO_ENVELOPE', checks: ['identity', 'authority', 'record', 'envelope'] } });
    expect(await h.store.getDecision(v.decisionId)).toMatchObject({ status: 'DENIED' });
  });
  it('the raw call is never stored, only its digest; an unparseable body is audited by digest', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope();
    const v = await h.propose(transfer(1_000, MAIN_P2WPKH, { raw: { prompt: 'pay the artist' } }));
    const d = await h.store.getDecision(v.decisionId);
    expect(d?.record).not.toHaveProperty('raw');
    expect(d?.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    const bad = await h.propose({ kind: 'transfer', junk: 'x'.repeat(100) });
    expect((await h.store.getDecision(bad.decisionId))).toMatchObject({ record: {}, rawSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
  it('commit: SPENT, COMMITTED (still counts), destination remembered, audited; a replay is harmless; a different tx conflicts', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    const r = await h.service.commit(ORG, v.authorization.id, TX);
    expect(r).toMatchObject({ authorization: { status: 'SPENT', txHash: TX, spentAt: new Date(T0).toISOString() }, reservation: { status: 'COMMITTED' }, anomaly: null });
    expect((await h.store.readBudget(KEY)).used).toBe('25000');
    expect(await h.store.hasDestination(ORG, 'btc:mainnet', MAIN_P2WPKH)).toBe(true);
    expect(await h.service.commit(ORG, v.authorization.id, TX)).toMatchObject({ replayed: true, authorization: { status: 'SPENT' } });
    await expect(h.service.commit(ORG, v.authorization.id, 'cd'.repeat(32))).rejects.toMatchObject({ status: 409, code: 'SETTLEMENT_CONFLICT' });
    await expect(h.service.rollback(ORG, v.authorization.id, TX)).rejects.toMatchObject({ code: 'SETTLEMENT_CONFLICT' });
    // committed money keeps counting even after the authorization window
    h.clock.tick(600_000);
    await h.service.sweep();
    expect((await h.store.readBudget(KEY)).used).toBe('25000');
  });
  it('rollback: REVOKED, RELEASED (stops counting); replay harmless; commit after rollback conflicts', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    expect(await h.service.rollback(ORG, v.authorization.id, TX)).toMatchObject({ authorization: { status: 'REVOKED', txHash: TX }, reservation: { status: 'RELEASED' } });
    expect((await h.store.readBudget(KEY)).used).toBe('0');
    expect(await h.service.rollback(ORG, v.authorization.id, TX)).toMatchObject({ replayed: true });
    await expect(h.service.commit(ORG, v.authorization.id, TX)).rejects.toMatchObject({ code: 'SETTLEMENT_CONFLICT' });
  });
  it('expiry: an authorization unspent after 5 minutes expires and releases its reservation; a late confirmation is still recorded, flagged', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    h.clock.tick(300_000);
    expect(await h.service.sweep()).toEqual({ authorizations: 1, decisions: 0, reservations: 0 });
    expect((await h.store.readBudget(KEY)).used).toBe('0');
    expect(await h.store.getAuthorization(v.authorization.id)).toMatchObject({ status: 'EXPIRED' });
    const late = await h.service.commit(ORG, v.authorization.id, TX);
    expect(late).toMatchObject({ anomaly: 'EXPIRED_BEFORE_SETTLE', authorization: { status: 'SPENT' }, reservation: { status: 'COMMITTED' } });
    expect((await h.store.readBudget(KEY)).used).toBe('25000');
    expect((await h.service.listAudit(ORG)).entries.map((e) => e.kind)).toEqual(['envelope', 'decision', 'authorization', 'expiry', 'settlement']);
  });
  it('ESCALATE holds the reservation; a person approves (fresh window) or rejects (released); expiry releases an unresolved one', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope();
    const esc = await h.propose(transfer(60_000));
    expect(esc).toMatchObject({ verdict: 'ESCALATE', impact: 'MEDIUM', reservationId: expect.stringMatching(/^rsv_/) });
    if (esc.verdict !== 'ESCALATE') throw new Error();
    expect((await h.store.readBudget(KEY)).used).toBe('60000');
    h.clock.tick(3600_000);
    const res = await h.service.resolveDecision(ORG, esc.decisionId, 'APPROVED', { approver: 'alice', apiKeyId: 'key-human' });
    expect(res.decision).toMatchObject({ status: 'APPROVED', resolvedBy: 'alice', authorizationId: res.authorization!.id });
    expect(res.authorization).toMatchObject({ maxAmount: '60000', reservationId: esc.reservationId, decisionId: esc.decisionId, issuedAt: new Date(T0 + 3600_000).toISOString() });
    await expect(h.service.resolveDecision(ORG, esc.decisionId, 'REJECTED', { approver: 'alice' })).rejects.toMatchObject({ code: 'DECISION_NOT_PENDING' });

    const esc2 = await h.propose(transfer(70_000, MAIN_P2TR));
    await h.service.resolveDecision(ORG, esc2.decisionId, 'REJECTED', { approver: 'bob', note: 'unknown payee' });
    expect((await h.store.readBudget(KEY)).used).toBe('60000');

    const esc3 = await h.propose(transfer(80_000));
    expect((await h.store.readBudget(KEY)).used).toBe('140000');
    h.clock.tick(24 * 3600_000);
    expect(await h.service.sweep()).toMatchObject({ decisions: 1 });
    expect(await h.store.getDecision(esc3.decisionId)).toMatchObject({ status: 'EXPIRED' });
    await expect(h.service.resolveDecision(ORG, esc3.decisionId, 'APPROVED', { approver: 'alice' })).rejects.toMatchObject({ code: 'DECISION_NOT_PENDING' });
    await expect(h.service.resolveDecision('degent', esc3.decisionId, 'APPROVED', { approver: 'alice' })).rejects.toMatchObject({ code: 'DECISION_NOT_FOUND' });
  });
  it('RACE through the service: two concurrent proposals exceeding the daily cap - one ALLOW, one DENY DAILY_CAP', async () => {
    const h = harness({ store: make() });
    await h.setEnvelope({ dailyMax: '100000', autoApproveMax: '100000' });
    const out = await Promise.all([h.propose(transfer(60_000)), h.propose(transfer(60_000, MAIN_P2TR))]);
    expect(out.map((v) => v.verdict).sort()).toEqual(['ALLOW', 'DENY']);
    expect(out.find((v) => v.verdict === 'DENY')).toMatchObject({ code: 'DAILY_CAP' });
    expect((await h.store.readBudget(KEY)).used).toBe('60000');
  });
  it('envelopes: versions are kept, the current one decides, an inactive one refuses', async () => {
    const h = harness({ store: make() });
    const v1 = await h.setEnvelope();
    const v2 = await h.setEnvelope({ destinations: [MAIN_P2WSH] });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await h.store.envelopeHistory(ORG, AGENT, 'btc:mainnet')).map((e) => [e.version, e.supersededAt !== null])).toEqual([[1, true], [2, false]]);
    expect(await h.service.listEnvelopes(ORG, AGENT)).toHaveLength(1);
    expect(await h.propose(transfer(1_000))).toMatchObject({ code: 'DESTINATION_NOT_PERMITTED' });
    expect(await h.propose(transfer(1_000, MAIN_P2WSH))).toMatchObject({ verdict: 'ALLOW' });
    await h.setEnvelope({ destinations: [MAIN_P2WSH], active: false });
    expect(await h.propose(transfer(1_000, MAIN_P2WSH))).toMatchObject({ code: 'ENVELOPE_INACTIVE' });
    await expect(h.service.putEnvelope(ORG, AGENT, { chain: 'evm:8453' }, { apiKeyId: 'k', approver: 'a' })).rejects.toMatchObject({ status: 400, code: 'invalid_envelope' });
  });
});

describe('idempotent proposals', () => {
  it('a replay returns the same verdict and reserves nothing; another record under the key is idempotency_conflict', async () => {
    const h = harness();
    await h.setEnvelope();
    const a = allow(await h.propose(transfer(25_000), agent(), 'k-1'));
    const b = allow(await h.propose(transfer(25_000), agent(), 'k-1'));
    expect(b).toEqual({ ...a, replayed: true });
    expect((await h.store.readBudget(KEY)).used).toBe('25000');
    await expect(h.propose(transfer(25_001), agent(), 'k-1')).rejects.toMatchObject({ status: 422, code: 'idempotency_conflict' });
    // scoped per agent: another agent may use the same key
    await h.setEnvelope({}, 'fee-oracle');
    expect((await h.propose(transfer(25_000), agent({ agentName: 'fee-oracle' }), 'k-1')).replayed).toBeUndefined();
  });
  it('a replay reports the decision as it is now: escalated, then approved', async () => {
    const h = harness();
    await h.setEnvelope();
    const esc = await h.propose(transfer(60_000), agent(), 'k-2');
    expect(await h.propose(transfer(60_000), agent(), 'k-2')).toMatchObject({ verdict: 'ESCALATE', replayed: true, decisionId: esc.decisionId });
    await h.service.resolveDecision(ORG, esc.decisionId, 'APPROVED', { approver: 'alice' });
    expect(await h.propose(transfer(60_000), agent(), 'k-2')).toMatchObject({ verdict: 'ALLOW', replayed: true, decisionId: esc.decisionId });
    expect((await h.store.readBudget(KEY)).used).toBe('60000');
  });
  it('a rejected or expired decision is not replayed as a verdict', async () => {
    const h = harness({ decisionTtlMs: 3600_000 });
    await h.setEnvelope();
    const esc = await h.propose(transfer(60_000), agent(), 'k-3');
    await h.service.resolveDecision(ORG, esc.decisionId, 'REJECTED', { approver: 'alice' });
    await expect(h.propose(transfer(60_000), agent(), 'k-3')).rejects.toMatchObject({ status: 409, code: 'DECISION_REJECTED' });
    await h.propose(transfer(61_000), agent(), 'k-4');
    h.clock.tick(3600_000);
    await expect(h.propose(transfer(61_000), agent(), 'k-4')).rejects.toMatchObject({ code: 'DECISION_EXPIRED' });
  });
  it('concurrent proposals under one key decide once', async () => {
    const h = harness();
    await h.setEnvelope();
    const out = await Promise.allSettled([h.propose(transfer(10_000), agent(), 'k-5'), h.propose(transfer(10_000), agent(), 'k-5')]);
    expect((await h.store.readBudget(KEY)).used).toBe('10000');
    const ok = out.filter((o) => o.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const o of out) if (o.status === 'rejected') expect(o.reason).toMatchObject({ code: 'proposal_in_flight' });
  });
});

describe('grading defaults in the service', () => {
  it('first-time destinations above 100 000 sats escalate until one has been paid; the denylist refuses', async () => {
    const h = harness({ firstTimeEscalateAbove: undefined, denylist: [MAIN_P2WSH] });
    await h.setEnvelope({ perTxMax: '200000', dailyMax: '1000000', autoApproveMax: '200000', destinations: [MAIN_P2WPKH, MAIN_P2WSH] });
    expect(await h.propose(transfer(150_000))).toMatchObject({ verdict: 'ESCALATE', reasons: expect.arrayContaining([expect.stringContaining('first payment')]) });
    const small = allow(await h.propose(transfer(100_000)));
    await h.service.commit(ORG, small.authorization.id, TX);
    expect(await h.propose(transfer(150_000))).toMatchObject({ verdict: 'ALLOW' });
    expect(await h.propose(transfer(1_000, MAIN_P2WSH))).toMatchObject({ verdict: 'DENY', code: 'DESTINATION_NOT_PERMITTED', reasons: expect.arrayContaining([expect.stringContaining('denylist')]) });
  });
});

describe('the ledger port', () => {
  const obs: LedgerObservation = { paymentId: 'pay_1', outputs: [{ scriptHex: '0014751e76e8199196d454941c45d1b3a323f1433bd6', valueSats: 25_000 }], confirmations: 1 };
  it('a CONFIRMED settlement with an observation is reported to the ledger', async () => {
    const calls: [string, LedgerObservation][] = [];
    const ledger: LedgerPort = { observe: async (txid, o) => (calls.push([txid, o]), { applied: true }) };
    const h = harness({ ledger });
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    expect(await h.service.settle(ORG, { authorizationId: v.authorization.id, outcome: 'CONFIRMED', txHash: TX, ledger: obs })).toMatchObject({ ledger: { recorded: true, applied: true } });
    expect(calls).toEqual([[TX, obs]]);
  });
  it('a ledger failure never undoes the commit (the chain is a fact); no ledger configured says so', async () => {
    const h = harness({ ledger: { observe: async () => { throw new LedgerPortError('ledger unreachable', 0); } } });
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    expect(await h.service.settle(ORG, { authorizationId: v.authorization.id, outcome: 'CONFIRMED', txHash: TX, ledger: obs })).toMatchObject({ authorization: { status: 'SPENT' }, ledger: { recorded: false, error: 'ledger unreachable' } });
    const h2 = harness();
    await h2.setEnvelope();
    const v2 = allow(await h2.propose(transfer(25_000)));
    expect(await h2.service.settle(ORG, { authorizationId: v2.authorization.id, outcome: 'CONFIRMED', txHash: TX, ledger: obs })).toMatchObject({ ledger: { recorded: false, error: expect.stringContaining('no ledger') } });
  });
  it('settle validates its input and scopes authorizations to the organisation', async () => {
    const h = harness();
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    for (const bad of [{}, { authorizationId: v.authorization.id, outcome: 'MAYBE', txHash: TX }, { authorizationId: v.authorization.id, outcome: 'CONFIRMED' }, { authorizationId: v.authorization.id, outcome: 'CONFIRMED', txHash: TX, ledger: { paymentId: 'x', outputs: [] } }])
      await expect(h.service.settle(ORG, bad)).rejects.toMatchObject({ status: 400, code: 'SETTLEMENT_INVALID' });
    await expect(h.service.settle('degent', { authorizationId: v.authorization.id, outcome: 'CONFIRMED', txHash: TX })).rejects.toMatchObject({ status: 404, code: 'AUTHORIZATION_NOT_FOUND' });
    await expect(h.service.settle(ORG, { authorizationId: 'auth_nope', outcome: 'REVERTED', txHash: TX })).rejects.toBeInstanceOf(PlaneError);
  });
});

describe('plane document and keys', () => {
  it('is a valid @bsh/mesh PlaneDocument: our active key, the retired one, the btc chains, the FlashyOS schemas', () => {
    const h = harness();
    const doc = h.service.planeDocument();
    expect(validatePlaneDocument(doc)).toEqual([]);
    expect(verifyPlaneDocument(doc)).toMatchObject({ ok: true });
    expect(doc.keys.map((k) => [k.publicKey, k.status])).toEqual([[PLANE_KEY.publicKey, 'active'], [RETIRED_KEY.publicKey, 'retired']]);
    expect(doc.chains).toEqual(['btc:mainnet', 'btc:signet', 'btc:testnet']);
    expect(doc.schemas).toContain('https://flashyos.com/schema/wallet/spend-authorization.json');
  });
  it('refuses a non-Ed25519 signing key', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => new PlaneService({ store: new MemoryPlaneStore(), signingKey: ec })).toThrow(/Ed25519/);
  });
  it('an authorization verified by a signer with a nonce store is single use across the whole flow', async () => {
    const h = harness();
    await h.setEnvelope();
    const v = allow(await h.propose(transfer(25_000)));
    const nonces = new MemoryNonceStore(() => T0);
    const call = { chain: 'btc:mainnet', kind: 'transfer' as const, asset: 'native', amount: '24000', destination: MAIN_P2WPKH };
    expect(await verifyAuthorization(v.authorization, { trustedKeys: h.service.planeDocument().keys.map((k) => k.publicKey), now: h.clock.now(), nonces, operation: call })).toEqual({ ok: true });
    expect(await verifyAuthorization(v.authorization, { trustedKeys: h.service.trustedKeys(), now: h.clock.now(), nonces, operation: call })).toMatchObject({ code: 'REPLAY' });
  });
});
