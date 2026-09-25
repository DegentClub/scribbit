// The five checks. FlashyOS docs/wallet/spec.md §4, in their order, which is load-bearing:
// cheap, identity-shaped checks first; nothing touches the budget for a proposal the
// envelope refuses; nothing stays reserved for a proposal that is refused.
//
//   1. identity   - the caller is an agent of this organisation (and the envelope is its own)
//   2. authority  - it holds wallet:propose (exact match, default deny) and not wallet:settle
//      (record)   - the record parses: INVALID_RECORD / INVALID_AMOUNT "before evaluation"
//   3. envelope   - one exists for the chain, is active, and permits kind, asset,
//                   destination and amount <= perTxMax
//   4. budget     - today's reserved + committed + amount <= dailyMax, reserved atomically
//   5. grading    - the envelope's policy (autoApproveMax / alwaysEscalate / the role's
//                   humanApprovalAtOrAbove) and then the pluggable Grader; a grader DENY
//                   releases the reservation, an ESCALATE holds it for a person
//
// Identity and authority failures are DENY SCOPE_MISSING (FlashyOS has no separate identity
// code; the reason says which). `decide` issues nothing: on ALLOW the service signs the
// authorization, on ESCALATE it records a pending decision.
import type { Budget } from './budget.ts';
import { destinationPermitted, policyGrade, maxImpact, type Envelope, type Impact } from './envelope.ts';
import type { Grader } from './grading.ts';
import { parseOperationRecord, type DenialCode, type OperationRecord } from './record.ts';
import type { Reservation } from './store/types.ts';

export const SCOPE_PROPOSE = 'wallet:propose';
export const SCOPE_SETTLE = 'wallet:settle';
export const SCOPE_DELEGATE = 'wallet:delegate';
export const SCOPE_READ = 'wallet:read';
export const WALLET_SCOPES = [SCOPE_PROPOSE, SCOPE_SETTLE, SCOPE_DELEGATE, SCOPE_READ] as const;

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ORG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** FlashyOS's default TTL for an authorization, and so for the reservation behind it. */
export const AUTHORIZATION_TTL_MS = 300_000;
/** How long an escalated proposal holds its reservation waiting for a person. */
export const DECISION_TTL_MS = 24 * 3600_000;

export interface AgentIdentity {
  orgId: string;
  agentName: string;
  scopes: readonly string[];
}

export type CheckName = 'identity' | 'authority' | 'record' | 'envelope' | 'budget' | 'grading';
export const CHECK_ORDER: readonly CheckName[] = ['identity', 'authority', 'record', 'envelope', 'budget', 'grading'];

export interface DecideResult {
  verdict: 'ALLOW' | 'ESCALATE' | 'DENY';
  code?: DenialCode;
  reasons: string[];
  impact: Impact;
  /** The checks that ran, in order; the last one decided a DENY. */
  checks: CheckName[];
  /** Present when the record parsed. */
  record?: OperationRecord;
  amount?: bigint;
  /** Held on ALLOW and ESCALATE; never on DENY. */
  reservation?: Reservation;
}

export interface DecideOptions {
  /** The route's organisation: the agent must belong to it. Default: the agent's own. */
  orgId?: string;
  grader?: Grader;
  /** Reservation hold for ALLOW (the authorization's life). Default 300 s. */
  authorizationTtlMs?: number;
  /** Reservation hold for ESCALATE. Default 24 h. */
  decisionTtlMs?: number;
}

/**
 * Runs the five checks on a proposed record. `envelope` is the agent's envelope for the
 * record's chain (undefined when it has none). Throws only for storage failures.
 */
