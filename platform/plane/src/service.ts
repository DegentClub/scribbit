// PlaneService: the plane's behaviour behind the HTTP surface. It runs `decide`, records
// every verdict (a decision row + an audit entry, refusals too), signs the authorization on
// ALLOW, settles or releases reservations, resolves escalations, sweeps what expired, and
// publishes the plane document. Everything durable goes through the PlaneStore port.
import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { asPrivateKey, digestOf, planeDocument, publicKeyOf, type PlaneDocument } from '@bsh/mesh';
import { chainEntry, signAuditHead, type AuditEntry, type AuditFact, type AuditHead } from './audit.ts';
import { signAuthorization, SPEND_AUTHORIZATION_SCHEMA_ID, type SpendAuthorization } from './authorization.ts';
import { Budget } from './budget.ts';
import { AUTHORIZATION_TTL_MS, decide, DECISION_TTL_MS, type AgentIdentity, type DecideResult } from './decide.ts';
import { parseEnvelopeInput, type Envelope, type EnvelopeSetter, type Impact } from './envelope.ts';
import { defaultGrader, type Grader } from './grading.ts';
import type { LedgerObservation, LedgerPort } from './ledger.ts';
import { recordForAudit, type DenialCode, type OperationRecord } from './record.ts';
import type { AuthorizationRow, DecisionRow, PlaneStore, ReservationStatus } from './store/types.ts';

/** The chains this plane authorizes by default (bech32 networks @bsh/mesh checks). */
export const PLANE_CHAINS = ['btc:mainnet', 'btc:signet', 'btc:testnet'] as const;
/** FlashyOS schema $ids this plane enforces (it accepts what they accept; its authorizations validate under theirs). */
export const PLANE_SCHEMAS = [
  'https://flashyos.com/schema/wallet/operation-record.json',
  'https://flashyos.com/schema/wallet/spend-envelope-input.json',
  SPEND_AUTHORIZATION_SCHEMA_ID,
] as const;
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/** Default first-time-destination threshold (sats): a first payment above it goes to a person. */
export const DEFAULT_FIRST_TIME_ESCALATE_ABOVE = 100_000n;

