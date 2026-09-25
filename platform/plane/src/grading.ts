// Check 5's pluggable half. FlashyOS grades by the envelope alone (autoApproveMax,
// alwaysEscalate); that part is `policyGrade` in envelope.ts and always runs. A Grader is
// a post-check on top of it: it may DENY (the reservation is released - nothing stays
// reserved for a refused proposal) or ESCALATE (a person decides), never loosen.
//
// The default grader (ours) answers the two questions an allowlist cannot: is this
// destination one we have been told never to pay (a denylist), and is this the first
// money we would ever send there (first-time destinations above a threshold go to a
// person, which is what makes `payee:<kind>` classes - asserted by the proposer - safe
// enough to use).
import type { AgentIdentity } from './decide.ts';
import type { Envelope, Impact } from './envelope.ts';
import { normalizeAddress, type DenialCode, type OperationRecord } from './record.ts';

export interface GradeContext {
  record: OperationRecord;
  amount: bigint;
  agent: AgentIdentity;
  envelope: Envelope;
  now: Date;
}

export interface Grade {
  verdict: 'ALLOW' | 'ESCALATE' | 'DENY';
  /** Required with DENY. */
  code?: DenialCode;
  reasons: string[];
  /** With ESCALATE: the impact to record (default: the envelope's escalationImpact). */
  impact?: Impact;
}

export interface Grader {
  readonly name: string;
  grade(ctx: GradeContext): Grade | Promise<Grade>;
}

export const allowGrade = (reasons: string[] = []): Grade => ({ verdict: 'ALLOW', reasons });

/** Whether the org has ever paid `destination` on `chain` (a committed settlement). */
export type SeenDestination = (orgId: string, chain: string, destination: string) => Promise<boolean>;

export interface DefaultGraderOptions {
  /** Destinations never to pay, compared after normalisation (lowercase on evm/btc). */
  denylist?: Iterable<string>;
  /** Escalate a first payment to a destination when the amount is strictly above this. Undefined = no first-time rule. */
  firstTimeEscalateAbove?: bigint;
  /** Required for the first-time rule. */
  seen?: SeenDestination;
}

export function defaultGrader(options: DefaultGraderOptions = {}): Grader {
  const deny = [...(options.denylist ?? [])];
  return {
    name: 'default',
    async grade({ record, amount, agent, envelope }) {
      const dest = record.destination;
      if (dest === null) return allowGrade();
      const denied = deny.some((d) => normalizeAddress(record.chain, d) === dest);
      if (denied) return { verdict: 'DENY', code: 'DESTINATION_NOT_PERMITTED', reasons: [`destination ${dest} is on the denylist`] };
      if (options.firstTimeEscalateAbove !== undefined && options.seen && amount > options.firstTimeEscalateAbove) {
        const seen = await options.seen(agent.orgId, record.chain, dest);
        if (!seen) return { verdict: 'ESCALATE', impact: envelope.escalationImpact, reasons: [`first payment to ${dest}, and ${amount} > ${options.firstTimeEscalateAbove}: a person confirms a new destination`] };
      }
      return allowGrade();
    },
  };
}

/** Runs graders in order; the first DENY wins, otherwise any ESCALATE escalates. Reasons accumulate. */
export function composeGraders(...graders: Grader[]): Grader {
  return {
    name: graders.map((g) => g.name).join('+'),
    async grade(ctx) {
      const reasons: string[] = [];
      let escalate: Grade | undefined;
      for (const g of graders) {
        const r = await g.grade(ctx);
        reasons.push(...r.reasons);
        if (r.verdict === 'DENY') return { ...r, reasons };
        if (r.verdict === 'ESCALATE' && !escalate) escalate = r;
      }
      return escalate ? { ...escalate, reasons } : allowGrade(reasons);
    },
  };
}
