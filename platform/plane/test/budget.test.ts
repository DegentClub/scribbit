import { describe, expect, it } from 'vitest';
import { Budget, BudgetContentionError, budgetKey, utcDay } from '../src/budget.ts';
import { decide } from '../src/decide.ts';
import { parseEnvelopeInput, type Envelope } from '../src/envelope.ts';
import { MemoryPlaneStore } from '../src/store/memory.ts';
import { SqlitePlaneStore } from '../src/store/sqlite.ts';
import type { BudgetStore, PlaneStore } from '../src/store/types.ts';
import { agent, envelopeInput, T0, transfer } from './helpers.ts';

const NOW = new Date(T0);
const KEY = budgetKey('scribbit', 'settlement', 'btc:mainnet', '2026-09-24');
const stores: [string, () => PlaneStore][] = [
  ['memory', () => new MemoryPlaneStore()],
  ['sqlite', () => new SqlitePlaneStore(':memory:')],
];

const req = (amount: bigint, over: Partial<Parameters<Budget['reserve']>[0]> = {}) => ({ orgId: 'scribbit', agentName: 'settlement', chain: 'btc:mainnet', amount, cap: 100_000n, now: NOW, ttlMs: 300_000, ...over });

describe.each(stores)('budget on the %s store', (_name, make) => {
  it('reserves under the cap, refuses over it, and keys by (org, agent, chain, UTC day)', async () => {
    const store = make();
    const b = new Budget(store);
    expect(await b.reserve(req(60_000n))).toMatchObject({ ok: true, usedBefore: 0n, reservation: { key: KEY, day: '2026-09-24', amount: '60000', status: 'RESERVED' } });
    expect(await b.reserve(req(40_001n))).toEqual({ ok: false, used: 60_000n, cap: 100_000n });
    expect(await b.reserve(req(40_000n))).toMatchObject({ ok: true, usedBefore: 60_000n });
    // another chain, another agent, another day: separate rows
    expect(await b.reserve(req(100_000n, { chain: 'btc:signet' }))).toMatchObject({ ok: true });
    expect(await b.reserve(req(100_000n, { agentName: 'fee-oracle' }))).toMatchObject({ ok: true });
    expect(await b.reserve(req(100_000n, { now: new Date(T0 + 14 * 3600_000) }))).toMatchObject({ ok: true, reservation: { day: '2026-09-25' } });
    expect(await store.readBudget(KEY)).toEqual({ used: '100000', version: 2 });
  });
  it('commit keeps counting, release stops counting, and neither happens twice', async () => {
    const store = make();
    const b = new Budget(store);
    const a = await b.reserve(req(30_000n));
    const c = await b.reserve(req(20_000n));
    if (!a.ok || !c.ok) throw new Error('reserve');
    expect(await b.commit(a.reservation.id, NOW)).toMatchObject({ status: 'COMMITTED' });
    expect(await b.commit(a.reservation.id, NOW)).toBeUndefined();
    expect(await b.release(a.reservation.id, NOW, 'x')).toBeUndefined();
    expect((await store.readBudget(KEY)).used).toBe('50000');
    expect(await b.release(c.reservation.id, NOW, 'reverted')).toMatchObject({ status: 'RELEASED', reason: 'reverted' });
    expect(await b.release(c.reservation.id, NOW, 'again')).toBeUndefined();
    expect((await store.readBudget(KEY)).used).toBe('30000');
  });
  it('sweep releases what expired and nothing else; extend holds longer', async () => {
    const store = make();
    const b = new Budget(store);
    const short = await b.reserve(req(10_000n));
    const held = await b.reserve(req(20_000n));
    if (!short.ok || !held.ok) throw new Error('reserve');
    await b.extend(held.reservation.id, new Date(T0 + 3600_000));
    expect(await b.sweep(new Date(T0 + 299_999))).toEqual([]);
    const released = await b.sweep(new Date(T0 + 300_000));
    expect(released.map((r) => r.id)).toEqual([short.reservation.id]);
    expect((await store.readBudget(KEY)).used).toBe('20000');
    expect((await b.sweep(new Date(T0 + 3600_000))).map((r) => r.id)).toEqual([held.reservation.id]);
    expect((await store.readBudget(KEY)).used).toBe('0');
  });
  it('a late confirmation brings a released reservation back (RELEASED → COMMITTED counts again)', async () => {
    const store = make();
    const b = new Budget(store);
    const r = await b.reserve(req(10_000n));
    if (!r.ok) throw new Error('reserve');
    await b.release(r.reservation.id, NOW, 'expired');
    expect(await store.transitionReservation(r.reservation.id, 'RELEASED', 'COMMITTED', NOW.toISOString())).toMatchObject({ status: 'COMMITTED' });
    expect((await store.readBudget(KEY)).used).toBe('10000');
  });

  it('RACE: two concurrent proposals whose sum exceeds the daily cap - one ALLOW, one DAILY_CAP', async () => {
    const store = make();
    const b = new Budget(store);
    const env = envelopeOf({ dailyMax: '100000', perTxMax: '100000', autoApproveMax: '100000' });
    const [x, y] = await Promise.all([decide(transfer(60_000), agent(), env, b, NOW), decide(transfer(60_000), agent(), env, b, NOW)]);
    expect([x.verdict, y.verdict].sort()).toEqual(['ALLOW', 'DENY']);
    expect([x.code, y.code].filter(Boolean)).toEqual(['DAILY_CAP']);
    expect((await store.readBudget(KEY)).used).toBe('60000');
  });
  it('RACE: twenty concurrent proposals for the last of a cap - exactly as many win as fit', async () => {
    const store = make();
    const b = new Budget(store);
    const env = envelopeOf({ dailyMax: '100000', perTxMax: '100000', autoApproveMax: '100000' });
    const out = await Promise.all(Array.from({ length: 20 }, () => decide(transfer(15_000), agent(), env, b, NOW)));
    expect(out.filter((r) => r.verdict === 'ALLOW')).toHaveLength(6);
    expect(out.filter((r) => r.code === 'DAILY_CAP')).toHaveLength(14);
    expect((await store.readBudget(KEY)).used).toBe('90000');
  });
  it('RACE: a release racing a reservation is seen (the version moves, the reservation re-reads)', async () => {
    const store = make();
    const b = new Budget(store);
    const first = await b.reserve(req(100_000n));
    if (!first.ok) throw new Error('reserve');
    const [released, second] = await Promise.all([b.release(first.reservation.id, NOW, 'reverted'), b.reserve(req(100_000n))]);
    expect(released?.status).toBe('RELEASED');
    // Either order is serializable: the reservation saw the release (ok) or ran before it (refused) - never both counted.
    const used = (await store.readBudget(KEY)).used;
    expect(used).toBe(second.ok ? '100000' : '0');
  });
});

