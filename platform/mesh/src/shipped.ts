// shipped/1 and devlog/1 - the sealed record of what a repository shipped, derived
// from the history it already has, and the human-readable changelog beside it.
//
// A port of FlashyLabs' vendor-shiplog.mjs: the same canonicalisation, digest, kind
// mapping, author attribution and bookkeeping filters, so an entry sealed here
// verifies for everyone else. `validateShipped` is ours: the vendored file only
// recomputes seals, and a fragment needs shape rules too (modelled on
// vendor-backlog.mjs's checkFragment).
//
// Git log format (exported as GIT_LOG_FORMAT; identical to FlashyOS's):
//   git log --first-parent --pretty=format:'%H%x1f%aI%x1f%aE%x1f%s%x1f%b%x1e' [rev]
// One record per commit, fields separated by 0x1f (sha, author date ISO, author
// email, subject, body), records terminated by 0x1e. `--first-parent` so an entry is a
// merge to the deploy branch rather than every keystroke.
import { canonicalStringify, sha256Hex } from './canonical.ts';
import { asArray, asString, Collector, DATE_RE, type Finding, HEX64_RE, isIsoDateTime, isRecord, isVisibility, NODE_ID_RE, ORG_ID_RE, REPO_ID_RE, type Visibility } from './common.ts';

export const SHIPPED_VERSION = '1';
export const SHIPLOG_WELL_KNOWN = '/.well-known/shiplog.json';
export const DEVLOG_VERSION = '1';
export const DEVLOG_WELL_KNOWN = '/.well-known/devlog.fragment.json';
export const SHIP_KINDS = ['feature', 'fix', 'security', 'perf', 'docs', 'infra', 'spec', 'release', 'other'] as const;
export type ShipKind = (typeof SHIP_KINDS)[number];
export const GIT_LOG_FORMAT = '%H%x1f%aI%x1f%aE%x1f%s%x1f%b%x1e';
/** The argv for `git` that produces what `parseGitLog` reads. */
export const gitLogArgs = ({ rev = 'HEAD', since }: { rev?: string; since?: string } = {}): string[] => {
  const args = ['log', '--first-parent', `--pretty=format:${GIT_LOG_FORMAT}`, rev];
  if (since) args.push(`--since=${since}`);
  return args;
};

export interface ShippedRefs {
  commit: string;
  pr?: string;
}

export interface ShippedEntryUnsealed {
  /** `ship/<repo>/<sha12>` */
  id: string;
  /** `repo/<name>` */
  repo: string;
  /** Author date, ISO. */
  at: string;
  kind: ShipKind;
  title: string;
  /** person/ and agent/ ids. */
  by: string[];
  asserted: string;
  assertedBy: string;
  visibility: Visibility;
  detail?: string;
  refs?: ShippedRefs;
  /** `backlog/<repo>/<slug>` ids the commit closed. */
  closes?: string[];
}

export interface ShippedEntry extends ShippedEntryUnsealed {
  /** sha256 of the canonical entry without `digest`, hex. */
  digest: string;
}

export interface ShippedFragment {
  shipped: '1';
  source: string;
  org: string;
  generated: string;
  entries: ShippedEntry[];
}

export interface DevlogEntry {
  /** `devlog/<repo>/<sha12>` */
  id: string;
  at: string;
  summary: string;
  commitSha: string;
  ref: string;
}

export interface DevlogFragment {
  devlog: '1';
  source: string;
  org: string;
  generated: string;
  entries: DevlogEntry[];
}

// ── Sealing ─────────────────────────────────────────────────────────────────

/** The canonical bytes of an entry: everything but `digest`, keys sorted, no whitespace. */
export function canonicalEntry(entry: Record<string, unknown>): string {
  const { digest: _ignored, ...sealed } = entry;
  return canonicalStringify(sealed);
}

export const sealEntry = <T extends Record<string, unknown>>(entry: T): T & { digest: string } => ({ ...entry, digest: sha256Hex(canonicalEntry(entry)) });

export function verifyEntry(entry: Record<string, unknown>): { id: unknown; ok: boolean; claimed: unknown; recomputed: string } {
  const recomputed = sha256Hex(canonicalEntry(entry));
  return { id: entry.id, ok: recomputed === entry.digest, claimed: entry.digest, recomputed };
}

