// The plane's storage port. Two adapters with one semantics: MemoryPlaneStore and
// SqlitePlaneStore (node:sqlite). Every method that decides between two writers is a
// compare-and-set - on a version (the budget) or on a status (reservations, decisions,
// authorizations) - and runs atomically inside the adapter (synchronously in memory, in one
// BEGIN IMMEDIATE transaction in SQLite). That is what gives `Budget.reserve` its
// SERIALIZABLE-equivalent behaviour: read, decide, then write only if nobody wrote since.
import type { AuditEntry } from '../audit.ts';
import type { SpendAuthorization } from '../authorization.ts';
import type { Envelope, Impact } from '../envelope.ts';
import type { DenialCode, OperationRecord } from '../record.ts';

export type ReservationStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED';

export interface Reservation {
  id: string;
  /** `${orgId}|${agentName}|${chain}|${day}` - the budget row it counts against. */
  key: string;
  orgId: string;
  agentName: string;
  chain: string;
  /** UTC day (YYYY-MM-DD) of createdAt. */
  day: string;
  amount: string;
  status: ReservationStatus;
  createdAt: string;
  /** A RESERVED reservation past this is released by the sweep. */
  expiresAt: string;
  settledAt?: string;
  reason?: string;
}

export type DecisionStatus = 'AUTO_APPROVED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'DENIED' | 'EXPIRED';
export type VerdictName = 'ALLOW' | 'ESCALATE' | 'DENY';

export interface DecisionRow {
  id: string;
  orgId: string;
  agentName: string;
  status: DecisionStatus;
  verdict: VerdictName;
  code?: DenialCode;
  impact: Impact;
  reasons: string[];
  /** The record as parsed (raw dropped; its digest in `rawSha256`), or what was sent when it did not parse. */
  record: Partial<OperationRecord> | Record<string, unknown>;
  rawSha256?: string;
  reservationId?: string;
  authorizationId?: string;
  envelopeVersion?: number;
  createdAt: string;
  /** PENDING decisions expire (and release their reservation) at this time. */
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export type AuthorizationStatus = 'ISSUED' | 'SPENT' | 'EXPIRED' | 'REVOKED';

export interface AuthorizationRow {
  /** The signed document, exactly as issued. */
  authorization: SpendAuthorization;
  status: AuthorizationStatus;
  spentAt: string | null;
  txHash: string | null;
  outcome?: 'CONFIRMED' | 'REVERTED';
  anomaly?: string | null;
}

export interface IdempotencyRow {
  fingerprint: string;
  decisionId: string;
  expiresAt: string;
}

export interface BudgetRow {
  /** Reserved + committed today, base units, decimal string. */
  used: string;
  version: number;
}

export interface BudgetStore {
  readBudget(key: string): Promise<BudgetRow>;
  /** Atomically: if the row's version is `expectedVersion`, add `r.amount`, bump the version and insert `r`. False otherwise. */
  reserve(key: string, expectedVersion: number, r: Reservation): Promise<boolean>;
  getReservation(id: string): Promise<Reservation | undefined>;
  /** Atomically move `id` from `from` to `to`; RESERVED/COMMITTED → RELEASED subtracts its amount from the row, RELEASED → COMMITTED adds it back (a confirmation that arrived after the release: the money was spent); either bumps the version. Undefined when it was not in `from`. */
  transitionReservation(id: string, from: ReservationStatus, to: ReservationStatus, at: string, reason?: string): Promise<Reservation | undefined>;
  setReservationExpiry(id: string, expiresAt: string): Promise<void>;
  /** RESERVED reservations whose expiresAt <= now. */
  expiredReservations(now: string, limit?: number): Promise<Reservation[]>;
}

export interface NonceStore {
  /** Marks `id` used; false when it already was. `expiresAt` lets an adapter forget it afterwards. */
  consume(id: string, expiresAt: string): Promise<boolean>;
}

export interface PlaneStore extends BudgetStore, NonceStore {
  /** Stores the next version of (org, agent, chain): version = previous + 1, previous gets supersededAt = setAt. Returns what was stored. */
  putEnvelope(e: Omit<Envelope, 'version' | 'supersededAt'>): Promise<Envelope>;
  getEnvelope(orgId: string, agentName: string, chain: string): Promise<Envelope | undefined>;
  listEnvelopes(orgId: string, agentName: string): Promise<Envelope[]>;
  envelopeHistory(orgId: string, agentName: string, chain: string): Promise<Envelope[]>;

  putDecision(d: DecisionRow): Promise<void>;
  getDecision(id: string): Promise<DecisionRow | undefined>;
  /** Compare-and-set on status. Undefined when the decision was not in `from`. */
  updateDecision(id: string, from: DecisionStatus, patch: Partial<DecisionRow>): Promise<DecisionRow | undefined>;
  expiredDecisions(now: string, limit?: number): Promise<DecisionRow[]>;

  putAuthorization(a: AuthorizationRow): Promise<void>;
  getAuthorization(id: string): Promise<AuthorizationRow | undefined>;
  /** Compare-and-set on status. */
  transitionAuthorization(id: string, from: AuthorizationStatus, to: AuthorizationStatus, patch?: Partial<Omit<AuthorizationRow, 'authorization' | 'status'>>): Promise<AuthorizationRow | undefined>;
  /** ISSUED authorizations whose expiresAt <= now. */
  expiredAuthorizations(now: string, limit?: number): Promise<AuthorizationRow[]>;

  getIdempotency(scope: string, key: string): Promise<IdempotencyRow | undefined>;
  /** Insert; false when (scope, key) exists and has not expired at `now`. An expired row is replaced. */
  putIdempotency(scope: string, key: string, row: IdempotencyRow, now: string): Promise<boolean>;

  hasDestination(orgId: string, chain: string, destination: string): Promise<boolean>;
  markDestination(orgId: string, chain: string, destination: string, at: string): Promise<void>;

  /** Atomically append the entry `build` makes from the current head (undefined for the first). */
  appendAudit(orgId: string, build: (head: { seq: number; hash: string } | undefined) => AuditEntry): Promise<AuditEntry>;
  /** Entries with seq > since, oldest first. */
  listAudit(orgId: string, since: number, limit: number): Promise<AuditEntry[]>;
  auditHead(orgId: string): Promise<AuditEntry | undefined>;
}
