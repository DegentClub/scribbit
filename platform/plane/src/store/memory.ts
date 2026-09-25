// In-memory PlaneStore. Every method body is synchronous between its read and its write,
// so each compare-and-set is atomic with respect to other async callers; `await` points
// sit only at the method boundary - exactly where a SQL round trip would. Values are
// cloned in and out so callers cannot mutate stored state.
import type { AuditEntry } from '../audit.ts';
import type { Envelope } from '../envelope.ts';
import type { AuthorizationRow, AuthorizationStatus, BudgetRow, DecisionRow, DecisionStatus, IdempotencyRow, PlaneStore, Reservation, ReservationStatus } from './types.ts';

const clone = <T>(v: T): T => structuredClone(v);
const envKey = (org: string, agent: string, chain: string): string => `${org}|${agent}|${chain}`;

export class MemoryPlaneStore implements PlaneStore {
  private readonly envelopes = new Map<string, Envelope[]>();
  private readonly budgets = new Map<string, BudgetRow>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly decisions = new Map<string, DecisionRow>();
  private readonly authorizations = new Map<string, AuthorizationRow>();
  private readonly idempotency = new Map<string, IdempotencyRow>();
  private readonly destinations = new Set<string>();
  private readonly audit = new Map<string, AuditEntry[]>();
  private readonly nonces = new Map<string, string>();

  // ── envelopes ─────────────────────────────────────────────────────────────
  async putEnvelope(e: Omit<Envelope, 'version' | 'supersededAt'>): Promise<Envelope> {
    const k = envKey(e.orgId, e.agentName, e.chain);
    const history = this.envelopes.get(k) ?? [];
    const prev = history.at(-1);
    if (prev) prev.supersededAt = e.setAt;
    const next: Envelope = { ...clone(e), version: (prev?.version ?? 0) + 1, supersededAt: null };
    history.push(next);
    this.envelopes.set(k, history);
    return clone(next);
  }
  async getEnvelope(orgId: string, agentName: string, chain: string): Promise<Envelope | undefined> {
    const cur = this.envelopes.get(envKey(orgId, agentName, chain))?.at(-1);
    return cur ? clone(cur) : undefined;
  }
  async listEnvelopes(orgId: string, agentName: string): Promise<Envelope[]> {
    const out: Envelope[] = [];
    for (const [k, h] of this.envelopes) if (k.startsWith(`${orgId}|${agentName}|`) && h.length) out.push(clone(h.at(-1)!));
    return out.sort((a, b) => (a.chain < b.chain ? -1 : 1));
  }
  async envelopeHistory(orgId: string, agentName: string, chain: string): Promise<Envelope[]> {
    return clone(this.envelopes.get(envKey(orgId, agentName, chain)) ?? []);
  }