// ── Deriving ────────────────────────────────────────────────────────────────

export const PREFIX_KINDS: Record<string, ShipKind> = {
  feat: 'feature', feature: 'feature',
  fix: 'fix', bugfix: 'fix', hotfix: 'fix',
  security: 'security', sec: 'security',
  perf: 'perf', performance: 'perf',
  docs: 'docs', doc: 'docs',
  ci: 'infra', build: 'infra', chore: 'infra', infra: 'infra', deps: 'infra', refactor: 'infra', test: 'infra',
  spec: 'spec', rfc: 'spec',
  release: 'release',
};
const HEADER_RE = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i;
const CLOSES_RE = /(?:closes|closed|fixes|backlog:)\s+(backlog\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/gi;
const PR_RE = /#(\d+)/;
const INTEGRATION_MERGE_RE = /^merge (remote-tracking )?branch\b/i;
const PR_MERGE_RE = /^merge pull request #\d+/i;

export const isIntegrationMerge = (subject: string | undefined): boolean => INTEGRATION_MERGE_RE.test((subject ?? '').trim());
export const isPullRequestMerge = (subject: string | undefined): boolean => PR_MERGE_RE.test((subject ?? '').trim());

/** `Phase 3: gate mesh reporting` - the verb is on the far side of the colon. Capped so a sentence with a colon is not a prefix. */
export const withoutPrefix = (subject: string | undefined): string => {
  const m = /^[^:]{1,28}:\s*(.+)$/.exec((subject ?? '').trim());
  return m ? m[1]! : (subject ?? '').trim();
};

/** The one mechanism that involves no reading between lines: a `kind: <kind>` trailer in the body. */
export function parseKindTrailer(body: string | undefined): ShipKind | undefined {
  const m = /^[ \t]*kind:[ \t]*([a-z]+)[ \t]*$/im.exec(body ?? '');
  const kind = m?.[1]?.toLowerCase();
  return kind && (SHIP_KINDS as readonly string[]).includes(kind) ? (kind as ShipKind) : undefined;
}

/** Opt-in: a repository that declares no lexicon still gets `other`. Ambiguous verbs sit in infra. */
export const IMPERATIVE_LEXICON: Record<string, string[]> = {
  feature: 'add publish serve build give advertise join emit declare introduce create ship launch enable expose offer open adopt record show render surface teach let count answer ask send anchor fold bring merge take land start seed scaffold port promote unify consolidate stand match catch close reject refuse deny report state audit review'.split(' '),
  fix: 'fix stop repair correct prevent unbreak resolve restore guard back revert'.split(' '),
  docs: 'document write explain describe clarify note spell say recommend brief'.split(' '),
  infra: 'update bump pin move rename remove delete refactor split extract tidy drop migrate upgrade gate link point align sync make put wire carry name replace switch keep hold set use run retire require derive reconcile scope harden turn rebuild rearchitect return redeploy trigger commit route repoint absorb shuffle rank exit prune trim tighten raise lower skip allow accept rewrite revise refresh rework initial'.split(' '),
  spec: 'specify define standardise standardize'.split(' '),
  release: 'release cut tag version'.split(' '),
};

export type Lexicon = Map<string, ShipKind>;

export function buildLexicon(declared: Record<string, string[]> | undefined): Lexicon {
  const out: Lexicon = new Map();
  for (const [kind, verbs] of Object.entries(declared ?? {})) {
    if (!(SHIP_KINDS as readonly string[]).includes(kind)) continue;
    for (const verb of verbs) {
      const clean = String(verb).trim().toLowerCase();
      if (clean && !out.has(clean)) out.set(clean, kind as ShipKind);
    }
  }
  return out;
}

const leadingVerb = (text: string | undefined): string => (text ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';

export interface ParsedSubject {
  kind: ShipKind;
  title: string;
  breaking: boolean;
}

export function parseSubject(subject: string | undefined, lexicon?: Lexicon): ParsedSubject {
  const trimmed = (subject ?? '').trim();
  const match = HEADER_RE.exec(trimmed);
  if (match) {
    const [, type, scope, bang, rest] = match;
    const known = PREFIX_KINDS[type!.toLowerCase()];
    if (known) {
      const scoped = scope?.slice(1, -1).toLowerCase();
      return { kind: scoped && PREFIX_KINDS[scoped] === 'release' ? 'release' : known, title: rest!.trim(), breaking: bang === '!' };
    }
  }
  if (lexicon?.size) {
    for (const candidate of [trimmed, withoutPrefix(trimmed)]) {
      const kind = lexicon.get(leadingVerb(candidate));
      if (kind) return { kind, title: trimmed, breaking: false };
    }
  }
  return { kind: 'other', title: trimmed, breaking: false };
}

export function parseCloses(message: string | undefined): string[] {
  return [...new Set([...(message ?? '').matchAll(CLOSES_RE)].map((m) => m[1]!))];
}

export interface Commit {
  sha: string;
  at: string;
  authorEmail: string;
  subject: string;
  body?: string;
  coAuthorEmails?: string[];
}

/** Parses the output of `git log --pretty=format:GIT_LOG_FORMAT`. */
export function parseGitLog(raw: string): Commit[] {
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', at = '', authorEmail = '', subject = '', body = ''] = record.split('\x1f');
      const coAuthorEmails = [...body.matchAll(/co-authored-by:[^<]*<([^>]+)>/gi)].map((m) => m[1]!);
      const commit: Commit = { sha, at, authorEmail, subject };
      if (body.trim()) commit.body = body.trim();
      if (coAuthorEmails.length) commit.coAuthorEmails = coAuthorEmails;
      return commit;
    })
    .filter((c) => c.sha && c.at);
}

