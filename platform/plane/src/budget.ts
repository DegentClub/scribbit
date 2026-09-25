// Check 4 - the two-phase budget. FlashyOS docs/wallet/spec.md §7: an amount is RESERVED
// when authorized or escalated, COMMITTED on chain confirmation, RELEASED on revert, on an
// authorization that expired unspent and on a rejected decision. "Today" is the UTC day of
// the reservation. "The budget check and the reservation insert run in one SERIALIZABLE
// transaction, retried on serialization failure; two proposals racing for the last of a
// daily cap cannot both win."
//
// Here the equivalent is optimistic: read the day's row (used, version), decide, then
// `store.reserve(key, version, …)` - a compare-and-set that fails if anyone reserved or
// released on that row since the read. A failed CAS re-reads and decides again.
import { randomUUID } from 'node:crypto';
import type { BudgetStore, Reservation } from './store/types.ts';

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
export const budgetKey = (orgId: string, agentName: string, chain: string, day: string): string => `${orgId}|${agentName}|${chain}|${day}`;

export class BudgetContentionError extends Error {
  constructor(key: string, attempts: number) {
    super(`budget ${key}: no consistent reservation after ${attempts} attempts`);
    this.name = 'BudgetContentionError';
  }
}

export interface ReserveRequest {
  orgId: string;
  agentName: string;
  chain: string;
  amount: bigint;
  /** The envelope's dailyMax. */
  cap: bigint;
  now: Date;
  /** How long the reservation holds if nothing settles or resolves it. */
  ttlMs: number;
}

export type ReserveResult = { ok: true; reservation: Reservation; usedBefore: bigint } | { ok: false; used: bigint; cap: bigint };

export interface BudgetOptions {
  ids?: () => string;
  /** CAS attempts before giving up (a pathological write storm on one row). Default 32. */
  maxAttempts?: number;
}

export class Budget {
  readonly store: BudgetStore;
  private readonly ids: () => string;
  private readonly maxAttempts: number;

  constructor(store: BudgetStore, options: BudgetOptions = {}) {
    this.store = store;
    this.ids = options.ids ?? (() => `rsv_${randomUUID()}`);
    this.maxAttempts = options.maxAttempts ?? 32;
  }

  /** Reserve `amount` against today's cap, or say how much is already used. */
  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const day = utcDay(req.now);
    const key = budgetKey(req.orgId, req.agentName, req.chain, day);
    const id = this.ids();
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const row = await this.store.readBudget(key);
      const used = BigInt(row.used);
      if (used + req.amount > req.cap) return { ok: false, used, cap: req.cap };
      const reservation: Reservation = {
        id,
        key,
        orgId: req.orgId,
        agentName: req.agentName,
        chain: req.chain,
        day,
        amount: req.amount.toString(),
        status: 'RESERVED',
        createdAt: req.now.toISOString(),
        expiresAt: new Date(req.now.getTime() + req.ttlMs).toISOString(),
      };
      if (await this.store.reserve(key, row.version, reservation)) return { ok: true, reservation, usedBefore: used };
    }
    throw new BudgetContentionError(key, this.maxAttempts);
  }

  /** RESERVED → COMMITTED: the chain confirmed; it keeps counting. */
  commit(id: string, at: Date): Promise<Reservation | undefined> {
    return this.store.transitionReservation(id, 'RESERVED', 'COMMITTED', at.toISOString());
  }

  /** RESERVED → RELEASED: reverted, expired, rejected or refused by grading; it stops counting. */
  release(id: string, at: Date, reason: string): Promise<Reservation | undefined> {
    return this.store.transitionReservation(id, 'RESERVED', 'RELEASED', at.toISOString(), reason);
  }

  /** Hold longer (an escalated proposal waits for a person). */
  extend(id: string, expiresAt: Date): Promise<void> {
    return this.store.setReservationExpiry(id, expiresAt.toISOString());
  }

  /** Release every RESERVED reservation past its expiry. Returns what was released. */
  async sweep(now: Date): Promise<Reservation[]> {
    const out: Reservation[] = [];
    for (const r of await this.store.expiredReservations(now.toISOString())) {
      const released = await this.release(r.id, now, 'expired');
      if (released) out.push(released);
    }
    return out;
  }
}
