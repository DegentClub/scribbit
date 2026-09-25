// node:sqlite PlaneStore (single writer, WAL). Same semantics as MemoryPlaneStore: every
// compare-and-set is one `BEGIN IMMEDIATE` transaction, so a version or status checked
// inside it cannot change before the write. node:sqlite is synchronous, so the
// transaction also never interleaves with another call in this process.
import { DatabaseSync } from 'node:sqlite';
import { GENESIS, type AuditEntry } from '../audit.ts';
import type { Envelope } from '../envelope.ts';
import type { AuthorizationRow, AuthorizationStatus, BudgetRow, DecisionRow, DecisionStatus, IdempotencyRow, PlaneStore, Reservation, ReservationStatus } from './types.ts';

type Row = Record<string, unknown>;

export const PLANE_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: '0001_plane',
    sql: `
      CREATE TABLE envelopes (org TEXT NOT NULL, agent TEXT NOT NULL, chain TEXT NOT NULL, version INTEGER NOT NULL, superseded_at TEXT, json TEXT NOT NULL,
        PRIMARY KEY (org, agent, chain, version));
      CREATE TABLE budgets (key TEXT PRIMARY KEY, used TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE reservations (id TEXT PRIMARY KEY, key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('RESERVED','COMMITTED','RELEASED')),
        amount TEXT NOT NULL, expires_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX reservations_open ON reservations (status, expires_at);
      CREATE TABLE decisions (id TEXT PRIMARY KEY, org TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT, json TEXT NOT NULL);
      CREATE INDEX decisions_open ON decisions (status, expires_at);
      CREATE TABLE authorizations (id TEXT PRIMARY KEY, org TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('ISSUED','SPENT','EXPIRED','REVOKED')),
        expires_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX authorizations_open ON authorizations (status, expires_at);
      CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, decision_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        PRIMARY KEY (scope, key));
      CREATE TABLE destinations (org TEXT NOT NULL, chain TEXT NOT NULL, destination TEXT NOT NULL, first_at TEXT NOT NULL, PRIMARY KEY (org, chain, destination));
      CREATE TABLE audit (org TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (org, seq));
      CREATE TABLE nonces (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    `,
  },
];