/** An address this format does not recognise is attributed to nobody in particular, never to a person. */
export const UNATTRIBUTED_AGENT = 'agent/unattributed';

const MACHINE_LOCAL_PARTS = new Set([
  'actions', 'github-actions', 'dependabot', 'renovate', 'shiplog', 'backlog', 'intent', 'notary', 'liveness',
  'pulse', 'delivery', 'directory', 'ritual',
]);

/** An address that belongs to a machine rather than a person: a fixed list and GitHub's own `[bot]@` marker, not a heuristic. */
export function isMachineAddress(email: string): boolean {
  const address = String(email).toLowerCase().trim();
  if (address === 'noreply@anthropic.com') return true;
  if (address.includes('[bot]@')) return true;
  return MACHINE_LOCAL_PARTS.has(address.split('@')[0] ?? '');
}

/** Subjects the formats' own workflows commit under when refreshing a generated file. Not work. */
export const BOOKKEEPING_SUBJECTS = [
  'shipped/1: refresh the log',
  'backlog/1: refresh the fragment',
  'directory/1: refresh the fragment',
  'delivery/1: what the fetch found',
  'intent/1: refresh the fragment',
  'ritual/1: observe the office',
  'pulse/1: read the estate',
  'notary/1: fold source fragments into the log',
] as const;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The lookahead keeps the guarantee: a subject that merely CONTINUES the phrase ("refresh the logic") is a person's commit.
const BOOKKEEPING_RE = new RegExp(`^(${BOOKKEEPING_SUBJECTS.map(escapeRe).join('|')})(?![a-z])`);

/** Dated subjects FlashyOS's own scheduled jobs commit under: a prefix AND a date stamp. */
export const AUTOMATION_SUBJECTS = ['Adoption signal: ', 'Registry: re-verified ', 'Estate graph: reassembled ', 'Estate record: merged ', 'scoreboard: the estate, read '] as const;
const AUTOMATION_RE = new RegExp(`^(${AUTOMATION_SUBJECTS.map(escapeRe).join('|')})20\\d\\d-\\d\\d-\\d\\d\\b`);

export const isOwnBookkeeping = (subject: string | undefined): boolean => {
  const s = (subject ?? '').trim();
  return BOOKKEEPING_RE.test(s) || AUTOMATION_RE.test(s);
};