export class PlaneError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 503;
  readonly code: string;
  readonly details: unknown;
  constructor(status: PlaneError['status'], code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PlaneError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type VerdictBody =
  | { verdict: 'ALLOW'; authorization: SpendAuthorization; decisionId: string; impact: Impact; reasons: string[]; replayed?: true }
  | { verdict: 'ESCALATE'; decisionId: string; reservationId: string; impact: Impact; reasons: string[]; replayed?: true }
  | { verdict: 'DENY'; code: DenialCode; reason: string; reasons: string[]; decisionId: string; replayed?: true };

export const verdictStatus = (v: VerdictBody): 200 | 201 | 202 => (v.verdict === 'ALLOW' ? 201 : v.verdict === 'ESCALATE' ? 202 : 200);

export interface AuthorizationView {
  id: string;
  orgId: string;
  agentName: string;
  chain: string;
  kind: string;
  asset: string;
  maxAmount: string;
  destination: string | null;
  status: AuthorizationRow['status'];
  decisionId: string;
  reservationId: string;
  issuedAt: string;
  expiresAt: string;
  spentAt: string | null;
  txHash: string | null;
}

export interface SettleRequest {
  authorizationId: string;
  outcome: 'CONFIRMED' | 'REVERTED';
  txHash: string;
  ledger?: LedgerObservation;
}

export interface SettleResponse {
  authorization: AuthorizationView;
  reservation: { id: string; status: ReservationStatus };
  anomaly: string | null;
  replayed?: true;
  ledger?: { recorded: boolean; applied?: boolean; reason?: string; error?: string };
}

export interface PlaneServiceOptions {
  store: PlaneStore;
  /** The active Ed25519 authorization key, PKCS#8 PEM (or KeyObject). Signs authorizations and audit heads. */
  signingKey: string | KeyObject;
  /** Public halves of retired keys (SPKI PEM): listed in the plane document so what they signed keeps verifying. */
  retiredPublicKeys?: readonly string[];
  name?: string;
  url?: string | null;
  chains?: readonly string[];
  /** Replaces the default grader entirely. */
  grader?: Grader;
  denylist?: readonly string[];
  /** Null disables the first-time rule. Default 100 000 sats. */
  firstTimeEscalateAbove?: bigint | null;
  authorizationTtlMs?: number;
  decisionTtlMs?: number;
  idempotencyTtlMs?: number;
  ledger?: LedgerPort;
  now?: () => Date;
  ids?: (prefix: 'dec' | 'auth' | 'rsv') => string;
}

export interface CallerInfo {
  apiKeyId?: string;
}

const view = (row: AuthorizationRow): AuthorizationView => {
  const a = row.authorization;
  return {
    id: a.id,
    orgId: a.orgId,
    agentName: a.agentName,
    chain: a.chain,
    kind: a.kind,
    asset: a.asset,
    maxAmount: a.maxAmount,
    destination: a.destination,
    status: row.status,
    decisionId: a.decisionId,
    reservationId: a.reservationId,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    spentAt: row.spentAt,
    txHash: row.txHash,
  };
};

const safeDigest = (v: unknown): string | undefined => {
  try {
    return digestOf(v);
  } catch {
    return undefined;
  }
};

export class PlaneService {
  readonly store: PlaneStore;
  readonly budget: Budget;
  readonly chains: readonly string[];
  readonly name: string;
  readonly url: string | null;
  readonly ledger: LedgerPort | undefined;
  private readonly key: KeyObject;
  private readonly publicKey: string;
  private readonly retired: readonly string[];
  private readonly grader: Grader;
  private readonly authorizationTtlMs: number;
  private readonly decisionTtlMs: number;
  private readonly idempotencyTtlMs: number;
  private readonly clock: () => Date;
  private readonly ids: (prefix: 'dec' | 'auth' | 'rsv') => string;

  constructor(options: PlaneServiceOptions) {
    this.store = options.store;
    this.key = asPrivateKey(options.signingKey);
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('the plane signing key must be Ed25519');
    this.publicKey = publicKeyOf(this.key);
    this.retired = [...(options.retiredPublicKeys ?? [])];
    for (const pem of this.retired) if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('retired plane keys must be Ed25519');
    this.name = options.name ?? 'blockspace-plane';
    this.url = options.url ?? null;
    this.chains = [...(options.chains ?? PLANE_CHAINS)];
    this.ids = options.ids ?? ((p) => `${p}_${randomUUID()}`);
    this.budget = new Budget(this.store, { ids: () => this.ids('rsv') });
    const threshold = options.firstTimeEscalateAbove === undefined ? DEFAULT_FIRST_TIME_ESCALATE_ABOVE : options.firstTimeEscalateAbove;
    this.grader =
      options.grader ??
      defaultGrader({
        denylist: options.denylist ?? [],
        ...(threshold !== null ? { firstTimeEscalateAbove: threshold, seen: (org, chain, dest) => this.store.hasDestination(org, chain, dest) } : {}),
      });
    this.authorizationTtlMs = options.authorizationTtlMs ?? AUTHORIZATION_TTL_MS;
    this.decisionTtlMs = options.decisionTtlMs ?? DECISION_TTL_MS;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
    this.ledger = options.ledger;
    this.clock = options.now ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  /** Every key a verifier should trust: the active one first, then the retired ones. */
  trustedKeys(): string[] {
    return [this.publicKey, ...this.retired];
  }

  activePublicKey(): string {
    return this.publicKey;
  }

  planeDocument(): PlaneDocument {
    return planeDocument({
      name: this.name,
      url: this.url,
      keys: [{ publicKey: this.publicKey, status: 'active' }, ...this.retired.map((publicKey) => ({ publicKey, status: 'retired' as const }))],
      chains: [...this.chains],
      schemas: [...PLANE_SCHEMAS],
      generatedAt: this.now().toISOString(),
    });
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  private audit(orgId: string, fact: Omit<AuditFact, 'at'> & { at?: string }): Promise<AuditEntry> {
    const full: AuditFact = { at: fact.at ?? this.now().toISOString(), kind: fact.kind, id: fact.id, data: fact.data };
    return this.store.appendAudit(orgId, (head) => chainEntry(head, full));
  }

  async listAudit(orgId: string, since = -1, limit = 200): Promise<{ org: string; entries: AuditEntry[]; head: AuditHead | null; next?: number }> {
    const entries = await this.store.listAudit(orgId, since, limit);
    const headEntry = await this.store.auditHead(orgId);
    const head = headEntry ? signAuditHead(orgId, headEntry, this.key) : null;
    const last = entries.at(-1);
    return { org: orgId, entries, head, ...(last && headEntry && last.seq < headEntry.seq ? { next: last.seq } : {}) };
  }

  // ── propose ───────────────────────────────────────────────────────────────

  private async issue(decision: Pick<DecisionRow, 'id' | 'orgId' | 'agentName' | 'reservationId'>, record: OperationRecord, now: Date): Promise<SpendAuthorization> {
    const authorization = signAuthorization(
      {
        id: this.ids('auth'),
        orgId: decision.orgId,
        agentName: decision.agentName,
        chain: record.chain,
        kind: record.kind,
        asset: record.asset,
        maxAmount: record.amount,
        destination: record.destination,
        reservationId: decision.reservationId!,
        decisionId: decision.id,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.authorizationTtlMs).toISOString(),
      },
      this.key,
    );
    await this.store.putAuthorization({ authorization, status: 'ISSUED', spentAt: null, txHash: null });
    await this.audit(decision.orgId, {
      kind: 'authorization',
      id: authorization.id,
      at: authorization.issuedAt,
      data: { decisionId: decision.id, agentName: decision.agentName, chain: authorization.chain, kind: authorization.kind, asset: authorization.asset, maxAmount: authorization.maxAmount, destination: authorization.destination, reservationId: authorization.reservationId, expiresAt: authorization.expiresAt, sig: authorization.sig },
    });
    return authorization;
  }

  private async verdictOf(d: DecisionRow, replayed: boolean): Promise<VerdictBody> {
    const extra = replayed ? { replayed: true as const } : {};
    switch (d.status) {
      case 'AUTO_APPROVED':
      case 'APPROVED': {
        const row = d.authorizationId ? await this.store.getAuthorization(d.authorizationId) : undefined;
        if (!row) throw new Error(`decision ${d.id} has no authorization`);
        return { verdict: 'ALLOW', authorization: row.authorization, decisionId: d.id, impact: d.impact, reasons: d.reasons, ...extra };
      }
      case 'PENDING':
        return { verdict: 'ESCALATE', decisionId: d.id, reservationId: d.reservationId!, impact: d.impact, reasons: d.reasons, ...extra };
      case 'DENIED':
        return { verdict: 'DENY', code: d.code!, reason: d.reasons[0] ?? d.code!, reasons: d.reasons, decisionId: d.id, ...extra };
      case 'REJECTED':
        throw new PlaneError(409, 'DECISION_REJECTED', `decision ${d.id} was rejected by ${d.resolvedBy ?? 'a person'}; propose again under a new Idempotency-Key`, { decisionId: d.id });
      case 'EXPIRED':
        throw new PlaneError(409, 'DECISION_EXPIRED', `decision ${d.id} expired unresolved; propose again under a new Idempotency-Key`, { decisionId: d.id });
    }
  }

  /**
   * Runs the five checks for `agent` against `orgId`'s envelope for the record's chain and
   * records the verdict. With an idempotency key, a replay of the same record returns the
   * decision's current verdict and reserves nothing.
   */
  async propose(orgId: string, agent: AgentIdentity, input: unknown, options: { idempotencyKey?: string; caller?: CallerInfo } = {}): Promise<VerdictBody> {
    const now = this.now();
    await this.sweep(now);
    const decisionId = this.ids('dec');
    const scope = `${orgId}/${agent.agentName}`;
    if (options.idempotencyKey !== undefined) {
      const fingerprint = safeDigest(input) ?? '';
      const claimed = await this.store.putIdempotency(scope, options.idempotencyKey, { fingerprint, decisionId, expiresAt: new Date(now.getTime() + this.idempotencyTtlMs).toISOString() }, now.toISOString());
      if (!claimed) {
        const prior = await this.store.getIdempotency(scope, options.idempotencyKey);
        if (!prior) throw new PlaneError(409, 'proposal_in_flight', 'a proposal under this Idempotency-Key is being decided; retry');
        if (prior.fingerprint !== fingerprint) throw new PlaneError(422, 'idempotency_conflict', 'this Idempotency-Key was used for a different record');
        const d = await this.store.getDecision(prior.decisionId);
        if (!d) throw new PlaneError(409, 'proposal_in_flight', 'a proposal under this Idempotency-Key is being decided; retry');
        return this.verdictOf(d, true);
      }
    }

    const chain = input && typeof input === 'object' && typeof (input as { chain?: unknown }).chain === 'string' ? (input as { chain: string }).chain : undefined;
    const envelope = chain && agent.orgId === orgId ? await this.store.getEnvelope(orgId, agent.agentName, chain) : undefined;
    const result: DecideResult = await decide(input, agent, envelope, this.budget, now, { orgId, grader: this.grader, authorizationTtlMs: this.authorizationTtlMs, decisionTtlMs: this.decisionTtlMs });

    const rawSha256 = result.record ? (result.record.raw ? safeDigest(result.record.raw) : undefined) : safeDigest(input);
    const row: DecisionRow = {
      id: decisionId,
      orgId,
      agentName: agent.agentName,
      status: result.verdict === 'ALLOW' ? 'AUTO_APPROVED' : result.verdict === 'ESCALATE' ? 'PENDING' : 'DENIED',
      verdict: result.verdict,
      ...(result.code ? { code: result.code } : {}),
      impact: result.impact,
      reasons: result.reasons,
      record: result.record ? recordForAudit(result.record) : {},
      ...(rawSha256 ? { rawSha256 } : {}),
      ...(result.reservation ? { reservationId: result.reservation.id } : {}),
      ...(envelope ? { envelopeVersion: envelope.version } : {}),
      createdAt: now.toISOString(),
      ...(result.verdict === 'ESCALATE' && result.reservation ? { expiresAt: result.reservation.expiresAt } : {}),
    };
    let authorization: SpendAuthorization | undefined;
    if (result.verdict === 'ALLOW') {
      // issue() audits the authorization; the decision is audited first so the log reads in order.
      await this.store.putDecision(row);
      await this.auditDecision(row, result.checks, options.caller);
      authorization = await this.issue(row, result.record!, now);
      await this.store.updateDecision(row.id, 'AUTO_APPROVED', { authorizationId: authorization.id });
      return { verdict: 'ALLOW', authorization, decisionId, impact: row.impact, reasons: row.reasons };
    }
    await this.store.putDecision(row);
    await this.auditDecision(row, result.checks, options.caller);
    return this.verdictOf(row, false);
  }

  private auditDecision(row: DecisionRow, checks: readonly string[], caller: CallerInfo | undefined): Promise<AuditEntry> {
    return this.audit(row.orgId, {
      kind: 'decision',
      id: row.id,
      at: row.createdAt,
      data: {
        agentName: row.agentName,
        verdict: row.verdict,
        ...(row.code ? { code: row.code } : {}),
        impact: row.impact,
        reasons: row.reasons,
        checks: [...checks],
        record: row.record,
        ...(row.rawSha256 ? { rawSha256: row.rawSha256 } : {}),
        ...(row.reservationId ? { reservationId: row.reservationId } : {}),
        ...(row.envelopeVersion !== undefined ? { envelopeVersion: row.envelopeVersion } : {}),
        ...(caller?.apiKeyId ? { apiKeyId: caller.apiKeyId } : {}),
      },
    });
  }

  // ── settle ────────────────────────────────────────────────────────────────

  private async authorizationFor(orgId: string, id: string): Promise<AuthorizationRow> {
    const row = typeof id === 'string' && id ? await this.store.getAuthorization(id) : undefined;
    if (!row || row.authorization.orgId !== orgId) throw new PlaneError(404, 'AUTHORIZATION_NOT_FOUND', `no authorization ${id} in ${orgId}`);
    return row;
  }

  private async settled(row: AuthorizationRow, extra: Partial<SettleResponse> = {}): Promise<SettleResponse> {
    const r = await this.store.getReservation(row.authorization.reservationId);
    return { authorization: view(row), reservation: { id: row.authorization.reservationId, status: r?.status ?? 'RELEASED' }, anomaly: row.anomaly ?? null, ...extra };
  }

  /** The signer's report: CONFIRMED commits, REVERTED rolls back. */
  async settle(orgId: string, req: unknown, caller?: CallerInfo): Promise<SettleResponse> {
    const r = req as SettleRequest;
    if (!r || typeof r !== 'object' || typeof r.authorizationId !== 'string' || !r.authorizationId || (r.outcome !== 'CONFIRMED' && r.outcome !== 'REVERTED') || typeof r.txHash !== 'string' || !r.txHash || r.txHash.length > 256)
      throw new PlaneError(400, 'SETTLEMENT_INVALID', 'settle takes { authorizationId, outcome: CONFIRMED | REVERTED, txHash, ledger? }');
    if (r.ledger !== undefined && (typeof r.ledger !== 'object' || typeof r.ledger.paymentId !== 'string' || !/^pay_[A-Za-z0-9-]+$/.test(r.ledger.paymentId) || !Array.isArray(r.ledger.outputs) || r.ledger.outputs.length === 0 || r.ledger.outputs.length > 1000))
      throw new PlaneError(400, 'SETTLEMENT_INVALID', 'ledger is { paymentId: pay_…, outputs: [{ scriptHex, valueSats }], confirmations?, rbfSignalled? }');
    return r.outcome === 'CONFIRMED' ? this.commit(orgId, r.authorizationId, r.txHash, { ...(r.ledger ? { ledger: r.ledger } : {}), ...(caller ? { caller } : {}) }) : this.rollback(orgId, r.authorizationId, r.txHash, caller);
  }

  /** The chain confirmed: SPENT, reservation COMMITTED, destination remembered, ledger told (when configured). */
  async commit(orgId: string, authorizationId: string, txHash: string, options: { ledger?: LedgerObservation; caller?: CallerInfo } = {}): Promise<SettleResponse> {
    const now = this.now();
    const row = await this.authorizationFor(orgId, authorizationId);
    if (row.status === 'SPENT') {
      if (row.txHash === txHash && row.outcome === 'CONFIRMED') return this.settled(row, { replayed: true });
      throw new PlaneError(409, 'SETTLEMENT_CONFLICT', `authorization ${authorizationId} was already settled with ${row.txHash}`);
    }
    if (row.status === 'REVOKED') throw new PlaneError(409, 'SETTLEMENT_CONFLICT', `authorization ${authorizationId} was rolled back${row.txHash ? ` (${row.txHash})` : ''}`);
    const late = now.getTime() > Date.parse(row.authorization.expiresAt) || row.status === 'EXPIRED';
    const anomaly = late ? 'EXPIRED_BEFORE_SETTLE' : null;
    const next = await this.store.transitionAuthorization(authorizationId, row.status, 'SPENT', { spentAt: now.toISOString(), txHash, outcome: 'CONFIRMED', anomaly });
    if (!next) return this.commit(orgId, authorizationId, txHash, options); // lost a race: re-read and answer from the new state
    const rid = row.authorization.reservationId;
    (await this.budget.commit(rid, now)) ?? (await this.store.transitionReservation(rid, 'RELEASED', 'COMMITTED', now.toISOString(), 'confirmed after release'));
    const a = row.authorization;
    if (a.destination !== null) await this.store.markDestination(orgId, a.chain, a.destination, now.toISOString());
    await this.audit(orgId, { kind: 'settlement', id: authorizationId, data: { outcome: 'CONFIRMED', txHash, reservationId: rid, maxAmount: a.maxAmount, destination: a.destination, anomaly, ...(options.caller?.apiKeyId ? { apiKeyId: options.caller.apiKeyId } : {}), ...(options.ledger ? { ledgerPaymentId: options.ledger.paymentId } : {}) } });
    let ledger: SettleResponse['ledger'];
    if (options.ledger) {
      if (!this.ledger) ledger = { recorded: false, error: 'no ledger is configured on this plane' };
      else {
        try {
          const res = await this.ledger.observe(txHash, options.ledger);
          ledger = { recorded: true, applied: res.applied, ...(res.reason !== undefined ? { reason: res.reason } : {}) };
        } catch (err) {
          ledger = { recorded: false, error: (err as Error).message };
        }
      }
    }
    return this.settled(next, ledger ? { ledger } : {});
  }

  /** Reverted, or never broadcast: REVOKED, reservation RELEASED. */
  async rollback(orgId: string, authorizationId: string, txHash?: string, caller?: CallerInfo): Promise<SettleResponse> {
    const now = this.now();
    const row = await this.authorizationFor(orgId, authorizationId);
    if (row.status === 'REVOKED') {
      if ((row.txHash ?? undefined) === txHash) return this.settled(row, { replayed: true });
      throw new PlaneError(409, 'SETTLEMENT_CONFLICT', `authorization ${authorizationId} was already rolled back`);
    }
    if (row.status === 'SPENT') throw new PlaneError(409, 'SETTLEMENT_CONFLICT', `authorization ${authorizationId} was confirmed with ${row.txHash}`);
    const next = await this.store.transitionAuthorization(authorizationId, row.status, 'REVOKED', { txHash: txHash ?? null, outcome: 'REVERTED' });
    if (!next) return this.rollback(orgId, authorizationId, txHash, caller);
    const rid = row.authorization.reservationId;
    await this.budget.release(rid, now, txHash ? 'reverted' : 'rolled back');
    await this.audit(orgId, { kind: 'settlement', id: authorizationId, data: { outcome: 'REVERTED', txHash: txHash ?? null, reservationId: rid, ...(caller?.apiKeyId ? { apiKeyId: caller.apiKeyId } : {}) } });
    return this.settled(next);
  }

  // ── envelopes ─────────────────────────────────────────────────────────────

  async putEnvelope(orgId: string, agentName: string, input: unknown, setBy: EnvelopeSetter): Promise<Envelope> {
    const parsed = parseEnvelopeInput(input, { chains: this.chains });
    if (!parsed.ok) throw new PlaneError(400, 'invalid_envelope', parsed.errors.join('; '), { errors: parsed.errors });
    const now = this.now().toISOString();
    const stored = await this.store.putEnvelope({ ...parsed.value, orgId, agentName, setAt: now, setBy });
    await this.audit(orgId, { kind: 'envelope', id: `${agentName}@${stored.chain}#${stored.version}`, at: now, data: { agentName, envelope: { ...stored } } });
    return stored;
  }

  listEnvelopes(orgId: string, agentName: string): Promise<Envelope[]> {
    return this.store.listEnvelopes(orgId, agentName);
  }

  // ── decisions ─────────────────────────────────────────────────────────────

  async getDecision(orgId: string, decisionId: string): Promise<DecisionRow> {
    const d = await this.store.getDecision(decisionId);
    if (!d || d.orgId !== orgId) throw new PlaneError(404, 'DECISION_NOT_FOUND', `no decision ${decisionId} in ${orgId}`);
    return d;
  }

  /** A person approves (issues the held authorization, fresh window) or rejects (releases) a PENDING decision. */
  async resolveDecision(orgId: string, decisionId: string, resolution: 'APPROVED' | 'REJECTED', by: { approver: string; apiKeyId?: string; note?: string }): Promise<{ decision: DecisionRow; authorization?: SpendAuthorization }> {
    const now = this.now();
    await this.sweep(now);
    const d = await this.getDecision(orgId, decisionId);
    if (d.status !== 'PENDING') throw new PlaneError(409, 'DECISION_NOT_PENDING', `decision ${decisionId} is ${d.status}`);
    const resolved = await this.store.updateDecision(decisionId, 'PENDING', { status: resolution, resolvedAt: now.toISOString(), resolvedBy: by.approver });
    if (!resolved) throw new PlaneError(409, 'DECISION_NOT_PENDING', `decision ${decisionId} was resolved concurrently`);
    await this.audit(orgId, { kind: 'resolution', id: decisionId, at: now.toISOString(), data: { resolution, approver: by.approver, ...(by.apiKeyId ? { apiKeyId: by.apiKeyId } : {}), ...(by.note ? { note: by.note } : {}), reservationId: d.reservationId ?? null } });
    if (resolution === 'REJECTED') {
      if (d.reservationId) await this.budget.release(d.reservationId, now, 'rejected');
      return { decision: resolved };
    }
    const authorization = await this.issue(resolved, d.record as OperationRecord, now);
    if (d.reservationId) await this.budget.extend(d.reservationId, new Date(authorization.expiresAt));
    const final = (await this.store.updateDecision(decisionId, 'APPROVED', { authorizationId: authorization.id })) ?? resolved;
    return { decision: final, authorization };
  }

  // ── expiry ────────────────────────────────────────────────────────────────

  /** Expire unspent authorizations and unresolved decisions, releasing their reservations; then release any stray reservation past its hold. */
  async sweep(now: Date = this.now()): Promise<{ authorizations: number; decisions: number; reservations: number }> {
    const at = now.toISOString();
    let authorizations = 0;
    let decisions = 0;
    for (const row of await this.store.expiredAuthorizations(at)) {
      const next = await this.store.transitionAuthorization(row.authorization.id, 'ISSUED', 'EXPIRED');
      if (!next) continue;
      authorizations++;
      await this.budget.release(row.authorization.reservationId, now, 'authorization expired unspent');
      await this.audit(row.authorization.orgId, { kind: 'expiry', id: row.authorization.id, at, data: { what: 'authorization', reservationId: row.authorization.reservationId } });
    }
    for (const d of await this.store.expiredDecisions(at)) {
      const next = await this.store.updateDecision(d.id, 'PENDING', { status: 'EXPIRED', resolvedAt: at });
      if (!next) continue;
      decisions++;
      if (d.reservationId) await this.budget.release(d.reservationId, now, 'decision expired unresolved');
      await this.audit(d.orgId, { kind: 'expiry', id: d.id, at, data: { what: 'decision', reservationId: d.reservationId ?? null } });
    }
    const reservations = (await this.budget.sweep(now)).length;
    return { authorizations, decisions, reservations };
  }
}