  // ── budget ────────────────────────────────────────────────────────────────
  async readBudget(key: string): Promise<BudgetRow> {
    return clone(this.budgets.get(key) ?? { used: '0', version: 0 });
  }
  async reserve(key: string, expectedVersion: number, r: Reservation): Promise<boolean> {
    const row = this.budgets.get(key) ?? { used: '0', version: 0 };
    if (row.version !== expectedVersion) return false;
    if (this.reservations.has(r.id)) throw new Error(`reservation ${r.id} exists`);
    this.budgets.set(key, { used: (BigInt(row.used) + BigInt(r.amount)).toString(), version: row.version + 1 });
    this.reservations.set(r.id, clone(r));
    return true;
  }
  async getReservation(id: string): Promise<Reservation | undefined> {
    const r = this.reservations.get(id);
    return r ? clone(r) : undefined;
  }
  async transitionReservation(id: string, from: ReservationStatus, to: ReservationStatus, at: string, reason?: string): Promise<Reservation | undefined> {
    const r = this.reservations.get(id);
    if (!r || r.status !== from) return undefined;
    const delta = from !== 'RELEASED' && to === 'RELEASED' ? -BigInt(r.amount) : from === 'RELEASED' && to !== 'RELEASED' ? BigInt(r.amount) : 0n;
    if (delta !== 0n) {
      const row = this.budgets.get(r.key) ?? { used: '0', version: 0 };
      this.budgets.set(r.key, { used: (BigInt(row.used) + delta).toString(), version: row.version + 1 });
    }
    const next: Reservation = { ...r, status: to, settledAt: at, ...(reason !== undefined ? { reason } : {}) };
    this.reservations.set(id, next);
    return clone(next);
  }
  async setReservationExpiry(id: string, expiresAt: string): Promise<void> {
    const r = this.reservations.get(id);
    if (r) r.expiresAt = expiresAt;
  }
  async expiredReservations(now: string, limit = 1000): Promise<Reservation[]> {
    const out: Reservation[] = [];
    for (const r of this.reservations.values()) {
      if (r.status === 'RESERVED' && r.expiresAt <= now) out.push(clone(r));
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── decisions ─────────────────────────────────────────────────────────────
  async putDecision(d: DecisionRow): Promise<void> {
    if (this.decisions.has(d.id)) throw new Error(`decision ${d.id} exists`);
    this.decisions.set(d.id, clone(d));
  }
  async getDecision(id: string): Promise<DecisionRow | undefined> {
    const d = this.decisions.get(id);
    return d ? clone(d) : undefined;
  }
  async updateDecision(id: string, from: DecisionStatus, patch: Partial<DecisionRow>): Promise<DecisionRow | undefined> {
    const d = this.decisions.get(id);
    if (!d || d.status !== from) return undefined;
    const next = { ...d, ...clone(patch), id: d.id };
    this.decisions.set(id, next);
    return clone(next);
  }
  async expiredDecisions(now: string, limit = 1000): Promise<DecisionRow[]> {
    const out: DecisionRow[] = [];
    for (const d of this.decisions.values()) {
      if (d.status === 'PENDING' && d.expiresAt !== undefined && d.expiresAt <= now) out.push(clone(d));
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── authorizations ────────────────────────────────────────────────────────
  async putAuthorization(a: AuthorizationRow): Promise<void> {
    if (this.authorizations.has(a.authorization.id)) throw new Error(`authorization ${a.authorization.id} exists`);
    this.authorizations.set(a.authorization.id, clone(a));
  }
  async getAuthorization(id: string): Promise<AuthorizationRow | undefined> {
    const a = this.authorizations.get(id);
    return a ? clone(a) : undefined;
  }
  async transitionAuthorization(id: string, from: AuthorizationStatus, to: AuthorizationStatus, patch: Partial<Omit<AuthorizationRow, 'authorization' | 'status'>> = {}): Promise<AuthorizationRow | undefined> {
    const a = this.authorizations.get(id);
    if (!a || a.status !== from) return undefined;
    const next: AuthorizationRow = { ...a, ...clone(patch), status: to };
    this.authorizations.set(id, next);
    return clone(next);
  }
  async expiredAuthorizations(now: string, limit = 1000): Promise<AuthorizationRow[]> {
    const out: AuthorizationRow[] = [];
    for (const a of this.authorizations.values()) {
      if (a.status === 'ISSUED' && a.authorization.expiresAt <= now) out.push(clone(a));
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── idempotency ───────────────────────────────────────────────────────────
  async getIdempotency(scope: string, key: string): Promise<IdempotencyRow | undefined> {
    const r = this.idempotency.get(`${scope}\n${key}`);
    return r ? clone(r) : undefined;
  }
  async putIdempotency(scope: string, key: string, row: IdempotencyRow, now: string): Promise<boolean> {
    const k = `${scope}\n${key}`;
    const cur = this.idempotency.get(k);
    if (cur && cur.expiresAt > now) return false;
    this.idempotency.set(k, clone(row));
    return true;
  }

  // ── grading memory ────────────────────────────────────────────────────────
  async hasDestination(orgId: string, chain: string, destination: string): Promise<boolean> {
    return this.destinations.has(`${orgId}|${chain}|${destination}`);
  }
  async markDestination(orgId: string, chain: string, destination: string): Promise<void> {
    this.destinations.add(`${orgId}|${chain}|${destination}`);
  }

  // ── audit ─────────────────────────────────────────────────────────────────
  async appendAudit(orgId: string, build: (head: { seq: number; hash: string } | undefined) => AuditEntry): Promise<AuditEntry> {
    const log = this.audit.get(orgId) ?? [];
    const head = log.at(-1);
    const entry = build(head ? { seq: head.seq, hash: head.hash } : undefined);
    if (entry.seq !== (head ? head.seq + 1 : 0) || entry.prev !== (head ? head.hash : '0'.repeat(64))) throw new Error('audit entry does not extend the head');
    log.push(clone(entry));
    this.audit.set(orgId, log);
    return clone(entry);
  }
  async listAudit(orgId: string, since: number, limit: number): Promise<AuditEntry[]> {
    return clone((this.audit.get(orgId) ?? []).filter((e) => e.seq > since).slice(0, limit));
  }
  async auditHead(orgId: string): Promise<AuditEntry | undefined> {
    const h = this.audit.get(orgId)?.at(-1);
    return h ? clone(h) : undefined;
  }

  // ── nonces ────────────────────────────────────────────────────────────────
  async consume(id: string, expiresAt: string): Promise<boolean> {
    if (this.nonces.has(id)) return false;
    this.nonces.set(id, expiresAt);
    return true;
  }

  /** Test hook: tamper with a stored audit entry (the log itself never offers this). */
  _tamperAudit(orgId: string, seq: number, mutate: (e: AuditEntry) => void): void {
    const e = this.audit.get(orgId)?.find((x) => x.seq === seq);
    if (e) mutate(e);
  }
}
