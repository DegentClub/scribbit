// aao/0.1 - the AAO charter an organisation publishes at /flashyos.roles.json and
// /.well-known/flashyos-charter.json.
//
// `validateCharter` reproduces every rule of FlashyLabs' vendored check-charter.mjs,
// including its two deliberately-stricter-than-spec house rules (the template
// placeholder address, and a capability that names one of the ten families).
// Rule text is kept verbatim so a finding here reads like a finding there.
import { asArray, asString, Collector, type Finding, isRecord } from './common.ts';

export const AAO_VERSION = '0.1';
export const CHARTER_WELL_KNOWN = '/.well-known/flashyos-charter.json';
export const CHARTER_ROLES_PATH = '/flashyos.roles.json';

export const FAMILIES = ['growth', 'revenue', 'product', 'engineering', 'operations', 'data', 'finance', 'risk', 'governance', 'support'] as const;
export type Family = (typeof FAMILIES)[number];

export const IMPACT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const CHARTER_TOP_KEYS = ['aao', 'name', 'slug', 'description', 'accountableTo', 'escalation', 'repositories', 'roles', 'network'] as const;
export const ROLE_KEYS = ['name', 'family', 'purpose', 'measure', 'capabilities', 'humanApprovalAtOrAbove', 'worksIn', 'renamedFrom'] as const;

/** The spec's own rule, character for character: lowercase letters and digits, single hyphens, starting with a letter. */
export const ROLE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const ROLE_NAME_MIN = 3;
export const ROLE_NAME_MAX = 24;
export const ROLE_NAME_MAX_WORDS = 3;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ACCOUNTABLE_EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
export const PLACEHOLDER_EMAIL = 'you@example.com';

/** Anything outside the spec is carried as an explicit `x-` extension, never a bare key. */
export type Extensions = { [key: `x-${string}`]: unknown };

export interface CharterRepository extends Extensions {
  name: string;
  url?: string;
  holds?: string[];
  default?: boolean;
}

export interface CharterRole extends Extensions {
  name: string;
  family?: Family;
  purpose: string;
  measure?: string;
  /** Actions, never departments. */
  capabilities?: string[];
  humanApprovalAtOrAbove?: ImpactLevel;
  /** Names of declared repositories. */
  worksIn?: string[];
  renamedFrom?: string[];
}

export interface Charter extends Extensions {
  aao: '0.1';
  name: string;
  slug: string;
  description: string;
  /** Question five: a real, reachable human. */
  accountableTo: string;
  /** Names a declared role. */
  escalation?: string;
  repositories?: CharterRepository[];
  roles: CharterRole[];
  /** Allowed by aao 0.1; its shape is not specified in the material this package was built from. */
  network?: unknown;
}

const TOP = new Set<string>(CHARTER_TOP_KEYS);
const ROLE = new Set<string>(ROLE_KEYS);
const FAMILY_SET = new Set<string>(FAMILIES);
const IMPACT_SET = new Set<string>(IMPACT_LEVELS);