/** `.shiplog/config.json`, plus the per-run inputs (`kinds`, `held`) the CLI reads beside it. */
export interface ShiplogConfig {
  /** `repo/<name>` - the fragment's source and every entry's repo. */
  source: string;
  /** `org/<slug>` */
  org: string;
  /** `agent/<slug>` - the machine that seals each entry. */
  assertedBy: string;
  /** `person/<slug>` - a fallback for a PERSON whose address is not in `authors` yet; machines never reach it. */
  defaultAuthor: string;
  /** email (lowercase) → person/ or agent/ id. */
  authors?: Record<string, string>;
  /** Default `private`: making the log public is a decision somebody takes. */
  visibility?: Visibility;
  /** 'imperative' for the built-in lexicon, or your own kind → verbs. */
  lexicon?: 'imperative' | Record<string, string[]>;
  /** `https://github.com/<org>/<repo>/pull/` */
  prBase?: string;
  /** `https://github.com/<org>/<repo>/commit/`; derived from prBase when absent. */
  commitBase?: string;
  /** sha (full or 12) → kind: a person's recorded decision, most authoritative. */
  kinds?: Record<string, string>;
  /** sha (full or 12) → reason: held private whatever the default. */
  held?: Record<string, string>;
  /** YYYY-MM-DD; default today (UTC). */
  asserted?: string;
  keepIntegrationMerges?: boolean;
  serve?: string | string[];
  serveDevlog?: string | string[];
  devlogTitle?: string;
}