export class SqlitePlaneStore implements PlaneStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((this.db.prepare('SELECT id FROM schema_migrations').all() as Row[]).map((r) => r.id as string));
    for (const m of PLANE_MIGRATIONS) {
      if (applied.has(m.id)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
      });
    }
  }

  appliedMigrations(): string[] {
    return (this.db.prepare('SELECT id FROM schema_migrations ORDER BY rowid').all() as Row[]).map((r) => r.id as string);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private one(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: Array<string | number | null>): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }
  private json<T>(row: Row | undefined): T | undefined {
    return row ? (JSON.parse(row.json as string) as T) : undefined;
  }

  // ── envelopes ─────────────────────────────────────────────────────────────
  async putEnvelope(e: Omit<Envelope, 'version' | 'supersededAt'>): Promise<Envelope> {
    return this.tx(() => {
      const prev = this.json<Envelope>(this.one('SELECT json FROM envelopes WHERE org = ? AND agent = ? AND chain = ? ORDER BY version DESC LIMIT 1', e.orgId, e.agentName, e.chain));
      if (prev) {
        const superseded: Envelope = { ...prev, supersededAt: e.setAt };
        this.run('UPDATE envelopes SET superseded_at = ?, json = ? WHERE org = ? AND agent = ? AND chain = ? AND version = ?', e.setAt, JSON.stringify(superseded), e.orgId, e.agentName, e.chain, prev.version);
      }
      const next: Envelope = { ...e, version: (prev?.version ?? 0) + 1, supersededAt: null };
      this.run('INSERT INTO envelopes (org, agent, chain, version, superseded_at, json) VALUES (?, ?, ?, ?, NULL, ?)', e.orgId, e.agentName, e.chain, next.version, JSON.stringify(next));
      return next;
    });
  }
  async getEnvelope(orgId: string, agentName: string, chain: string): Promise<Envelope | undefined> {
    return this.json<Envelope>(this.one('SELECT json FROM envelopes WHERE org = ? AND agent = ? AND chain = ? ORDER BY version DESC LIMIT 1', orgId, agentName, chain));
  }
  async listEnvelopes(orgId: string, agentName: string): Promise<Envelope[]> {
    return this.all('SELECT json FROM envelopes WHERE org = ? AND agent = ? AND superseded_at IS NULL ORDER BY chain', orgId, agentName).map((r) => JSON.parse(r.json as string) as Envelope);
  }
  async envelopeHistory(orgId: string, agentName: string, chain: string): Promise<Envelope[]> {
    return this.all('SELECT json FROM envelopes WHERE org = ? AND agent = ? AND chain = ? ORDER BY version', orgId, agentName, chain).map((r) => JSON.parse(r.json as string) as Envelope);
  }

  // ── budget ────────────────────────────────────────────────────────────────
  async readBudget(key: string): Promise<BudgetRow> {
    const r = this.one('SELECT used, version FROM budgets WHERE key = ?', key);
    return r ? { used: r.used as string, version: Number(r.version) } : { used: '0', version: 0 };
  }
  async reserve(key: string, expectedVersion: number, r: Reservation): Promise<boolean> {
    return this.tx(() => {
      const row = this.one('SELECT used, version FROM budgets WHERE key = ?', key);
      const version = row ? Number(row.version) : 0;
      if (version !== expectedVersion) return false;
      const used = (BigInt(row ? (row.used as string) : '0') + BigInt(r.amount)).toString();
      if (row) this.run('UPDATE budgets SET used = ?, version = ? WHERE key = ?', used, version + 1, key);
      else this.run('INSERT INTO budgets (key, used, version) VALUES (?, ?, 1)', key, used);
      this.run('INSERT INTO reservations (id, key, status, amount, expires_at, json) VALUES (?, ?, ?, ?, ?, ?)', r.id, key, r.status, r.amount, r.expiresAt, JSON.stringify(r));
      return true;
    });
  }
  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.json<Reservation>(this.one('SELECT json FROM reservations WHERE id = ?', id));
  }
  async transitionReservation(id: string, from: ReservationStatus, to: ReservationStatus, at: string, reason?: string): Promise<Reservation | undefined> {
    return this.tx(() => {
      const r = this.json<Reservation>(this.one('SELECT json FROM reservations WHERE id = ? AND status = ?', id, from));
      if (!r) return undefined;
      const delta = from !== 'RELEASED' && to === 'RELEASED' ? -BigInt(r.amount) : from === 'RELEASED' && to !== 'RELEASED' ? BigInt(r.amount) : 0n;
      if (delta !== 0n) {
        const row = this.one('SELECT used, version FROM budgets WHERE key = ?', r.key);
        const used = (BigInt(row ? (row.used as string) : '0') + delta).toString();
        this.run('UPDATE budgets SET used = ?, version = version + 1 WHERE key = ?', used, r.key);
      }
      const next: Reservation = { ...r, status: to, settledAt: at, ...(reason !== undefined ? { reason } : {}) };
      this.run('UPDATE reservations SET status = ?, json = ? WHERE id = ?', to, JSON.stringify(next), id);
      return next;
    });
  }
  async setReservationExpiry(id: string, expiresAt: string): Promise<void> {
    this.tx(() => {
      const r = this.json<Reservation>(this.one('SELECT json FROM reservations WHERE id = ?', id));
      if (r) this.run('UPDATE reservations SET expires_at = ?, json = ? WHERE id = ?', expiresAt, JSON.stringify({ ...r, expiresAt }), id);
    });
  }
  async expiredReservations(now: string, limit = 1000): Promise<Reservation[]> {
    return this.all("SELECT json FROM reservations WHERE status = 'RESERVED' AND expires_at <= ? ORDER BY expires_at LIMIT ?", now, limit).map((r) => JSON.parse(r.json as string) as Reservation);
  }

  // ── decisions ─────────────────────────────────────────────────────────────
  async putDecision(d: DecisionRow): Promise<void> {
    this.run('INSERT INTO decisions (id, org, status, expires_at, json) VALUES (?, ?, ?, ?, ?)', d.id, d.orgId, d.status, d.expiresAt ?? null, JSON.stringify(d));
  }
  async getDecision(id: string): Promise<DecisionRow | undefined> {
    return this.json<DecisionRow>(this.one('SELECT json FROM decisions WHERE id = ?', id));
  }
  async updateDecision(id: string, from: DecisionStatus, patch: Partial<DecisionRow>): Promise<DecisionRow | undefined> {
    return this.tx(() => {
      const d = this.json<DecisionRow>(this.one('SELECT json FROM decisions WHERE id = ? AND status = ?', id, from));
      if (!d) return undefined;
      const next: DecisionRow = { ...d, ...patch, id: d.id };
      this.run('UPDATE decisions SET status = ?, expires_at = ?, json = ? WHERE id = ?', next.status, next.expiresAt ?? null, JSON.stringify(next), id);
      return next;
    });
  }
  async expiredDecisions(now: string, limit = 1000): Promise<DecisionRow[]> {
    return this.all("SELECT json FROM decisions WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?", now, limit).map((r) => JSON.parse(r.json as string) as DecisionRow);
  }

  // ── authorizations ────────────────────────────────────────────────────────
  async putAuthorization(a: AuthorizationRow): Promise<void> {
    this.run('INSERT INTO authorizations (id, org, status, expires_at, json) VALUES (?, ?, ?, ?, ?)', a.authorization.id, a.authorization.orgId, a.status, a.authorization.expiresAt, JSON.stringify(a));
  }
  async getAuthorization(id: string): Promise<AuthorizationRow | undefined> {
    return this.json<AuthorizationRow>(this.one('SELECT json FROM authorizations WHERE id = ?', id));
  }
  async transitionAuthorization(id: string, from: AuthorizationStatus, to: AuthorizationStatus, patch: Partial<Omit<AuthorizationRow, 'authorization' | 'status'>> = {}): Promise<AuthorizationRow | undefined> {
    return this.tx(() => {
      const a = this.json<AuthorizationRow>(this.one('SELECT json FROM authorizations WHERE id = ? AND status = ?', id, from));
      if (!a) return undefined;
      const next: AuthorizationRow = { ...a, ...patch, status: to };
      this.run('UPDATE authorizations SET status = ?, json = ? WHERE id = ?', to, JSON.stringify(next), id);
      return next;
    });
  }
  async expiredAuthorizations(now: string, limit = 1000): Promise<AuthorizationRow[]> {
    return this.all("SELECT json FROM authorizations WHERE status = 'ISSUED' AND expires_at <= ? ORDER BY expires_at LIMIT ?", now, limit).map((r) => JSON.parse(r.json as string) as AuthorizationRow);
  }

  // ── idempotency ───────────────────────────────────────────────────────────
  async getIdempotency(scope: string, key: string): Promise<IdempotencyRow | undefined> {
    const r = this.one('SELECT fingerprint, decision_id, expires_at FROM idempotency WHERE scope = ? AND key = ?', scope, key);
    return r ? { fingerprint: r.fingerprint as string, decisionId: r.decision_id as string, expiresAt: r.expires_at as string } : undefined;
  }
  async putIdempotency(scope: string, key: string, row: IdempotencyRow, now: string): Promise<boolean> {
    return this.tx(() => {
      const cur = this.one('SELECT expires_at FROM idempotency WHERE scope = ? AND key = ?', scope, key);
      if (cur && (cur.expires_at as string) > now) return false;
      this.run('INSERT OR REPLACE INTO idempotency (scope, key, fingerprint, decision_id, expires_at) VALUES (?, ?, ?, ?, ?)', scope, key, row.fingerprint, row.decisionId, row.expiresAt);
      return true;
    });
  }

  // ── grading memory ────────────────────────────────────────────────────────
  async hasDestination(orgId: string, chain: string, destination: string): Promise<boolean> {
    return this.one('SELECT 1 AS x FROM destinations WHERE org = ? AND chain = ? AND destination = ?', orgId, chain, destination) !== undefined;
  }
  async markDestination(orgId: string, chain: string, destination: string, at: string): Promise<void> {
    this.run('INSERT OR IGNORE INTO destinations (org, chain, destination, first_at) VALUES (?, ?, ?, ?)', orgId, chain, destination, at);
  }

  // ── audit ─────────────────────────────────────────────────────────────────
  async appendAudit(orgId: string, build: (head: { seq: number; hash: string } | undefined) => AuditEntry): Promise<AuditEntry> {
    return this.tx(() => {
      const h = this.one('SELECT seq, hash FROM audit WHERE org = ? ORDER BY seq DESC LIMIT 1', orgId);
      const head = h ? { seq: Number(h.seq), hash: h.hash as string } : undefined;
      const entry = build(head);
      if (entry.seq !== (head ? head.seq + 1 : 0) || entry.prev !== (head ? head.hash : GENESIS)) throw new Error('audit entry does not extend the head');
      this.run('INSERT INTO audit (org, seq, hash, json) VALUES (?, ?, ?, ?)', orgId, entry.seq, entry.hash, JSON.stringify(entry));
      return entry;
    });
  }
  async listAudit(orgId: string, since: number, limit: number): Promise<AuditEntry[]> {
    return this.all('SELECT json FROM audit WHERE org = ? AND seq > ? ORDER BY seq LIMIT ?', orgId, since, limit).map((r) => JSON.parse(r.json as string) as AuditEntry);
  }
  async auditHead(orgId: string): Promise<AuditEntry | undefined> {
    return this.json<AuditEntry>(this.one('SELECT json FROM audit WHERE org = ? ORDER BY seq DESC LIMIT 1', orgId));
  }

  // ── nonces ────────────────────────────────────────────────────────────────
  async consume(id: string, expiresAt: string): Promise<boolean> {
    return this.run('INSERT OR IGNORE INTO nonces (id, expires_at) VALUES (?, ?)', id, expiresAt) === 1;
  }
}