export async function decide(input: unknown, agent: AgentIdentity, envelope: Envelope | undefined, budget: Budget, now: Date, options: DecideOptions = {}): Promise<DecideResult> {
  const checks: CheckName[] = [];
  const deny = (code: DenialCode, reason: string, extra: Partial<DecideResult> = {}): DecideResult => ({ verdict: 'DENY', code, reasons: [reason], impact: 'LOW', checks, ...extra });

  // 1. identity
  checks.push('identity');
  const orgId = options.orgId ?? agent.orgId;
  if (!agent || typeof agent.orgId !== 'string' || !ORG_RE.test(agent.orgId) || typeof agent.agentName !== 'string' || !NAME_RE.test(agent.agentName))
    return deny('SCOPE_MISSING', 'identity: the caller is not an identified agent');
  if (agent.orgId !== orgId) return deny('SCOPE_MISSING', `identity: agent ${agent.agentName} belongs to ${agent.orgId}, not ${orgId}`);
  if (envelope && (envelope.orgId !== agent.orgId || envelope.agentName !== agent.agentName))
    return deny('SCOPE_MISSING', `identity: the envelope belongs to ${envelope.orgId}/${envelope.agentName}, not ${agent.orgId}/${agent.agentName}`);

  // 2. authority
  checks.push('authority');
  if (!Array.isArray(agent.scopes) || !agent.scopes.includes(SCOPE_PROPOSE)) return deny('SCOPE_MISSING', `authority: the key does not hold ${SCOPE_PROPOSE}`);
  if (agent.scopes.includes(SCOPE_SETTLE)) return deny('SCOPE_MISSING', `authority: a key holding ${SCOPE_SETTLE} may never propose`);

  // (record) - rejected before evaluation
  checks.push('record');
  const parsed = parseOperationRecord(input);
  if (!parsed.ok) return deny(parsed.code, parsed.reason);
  const { record, amount } = parsed;
  const withRecord = { record, amount };

  // 3. envelope
  checks.push('envelope');
  if (!envelope || envelope.chain !== record.chain) return deny('NO_ENVELOPE', `no envelope for ${agent.agentName} on ${record.chain}`, withRecord);
  if (!envelope.active) return deny('ENVELOPE_INACTIVE', `the envelope for ${agent.agentName} on ${record.chain} is inactive`, withRecord);
  if (!envelope.kinds.includes(record.kind)) return deny('KIND_NOT_PERMITTED', `kind ${record.kind} is not in ${envelope.kinds.join(', ') || 'nothing'}`, withRecord);
  if (!envelope.assets.includes(record.asset)) return deny('ASSET_NOT_PERMITTED', `asset ${record.asset} is not on the envelope`, withRecord);
  const dest = destinationPermitted(envelope, record);
  if (!dest.ok) return deny('DESTINATION_NOT_PERMITTED', `destination ${record.destination ?? 'null'} is not on the envelope${record.payee ? ` (nor is payee:${record.payee.kind})` : ''}`, withRecord);
  if (amount > BigInt(envelope.perTxMax)) return deny('PER_TX_CAP', `amount ${amount} > perTxMax ${envelope.perTxMax}`, withRecord);

  // 4. budget
  checks.push('budget');
  const held = await budget.reserve({
    orgId: agent.orgId,
    agentName: agent.agentName,
    chain: record.chain,
    amount,
    cap: BigInt(envelope.dailyMax),
    now,
    ttlMs: options.authorizationTtlMs ?? AUTHORIZATION_TTL_MS,
  });
  if (!held.ok) return deny('DAILY_CAP', `today's ${held.used} reserved or committed + ${amount} > dailyMax ${envelope.dailyMax}`, withRecord);
  const reservation = held.reservation;

  // 5. grading
  checks.push('grading');
  const policy = policyGrade(envelope, amount);
  const reasons = [`destination permitted (${dest.via})`, ...policy.reasons];
  let impact: Impact = policy.impact;
  let escalate = policy.escalate;
  if (options.grader) {
    let grade;
    try {
      grade = await options.grader.grade({ record, amount, agent, envelope, now });
    } catch (err) {
      await budget.release(reservation.id, now, 'grading failed');
      throw err;
    }
    reasons.push(...grade.reasons);
    if (grade.verdict === 'DENY') {
      await budget.release(reservation.id, now, `refused by grading (${options.grader.name})`);
      return { verdict: 'DENY', code: grade.code ?? 'DESTINATION_NOT_PERMITTED', reasons, impact, checks, ...withRecord };
    }
    if (grade.verdict === 'ESCALATE') {
      escalate = true;
      impact = maxImpact(impact, grade.impact ?? envelope.escalationImpact);
    }
  }
  if (escalate) {
    // A role whose threshold is LOW escalates LOW-impact proposals: the impact stays LOW (honest;
    // FlashyOS's verdict schema only names MEDIUM+ because its threshold is fixed at MEDIUM).
    const until = new Date(now.getTime() + (options.decisionTtlMs ?? DECISION_TTL_MS));
    await budget.extend(reservation.id, until);
    return { verdict: 'ESCALATE', reasons, impact, checks, ...withRecord, reservation: { ...reservation, expiresAt: until.toISOString() } };
  }
  return { verdict: 'ALLOW', reasons, impact, checks, ...withRecord, reservation };
}