function envelopeOf(over: Parameters<typeof envelopeInput>[0]): Envelope {
  const r = parseEnvelopeInput(envelopeInput(over));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { ...r.value, orgId: 'scribbit', agentName: 'settlement', version: 1, setAt: NOW.toISOString(), setBy: { apiKeyId: 'k', approver: 'a' }, supersededAt: null };
}

describe('budget contention', () => {
  it('a CAS that keeps losing gives up with BudgetContentionError instead of spinning', async () => {
    const inner = new MemoryPlaneStore();
    const hostile: BudgetStore = { ...bind(inner), reserve: async () => false };
    await expect(new Budget(hostile, { maxAttempts: 3 }).reserve(req(1n))).rejects.toBeInstanceOf(BudgetContentionError);
  });
  it('utcDay is the UTC calendar day, not the local one', () => {
    expect(utcDay(new Date('2026-09-24T23:59:59.999Z'))).toBe('2026-09-24');
    expect(utcDay(new Date('2026-09-25T00:00:00.000Z'))).toBe('2026-09-25');
  });
});

function bind(s: MemoryPlaneStore): BudgetStore {
  return {
    readBudget: (k) => s.readBudget(k),
    reserve: (k, v, r) => s.reserve(k, v, r),
    getReservation: (id) => s.getReservation(id),
    transitionReservation: (id, f, t, at, reason) => s.transitionReservation(id, f, t, at, reason),
    setReservationExpiry: (id, e) => s.setReservationExpiry(id, e),
    expiredReservations: (n, l) => s.expiredReservations(n, l),
  };
}