/** Every problem in a charter. Empty means it conforms (all charter findings are errors). */
export function validateCharter(doc: unknown): Finding[] {
  const out = new Collector();
  const bad = (code: string, at: string, msg: string): void => out.bad(code, at, msg);
  if (!isRecord(doc)) {
    bad('not-an-object', '', 'a charter is a JSON object');
    return out.findings;
  }
  const c = doc;

  if (c.aao !== AAO_VERSION) bad('aao-version', 'aao', `declares "${String(c.aao)}"`);
  if (!asString(c.name).trim()) bad('name-missing', 'name', 'missing');
  if (!SLUG_RE.test(asString(c.slug))) bad('slug-invalid', 'slug', `"${String(c.slug)}" is not a url-safe slug`);
  if (!asString(c.description).trim()) bad('description-missing', 'description', 'an org with no description says nothing');

  // Question five: a real, reachable human.
  if (!ACCOUNTABLE_EMAIL_RE.test(asString(c.accountableTo)))
    bad('accountable-not-email', 'accountableTo', 'must be an email — the accountable human is reachable');
  if (c.accountableTo === PLACEHOLDER_EMAIL) bad('accountable-placeholder', 'accountableTo', 'is the template placeholder');

  for (const k of Object.keys(c))
    if (!TOP.has(k) && !k.startsWith('x-')) bad('unknown-top-key', k, 'not part of aao 0.1 — prefix "x-" to carry it as an explicit extension');

  const repos = asArray(c.repositories);
  if (c.repositories !== undefined && !Array.isArray(c.repositories)) bad('repositories-not-array', 'repositories', 'repositories is a list');
  if (repos.length && repos.filter((r) => isRecord(r) && r.default).length > 1)
    bad('repositories-multiple-default', 'repositories', 'at most one default repository');
  const repoNames = new Set(repos.map((r) => (isRecord(r) ? r.name : undefined)));

  if (!Array.isArray(c.roles) || !c.roles.length) bad('roles-empty', 'roles', 'an org with no roles is not an organization');
  const names = new Set<unknown>();
  asArray(c.roles).forEach((raw, i) => {
    const at = `roles[${i}]`;
    if (!isRecord(raw)) {
      bad('role-not-object', at, 'a role is a JSON object');
      return;
    }
    const r = raw;
    if (names.has(r.name)) bad('role-duplicate', at, `duplicate role name "${String(r.name)}"`);
    names.add(r.name);
    // A role is a standing responsibility named for the function performed.
    const name = asString(r.name);
    if (!ROLE_NAME_RE.test(name)) bad('role-name-invalid', at, `"${String(r.name)}" is not a plain lowercase function name`);
    else if (name.length < ROLE_NAME_MIN || name.length > ROLE_NAME_MAX)
      bad('role-name-length', at, `"${name}" is ${name.length} characters — a role name is ${ROLE_NAME_MIN} to ${ROLE_NAME_MAX}`);
    if (name.split('-').length > ROLE_NAME_MAX_WORDS) bad('role-name-words', at, `"${name}" is too many words for a role name`);
    if (r.family !== undefined && !FAMILY_SET.has(asString(r.family)))
      bad('role-family-unknown', `${at}.family`, `"${String(r.family)}" is not one of the ten declared families`);
    if (!asString(r.purpose).trim()) bad('role-purpose-missing', at, 'a role with no purpose cannot be delegated');
    // Capabilities name actions, never departments.
    for (const cap of asArray(r.capabilities))
      if (FAMILY_SET.has(asString(cap))) bad('role-capability-is-family', `${at}.capabilities`, `"${String(cap)}" names a department, not an action`);
    if (r.humanApprovalAtOrAbove !== undefined && !IMPACT_SET.has(asString(r.humanApprovalAtOrAbove)))
      bad('role-approval-invalid', `${at}.humanApprovalAtOrAbove`, `"${String(r.humanApprovalAtOrAbove)}" is not LOW, MEDIUM, HIGH or CRITICAL`);
    for (const w of asArray(r.worksIn))
      if (repoNames.size && !repoNames.has(w)) bad('role-worksin-unknown', `${at}.worksIn`, `"${String(w)}" is not a declared repository`);
    for (const k of Object.keys(r)) if (!ROLE.has(k) && !k.startsWith('x-')) bad('role-unknown-key', `${at}.${k}`, 'unknown role key — prefix "x-"');
  });

  if (c.escalation !== undefined && !names.has(c.escalation))
    bad('escalation-unknown', 'escalation', `"${String(c.escalation)}" does not name a declared role`);

  return out.findings;
}

export const isCharter = (doc: unknown): doc is Charter => validateCharter(doc).length === 0;

/** The charter, or a thrown error listing every finding. */
export function assertCharter(doc: unknown): Charter {
  const findings = validateCharter(doc);
  if (findings.length) throw new Error(`charter does not conform:\n${findings.map((f) => `  ${f.path}: ${f.message}`).join('\n')}`);
  return doc as Charter;
}

/** The default repository, else the first, else undefined - the rule directory.mjs uses for the fragment's source. */
export function defaultRepository(charter: Charter): CharterRepository | undefined {
  return charter.repositories?.find((r) => r.default) ?? charter.repositories?.[0];
}

/** One line, the way check-charter.mjs prints it. */
export const charterSummary = (doc: unknown, findings: readonly Finding[]): string => {
  const c = isRecord(doc) ? doc : {};
  return `${asString(c.name) || '(unnamed)'} — ${asArray(c.roles).length} role(s) · ${findings.length} problem(s)`;
};