export interface Derivation {
  entries: ShippedEntry[];
  /** Author emails not in `authors`, sorted - add them to the config. */
  unmapped: string[];
  /** [sha12, kind] pairs whose recorded decision names a kind this format does not have. */
  badKinds: [string, string][];
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** Commits → sealed entries. Precedence for kind: a recorded decision, the author's trailer, then the subject. */
export function fromCommits(commits: Commit[], options: ShiplogConfig): Derivation {
  const repoSlug = options.source.replace(/^repo\//, '');
  const asserted = options.asserted ?? today();
  const authors = options.authors ?? {};
  const unmapped = new Set<string>();
  const lexicon = options.lexicon ? buildLexicon(options.lexicon === 'imperative' ? IMPERATIVE_LEXICON : options.lexicon) : undefined;
  const declaredKinds = options.kinds ?? {};
  const badKinds = new Map<string, string>();
  const held = options.held ?? {};
  const nodeFor = (email: string): string => {
    const mapped = authors[email.toLowerCase()];
    if (mapped) return mapped;
    unmapped.add(email);
    // Human/agent attribution is the number this record exists to make checkable:
    // wrong in the safe direction (an unnamed agent) costs a config entry.
    return isMachineAddress(email) ? UNATTRIBUTED_AGENT : options.defaultAuthor;
  };

  const shipped = options.keepIntegrationMerges ? commits : commits.filter((c) => !isIntegrationMerge(c.subject) && !isOwnBookkeeping(c.subject));

  const entries = shipped.map((commit) => {
    const message = `${commit.subject}\n${commit.body ?? ''}`;
    const inferred = parseSubject(commit.subject, lexicon);
    const overridden = declaredKinds[commit.sha] ?? declaredKinds[commit.sha.slice(0, 12)];
    if (overridden !== undefined && !(SHIP_KINDS as readonly string[]).includes(overridden)) badKinds.set(commit.sha.slice(0, 12), overridden);
    const declared = overridden !== undefined && (SHIP_KINDS as readonly string[]).includes(overridden) ? (overridden as ShipKind) : undefined;
    const kind = declared ?? parseKindTrailer(commit.body) ?? inferred.kind;
    const { title, breaking } = inferred;
    const by = [...new Set([commit.authorEmail, ...(commit.coAuthorEmails ?? [])].filter(Boolean).map(nodeFor))];
    const isHeld = Boolean(held[commit.sha] || held[commit.sha.slice(0, 12)]);
    const entry: ShippedEntryUnsealed = {
      id: `ship/${repoSlug}/${commit.sha.slice(0, 12).toLowerCase()}`,
      repo: options.source,
      at: commit.at,
      kind,
      title: (breaking ? `${title} (breaking)` : title).slice(0, 140),
      by: by.length ? by : [options.defaultAuthor],
      asserted,
      assertedBy: options.assertedBy,
      visibility: isHeld ? 'private' : (options.visibility ?? 'private'),
    };
    const detail = (commit.body ?? '').trim();
    if (detail) entry.detail = detail.slice(0, 2000);
    const refs: ShippedRefs = { commit: commit.sha.toLowerCase() };
    const pr = options.prBase ? PR_RE.exec(commit.subject) : null;
    if (pr) refs.pr = `${options.prBase}${pr[1]}`;
    entry.refs = refs;
    const closes = parseCloses(message);
    if (closes.length) entry.closes = closes;
    return sealEntry(entry as unknown as Record<string, unknown>) as unknown as ShippedEntry;
  });

  return { entries, unmapped: [...unmapped].sort(), badKinds: [...badKinds] };
}

/** Raw `git log` output (GIT_LOG_FORMAT) → sealed entries. */
export const shippedFromGitLog = (raw: string, config: ShiplogConfig): Derivation => fromCommits(parseGitLog(raw), config);

/** Existing entries win over freshly derived ones of the same id (they are sealed); only new ids are added. Newest first. */
export function mergeEntries(existing: ShippedEntry[], derived: ShippedEntry[]): ShippedEntry[] {
  const byId = new Map<string, ShippedEntry>();
  for (const entry of derived) byId.set(entry.id, entry);
  for (const entry of existing) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** The public tier only, with the hold applied a second time (a served path carrying private entries is a disclosure with a URL). */
export const publicShippedView = (entries: ShippedEntry[], held: Record<string, string> = {}): ShippedEntry[] =>
  entries.filter((e) => {
    if (e?.visibility !== 'public') return false;
    // The sha is read from the entry (`refs.commit`, or a bare `sha`), or resolved from the id -
    // an id's last segment is the twelve-character sha. A hold may be written either way.
    const shas = [(e as unknown as { sha?: string }).sha, e.refs?.commit, String(e.id ?? '').split('/').pop()].filter((s): s is string => Boolean(s));
    return !shas.some((sha) => held[sha] || held[sha.slice(0, 12)]);
  });

export const shippedFragment = (config: Pick<ShiplogConfig, 'source' | 'org'>, entries: ShippedEntry[], generated = new Date().toISOString()): ShippedFragment => ({
  shipped: '1',
  source: config.source,
  org: config.org,
  generated,
  entries,
});

// ── devlog/1 ────────────────────────────────────────────────────────────────

const SKIP_MARKER_RE = /\[(skip ci|vercel skip)\]/i;
const MAX_SUMMARY = 280;

/** Stricter than the ship rule: a machine's commit is dropped outright, a devlog has no field to file it under. */
export function isDevlogWorthy(commit: Commit): boolean {
  if (isIntegrationMerge(commit.subject)) return false;
  if (isOwnBookkeeping(commit.subject)) return false;
  if (SKIP_MARKER_RE.test(commit.subject ?? '')) return false;
  if (isMachineAddress(commit.authorEmail)) return false;
  return true;
}

export function summaryFromSubject(subject: string | undefined): string {
  const { title } = parseSubject(subject);
  const trimmed = (title || subject || '').trim();
  if (!trimmed) return trimmed;
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return capitalised.length > MAX_SUMMARY ? capitalised.slice(0, MAX_SUMMARY) : capitalised;
}

/** `commitBase`, or one derived from a GitHub-shaped `prBase` for free. */
export function commitBaseFrom(config: Pick<ShiplogConfig, 'prBase' | 'commitBase'>): string | undefined {
  if (config.commitBase) return config.commitBase;
  const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/$/.exec(config.prBase ?? '');
  return match ? `${match[1]}/commit/` : undefined;
}

export function devlogFromCommits(commits: Commit[], options: { source: string; commitBase?: string; held?: Record<string, string> }): DevlogEntry[] {
  const repoSlug = options.source.replace(/^repo\//, '');
  const held = options.held ?? {};
  return commits
    .filter((c) => isDevlogWorthy(c) && !held[c.sha] && !held[c.sha.slice(0, 12)])
    .map((commit) => {
      const sha = commit.sha.toLowerCase();
      const short = sha.slice(0, 12);
      const ref = options.commitBase ? `${options.commitBase}${sha}` : `${options.source}#${short}`;
      return { id: `devlog/${repoSlug}/${short}`, at: commit.at, summary: summaryFromSubject(commit.subject), commitSha: sha, ref };
    })
    .filter((e) => e.summary.length > 0);
}

export const devlogFromGitLog = (raw: string, config: ShiplogConfig): DevlogEntry[] =>
  devlogFromCommits(parseGitLog(raw), { source: config.source, commitBase: commitBaseFrom(config), held: config.held });

export const byDevlogRecency = (a: DevlogEntry, b: DevlogEntry): number => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1);

export function mergeDevlogEntries(existing: DevlogEntry[], derived: DevlogEntry[]): DevlogEntry[] {
  const byId = new Map<string, DevlogEntry>();
  for (const entry of derived) byId.set(entry.id, entry);
  for (const entry of existing) byId.set(entry.id, entry);
  return [...byId.values()].sort(byDevlogRecency);
}

export const devlogFragment = (config: Pick<ShiplogConfig, 'source' | 'org'>, entries: DevlogEntry[], generated = new Date().toISOString()): DevlogFragment => ({
  devlog: '1',
  source: config.source,
  org: config.org,
  generated,
  entries,
});

export function renderDevlogMarkdown(entries: DevlogEntry[], options: { title?: string } = {}): string {
  const title = options.title ?? 'Devlog';
  const sorted = [...entries].sort(byDevlogRecency);
  const lines = [`# ${title}`, '', '_This is the changelog. "Devlog" and "changelog" name the same document here._', ''];
  if (!sorted.length) {
    lines.push('Nothing shipped yet.', '');
    return lines.join('\n');
  }
  let day = '';
  for (const entry of sorted) {
    const d = entry.at.slice(0, 10);
    if (d !== day) {
      if (day) lines.push('');
      day = d;
      lines.push(`## ${day}`, '');
    }
    lines.push(`- ${entry.summary} ([\`${entry.commitSha.slice(0, 12)}\`](${entry.ref}))`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── Validating (ours) ───────────────────────────────────────────────────────

const SHIP_ID_RE = /^ship\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const DEVLOG_ID_RE = /^devlog\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const repoOfId = (id: string): string | undefined => {
  const parts = id.split('/');
  return parts.length === 3 ? `repo/${parts[1]}` : undefined;
};

/** Every problem in a shipped/1 fragment: shape, ids, provenance and every seal recomputed. */
export function validateShipped(fragment: unknown): Finding[] {
  const out = new Collector();
  const bad = (code: string, at: string, message: string): void => out.bad(code, at, message);
  if (!isRecord(fragment)) {
    bad('not-an-object', '', 'a fragment is a JSON object');
    return out.findings;
  }
  const f = fragment;
  if (f.shipped !== SHIPPED_VERSION) bad('bad-version', '', `fragment declares shipped "${String(f.shipped)}"`);
  if (!REPO_ID_RE.test(asString(f.source))) bad('bad-fragment-source', '', `source "${String(f.source)}" is not a repo/<name> id`);
  if (!ORG_ID_RE.test(asString(f.org))) bad('bad-fragment-org', '', `org "${String(f.org)}" is not an org/<slug> id`);
  if (!isIsoDateTime(f.generated)) bad('bad-generated', '', `generated "${String(f.generated)}" is not a timestamp`);
  if (!Array.isArray(f.entries)) {
    bad('no-entries', '', 'a fragment carries a list of entries');
    return out.findings;
  }
  const seen = new Set<string>();
  for (const raw of f.entries) {
    if (!isRecord(raw)) {
      bad('not-an-entry', '', 'an entry is a JSON object');
      continue;
    }
    const e = raw;
    const at = asString(e.id) || '(no id)';
    if (!SHIP_ID_RE.test(asString(e.id))) bad('bad-id', at, 'id is not ship/<repo>/<sha>');
    else {
      if (seen.has(at)) bad('duplicate-id', at, 'id emitted twice');
      seen.add(at);
      const owning = repoOfId(at);
      if (owning && owning !== f.source) bad('foreign-entry', at, `entry belongs to ${owning}, fragment is ${String(f.source)}`);
    }
    if (e.repo !== f.source) bad('bad-repo', at, `repo "${String(e.repo)}" is not the fragment's source`);
    if (!isIsoDateTime(e.at)) bad('bad-at', at, `at "${String(e.at)}" is not a timestamp`);
    if (!(SHIP_KINDS as readonly string[]).includes(asString(e.kind))) bad('bad-kind', at, `unknown kind "${String(e.kind)}"`);
    if (!asString(e.title).trim()) bad('no-title', at, 'entry has no title');
    else if (asString(e.title).length > 140) bad('title-too-long', at, 'a title is at most 140 characters');
    if (e.detail !== undefined && (typeof e.detail !== 'string' || e.detail.length > 2000)) bad('detail-too-long', at, 'detail is a string of at most 2000 characters');
    if (!Array.isArray(e.by) || !e.by.length || !e.by.every((b) => NODE_ID_RE.test(asString(b)))) bad('bad-by', at, 'by is a non-empty list of person/ and agent/ ids');
    if (!DATE_RE.test(asString(e.asserted))) bad('bad-asserted', at, `asserted "${String(e.asserted)}" is not a date`);
    if (!NODE_ID_RE.test(asString(e.assertedBy))) bad('no-asserter', at, 'every entry names who sealed it');
    if (!isVisibility(e.visibility)) bad('bad-visibility', at, `unknown visibility "${String(e.visibility)}"`);
    if (e.refs !== undefined && (!isRecord(e.refs) || typeof e.refs.commit !== 'string')) bad('bad-refs', at, 'refs carries the commit sha');
    if (e.closes !== undefined && (!Array.isArray(e.closes) || !e.closes.every((c) => typeof c === 'string' && c.startsWith('backlog/')))) bad('bad-closes', at, 'closes is a list of backlog/ ids');
    if (!HEX64_RE.test(asString(e.digest))) bad('bad-digest', at, 'digest is not a sha256 hex');
    else if (!verifyEntry(e).ok) bad('broken-seal', at, `digest does not match the entry's canonical bytes`);
  }
  return out.findings;
}

/** Every problem in a devlog/1 fragment. */
export function validateDevlog(fragment: unknown): Finding[] {
  const out = new Collector();
  const bad = (code: string, at: string, message: string): void => out.bad(code, at, message);
  if (!isRecord(fragment)) {
    bad('not-an-object', '', 'a fragment is a JSON object');
    return out.findings;
  }
  const f = fragment;
  if (f.devlog !== DEVLOG_VERSION) bad('bad-version', '', `fragment declares devlog "${String(f.devlog)}"`);
  if (!REPO_ID_RE.test(asString(f.source))) bad('bad-fragment-source', '', `source "${String(f.source)}" is not a repo/<name> id`);
  if (!ORG_ID_RE.test(asString(f.org))) bad('bad-fragment-org', '', `org "${String(f.org)}" is not an org/<slug> id`);
  if (!isIsoDateTime(f.generated)) bad('bad-generated', '', `generated "${String(f.generated)}" is not a timestamp`);
  if (!Array.isArray(f.entries)) {
    bad('no-entries', '', 'a fragment carries a list of entries');
    return out.findings;
  }
  const seen = new Set<string>();
  for (const raw of f.entries) {
    const e = isRecord(raw) ? raw : {};
    const at = asString(e.id) || '(no id)';
    if (!DEVLOG_ID_RE.test(asString(e.id))) bad('bad-id', at, 'id is not devlog/<repo>/<sha>');
    else if (seen.has(at)) bad('duplicate-id', at, 'id emitted twice');
    seen.add(at);
    if (!isIsoDateTime(e.at)) bad('bad-at', at, `at "${String(e.at)}" is not a timestamp`);
    if (!asString(e.summary).trim()) bad('no-summary', at, 'entry has no summary');
    else if (asString(e.summary).length > MAX_SUMMARY) bad('summary-too-long', at, `a summary is at most ${MAX_SUMMARY} characters`);
    if (!/^[0-9a-f]{7,64}$/.test(asString(e.commitSha))) bad('bad-commit', at, 'commitSha is a lowercase hex sha');
    if (!asString(e.ref)) bad('no-ref', at, 'entry has no ref');
  }
  return out.findings;
}
