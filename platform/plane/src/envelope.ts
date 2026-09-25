// SpendEnvelope - what one agent may do on one chain. FlashyOS docs/wallet/spec.md §3 and
// schema/spend-envelope-input.json: kinds, assets, destinations (exact addresses; empty =
// none), perTxMax, dailyMax, autoApproveMax, alwaysEscalate, escalationImpact. An agent
// with no envelope for a chain may do nothing there. A change is a new version; the old
// one is kept.
//
// OURS, marked: `active` on the input (FlashyOS revokes through a separate route),
// `payee:<kind>` destination classes, and `humanApprovalAtOrAbove` - the charter role's
// threshold (aao/0.1 roles carry `humanApprovalAtOrAbove`), which decides which graded
// impacts need a person. `delegable: true` is refused: delegation is not implemented.
//
// Roadmap vocabulary → fields: perTxCap = perTxMax, dailyCap = dailyMax,
// escalateAbove = autoApproveMax.
import { AMOUNT_RE, BTC_CHAINS, CHAIN_RE, isBtcChain, validateBtcDestination } from '@bsh/mesh';
import { normalizeAddress, OPERATION_KINDS, PAYEE_KINDS, type OperationKind, type OperationRecord } from './record.ts';

export const IMPACTS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Impact = (typeof IMPACTS)[number];
export const ESCALATION_IMPACTS = ['MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type EscalationImpact = (typeof ESCALATION_IMPACTS)[number];

export const impactRank = (i: Impact): number => IMPACTS.indexOf(i);
export const maxImpact = (a: Impact, b: Impact): Impact => (impactRank(a) >= impactRank(b) ? a : b);

/** `payee:artist` … - a destination class matched by the record's `payee.kind`. */
export const PAYEE_CLASS_RE = /^payee:(artist|club|platform|other)$/;

export interface SpendEnvelopeInput {
  chain: string;
  kinds: OperationKind[];
  assets: string[];
  destinations: string[];
  perTxMax: string;
  dailyMax: string;
  autoApproveMax: string;
  alwaysEscalate?: boolean;
  escalationImpact?: EscalationImpact;
  delegable?: false;
  active?: boolean;
  humanApprovalAtOrAbove?: Impact;
}

export interface EnvelopeSetter {
  apiKeyId: string;
  approver: string;
  approverKid?: string;
}

export interface Envelope {
  orgId: string;
  agentName: string;
  chain: string;
  kinds: OperationKind[];
  assets: string[];
  /** Normalised (lowercased on evm/btc); `payee:<kind>` entries as given. */
  destinations: string[];
  perTxMax: string;
  dailyMax: string;
  autoApproveMax: string;
  alwaysEscalate: boolean;
  escalationImpact: EscalationImpact;
  /** Absent = MEDIUM, FlashyOS's rule: anything graded above LOW needs a person. */
  humanApprovalAtOrAbove?: Impact;
  active: boolean;
  version: number;
  setAt: string;
  setBy: EnvelopeSetter;
  supersededAt: string | null;
}

const INPUT_KEYS = new Set(['chain', 'kinds', 'assets', 'destinations', 'perTxMax', 'dailyMax', 'autoApproveMax', 'alwaysEscalate', 'escalationImpact', 'delegable', 'active', 'humanApprovalAtOrAbove']);
const MAX_LIST = 1000;

export type EnvelopeInputCheck = { ok: true; value: Required<Omit<SpendEnvelopeInput, 'delegable' | 'humanApprovalAtOrAbove'>> & { humanApprovalAtOrAbove?: Impact } } | { ok: false; errors: string[] };

const uniqueStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_LIST && v.every((x) => typeof x === 'string' && x.length > 0) && new Set(v).size === v.length;

/**
 * Validates a SpendEnvelopeInput: FlashyOS's schema, plus our fields, plus - on btc chains -
 * every exact destination must be a segwit address for the network. `chains` limits which
 * chains this plane accepts envelopes for. Returns every problem.
 */
export function parseEnvelopeInput(input: unknown, options: { chains?: readonly string[] } = {}): EnvelopeInputCheck {
  const errors: string[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['an envelope is a JSON object'] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!INPUT_KEYS.has(k)) errors.push(`unknown member "${k}"`);
  const chain = o.chain;
  if (typeof chain !== 'string' || !CHAIN_RE.test(chain)) errors.push('chain must be <family>:<chainId>');
  else if (options.chains && !options.chains.includes(chain)) errors.push(`this plane authorizes ${options.chains.join(', ')}, not ${chain}`);
  if (!uniqueStrings(o.kinds) || !o.kinds.every((k) => (OPERATION_KINDS as readonly string[]).includes(k))) errors.push(`kinds must be unique values of ${OPERATION_KINDS.join(', ')}`);
  if (!uniqueStrings(o.assets)) errors.push('assets must be unique non-empty strings');
  if (!uniqueStrings(o.destinations)) errors.push('destinations must be unique non-empty strings');
  else if (typeof chain === 'string') {
    o.destinations.forEach((d, i) => {
      if (d.startsWith('payee:')) {
        if (!PAYEE_CLASS_RE.test(d)) errors.push(`destinations[${i}]: "${d}" is not payee:${PAYEE_KINDS.join('|payee:')}`);
        return;
      }
      if (isBtcChain(chain) && BTC_CHAINS[chain]) {
        const check = validateBtcDestination(chain, d);
        if (!check.ok) errors.push(`destinations[${i}]: ${check.reason}`);
      }
    });
  }
  for (const k of ['perTxMax', 'dailyMax', 'autoApproveMax'] as const) if (typeof o[k] !== 'string' || !AMOUNT_RE.test(o[k] as string)) errors.push(`${k} must be a non-negative integer as a decimal string`);
  if (o.alwaysEscalate !== undefined && typeof o.alwaysEscalate !== 'boolean') errors.push('alwaysEscalate is a boolean');
  if (o.active !== undefined && typeof o.active !== 'boolean') errors.push('active is a boolean');
  if (o.escalationImpact !== undefined && !(ESCALATION_IMPACTS as readonly unknown[]).includes(o.escalationImpact)) errors.push(`escalationImpact is one of ${ESCALATION_IMPACTS.join(', ')}`);
  if (o.humanApprovalAtOrAbove !== undefined && !(IMPACTS as readonly unknown[]).includes(o.humanApprovalAtOrAbove)) errors.push(`humanApprovalAtOrAbove is one of ${IMPACTS.join(', ')}`);
  if (o.delegable !== undefined && o.delegable !== false) errors.push('delegable: delegation is not implemented by this plane; only false is accepted');
  if (errors.length) return { ok: false, errors };
  const c = chain as string;
  return {
    ok: true,
    value: {
      chain: c,
      kinds: [...(o.kinds as OperationKind[])],
      assets: (o.assets as string[]).map((a) => (a === 'native' ? a : normalizeAddress(c, a))),
      destinations: (o.destinations as string[]).map((d) => (d.startsWith('payee:') ? d : normalizeAddress(c, d))),
      perTxMax: o.perTxMax as string,
      dailyMax: o.dailyMax as string,
      autoApproveMax: o.autoApproveMax as string,
      alwaysEscalate: (o.alwaysEscalate as boolean | undefined) ?? false,
      escalationImpact: (o.escalationImpact as EscalationImpact | undefined) ?? 'MEDIUM',
      active: (o.active as boolean | undefined) ?? true,
      ...(o.humanApprovalAtOrAbove !== undefined ? { humanApprovalAtOrAbove: o.humanApprovalAtOrAbove as Impact } : {}),
    },
  };
}

/** Is the record's destination on the envelope's list? A swap with a null destination stays within the org. */
export function destinationPermitted(envelope: Pick<Envelope, 'destinations'>, record: OperationRecord): { ok: true; via: string } | { ok: false } {
  if (record.destination === null) return record.kind === 'swap' ? { ok: true, via: 'internal swap' } : { ok: false };
  if (envelope.destinations.includes(record.destination)) return { ok: true, via: 'exact address' };
  if (record.payee && envelope.destinations.includes(`payee:${record.payee.kind}`)) return { ok: true, via: `payee:${record.payee.kind}` };
  return { ok: false };
}

/** Check 5's policy half: the impact the envelope assigns and whether a person must decide. */
export function policyGrade(envelope: Pick<Envelope, 'autoApproveMax' | 'alwaysEscalate' | 'escalationImpact' | 'humanApprovalAtOrAbove'>, amount: bigint): { impact: Impact; escalate: boolean; reasons: string[] } {
  const threshold = envelope.humanApprovalAtOrAbove ?? 'MEDIUM';
  if (envelope.alwaysEscalate) return { impact: envelope.escalationImpact, escalate: true, reasons: [`envelope escalates every proposal (impact ${envelope.escalationImpact})`] };
  const above = amount > BigInt(envelope.autoApproveMax);
  const impact: Impact = above ? envelope.escalationImpact : 'LOW';
  const escalate = impactRank(impact) >= impactRank(threshold);
  const reasons = [
    above ? `amount ${amount} > autoApproveMax ${envelope.autoApproveMax}: impact ${impact}` : `amount ${amount} <= autoApproveMax ${envelope.autoApproveMax}: impact LOW`,
  ];
  if (escalate) reasons.push(`impact ${impact} is at or above humanApprovalAtOrAbove ${threshold}: a person decides`);
  else if (above) reasons.push(`impact ${impact} is below humanApprovalAtOrAbove ${threshold}: no person needed`);
  return { impact, escalate, reasons };
}

/** The part of an aao/0.1 charter this needs. */
export interface CharterRoles {
  roles: ReadonlyArray<{ name: string; humanApprovalAtOrAbove?: string }>;
}

/**
 * An envelope input for an agent that performs `roleName` in `charter`: the role's
 * `humanApprovalAtOrAbove` becomes the envelope's. Throws when the charter has no such role.
 */
export function envelopeForRole(charter: CharterRoles, roleName: string, input: Omit<SpendEnvelopeInput, 'humanApprovalAtOrAbove'>): SpendEnvelopeInput {
  const role = charter.roles.find((r) => r.name === roleName);
  if (!role) throw new Error(`the charter has no role "${roleName}"`);
  const threshold = role.humanApprovalAtOrAbove;
  if (threshold !== undefined && !(IMPACTS as readonly string[]).includes(threshold)) throw new Error(`role ${roleName}: humanApprovalAtOrAbove "${threshold}" is not an impact`);
  return { ...input, ...(threshold !== undefined ? { humanApprovalAtOrAbove: threshold as Impact } : {}) };
}
