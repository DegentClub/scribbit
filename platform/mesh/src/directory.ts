// directory/0.1 - the fragment of the federated estate graph a repository publishes.
//
// `validateDirectory` reproduces FlashyLabs' vendored check-directory.mjs rule for
// rule (kinds and prefixes, edge types and their required fields, provenance,
// contested definitions, the no-accountable-human rule, externals resolution,
// deterministic ordering). `directoryFromCharter` mirrors scripts/directory.mjs:
// everything the organisation and its roles imply is read from the charter, so the
// charter and the fragment cannot disagree.
import { type Charter, defaultRepository } from './charter.ts';
import { asArray, asString, Collector, DATE_RE, type Finding, isRecord, isVisibility, NODE_ID_RE, type Visibility } from './common.ts';

export const DIRECTORY_VERSION = '0.1';
export const DIRECTORY_FRAGMENT_PATH = '/directory.fragment.json';

/** Node kinds and the id prefix each requires. */
export const NODE_KINDS = {
  Organization: 'org',
  Person: 'person',
  Agent: 'agent',
  Property: 'prop',
  Place: 'place',
  Event: 'event',
  Standard: 'std',
  Credential: 'cred',
  Claim: 'claim',
  Instrument: 'inst',
  Transaction: 'txn',
  Work: 'work',
  Source: 'src',
} as const;
export type NodeKind = keyof typeof NODE_KINDS;

export const EDGE_TYPES = [
  'owns', 'holds', 'operates', 'accountableFor', 'declares', 'delegatedTo',
  'defines', 'cites', 'convenes', 'spokeAt', 'issued', 'settled', 'supersededBy',
  'publishes', 'engaged', 'controls', 'dependsOn',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** What each edge type must carry beyond the provenance envelope (a mirror of @flashyos/directory's EDGE_REQUIRES). */
export const EDGE_REQUIRES: Record<EdgeType, readonly string[]> = {
  owns: ['pct', 'instrument', 'since'],
  engaged: ['basis', 'since'],
  dependsOn: ['range'],
  controls: ['basis', 'since'],
  holds: [],
  operates: [],
  accountableFor: [],
  declares: [],
  delegatedTo: ['scope'],
  defines: [],
  cites: [],
  convenes: [],
  spokeAt: ['year'],
  issued: ['date'],
  settled: ['sealed', 'capability'],
  publishes: [],
  supersededBy: ['reason'],
};

/** Required only when the target carries this prefix: a `declares` edge naming an agent carries the role. */
export const EDGE_REQUIRED_WHEN_TO: Partial<Record<EdgeType, Record<string, readonly string[]>>> = { declares: { agent: ['role'] } };

/** The provenance envelope every node and edge carries. */
export interface Provenance {
  /** YYYY-MM-DD */
  asserted: string;
  /** A node id: who made the assertion. */
  assertedBy: string;
  /** YYYY-MM-DD, after `asserted`. */
  expires: string;
  visibility: Visibility;
}

export interface DirectoryNode extends Provenance {
  /** `<prefix>/<slug>`, prefix fixed by `kind`. */
  id: string;
  kind: NodeKind;
  name: string;
  description?: string;
  url?: string;
  [extra: string]: unknown;
}

export interface DirectoryEdge extends Provenance {
  type: EdgeType;
  from: string;
  to: string;
  role?: string;
  scope?: string[];
  pct?: number;
  qty?: number;
  unit?: string;
  since?: string;
  basis?: string;
  range?: string;
  year?: number;
  date?: string;
  sealed?: unknown;
  capability?: string;
  reason?: string;
  instrument?: string;
  [extra: string]: unknown;
}

export interface DirectoryFragment {
  directory: '0.1';
  /** `repo/<name>`: who emitted it. */
  source: string;
  /** YYYY-MM-DD */
  generated: string;
  nodes: DirectoryNode[];
  edges: DirectoryEdge[];
}

/** `directory.externals.json`: ids the fragment references and another repository is the authority for. */
export interface DirectoryExternals {
  '//'?: string;
  ids: string[];
}

export const edgeKey = (e: { from?: unknown; type?: unknown; to?: unknown }): string => `${String(e.from)}·${String(e.type)}·${String(e.to)}`;

const EDGE_SET = new Set<string>(EDGE_TYPES);

/** The required fields an edge is missing (empty string, null and undefined all count as missing). */
export function missingRequired(e: Record<string, unknown>): string[] {
  const type = asString(e.type) as EdgeType;
  const prefix = asString(e.to).split('/')[0] ?? '';
  return [...(EDGE_REQUIRES[type] ?? []), ...(EDGE_REQUIRED_WHEN_TO[type]?.[prefix] ?? [])].filter((k) => e[k] === undefined || e[k] === null || e[k] === '');
}

/**
 * Every problem in a fragment. `externals` are ids the fragment may reference but not
 * define, because another repository is the authority for them; anything else must
 * resolve locally. Codes are check-directory.mjs's own.
 */
export function validateDirectory(fragment: unknown, externals: Iterable<string> = []): Finding[] {
  const out = new Collector();
  const bad = (code: string, subject: string, message: string): void => out.bad(code, subject, message);
  if (!isRecord(fragment)) {
    bad('not-an-object', '', 'a fragment is a JSON object');
    return out.findings;
  }
  const f = fragment;
  const ext = new Set(externals);

  if (f.directory !== DIRECTORY_VERSION) bad('bad-version', '', `fragment declares directory "${String(f.directory)}"`);
  if (!asString(f.source).trim()) bad('no-source', '', 'fragment does not say who emitted it');
  if (!DATE_RE.test(asString(f.generated))) bad('bad-generated', '', `generated "${String(f.generated)}" is not a date`);

  const provenance = (r: Record<string, unknown>, at: string): void => {
    const asserted = asString(r.asserted);
    const expires = asString(r.expires);
    if (!DATE_RE.test(asserted)) bad('bad-asserted', at, `asserted "${String(r.asserted)}" is not a date`);
    if (!DATE_RE.test(expires)) bad('bad-expires', at, `expires "${String(r.expires)}" is not a date`);
    if (DATE_RE.test(asserted) && DATE_RE.test(expires) && expires <= asserted)
      bad('expires-before-asserted', at, `expires ${expires} is not after asserted ${asserted}`);
    if (!NODE_ID_RE.test(asString(r.assertedBy))) bad('no-asserter', at, 'every assertion names who made it');
    if (!isVisibility(r.visibility)) bad('bad-visibility', at, `unknown visibility "${String(r.visibility)}"`);
  };

  const ids = new Set<unknown>();
  const nodes = asArray(f.nodes).map((n) => (isRecord(n) ? n : {}));
  for (const n of nodes) {
    const at = asString(n.id) || '(no id)';
    if (ids.has(n.id)) bad('duplicate-id', at, 'id emitted twice');
    ids.add(n.id);
    const id = asString(n.id);
    if (!NODE_ID_RE.test(id)) bad('bad-id', at, 'id is not prefix/slug');
    const prefix = NODE_KINDS[asString(n.kind) as NodeKind] as string | undefined;
    if (!prefix) bad('bad-kind', at, `unknown kind "${String(n.kind)}"`);
    else if (id && prefix !== id.split('/')[0]) bad('prefix-mismatch', at, `kind ${String(n.kind)} requires prefix "${prefix}/"`);
    if (!asString(n.name).trim()) bad('no-name', at, 'node has no name');
    provenance(n, at);
  }

  const defined = new Map<unknown, unknown>();
  const accountable = new Set<unknown>();
  for (const raw of asArray(f.edges)) {
    const e = isRecord(raw) ? raw : {};
    const at = edgeKey(e);
    if (!EDGE_SET.has(asString(e.type))) bad('bad-edge-type', at, `unknown edge type "${String(e.type)}"`);
    for (const end of ['from', 'to'] as const) {
      const v = e[end];
      if (!NODE_ID_RE.test(asString(v))) {
        bad('bad-endpoint', at, `${end} "${String(v)}" is not an id`);
        continue;
      }
      if (!ids.has(v) && !ext.has(v as string))
        bad('unresolved-endpoint', at, `${end} "${String(v)}" is neither emitted here nor declared external`);
    }
    provenance(e, at);
    if (e.type === 'defines') {
      if (defined.has(e.to)) bad('contested-claim', asString(e.to), `${String(defined.get(e.to))} and ${String(e.from)} both define it`);
      defined.set(e.to, e.from);
    }
    if (e.type === 'accountableFor') accountable.add(e.to);
    for (const k of missingRequired(e)) bad(`${String(e.type)}-no-${k}`, at, `${String(e.type)} requires ${k}`);
    if (e.type === 'owns') {
      if (e.pct !== undefined && (typeof e.pct !== 'number' || e.pct <= 0 || e.pct > 100)) bad('owns-bad-pct', at, 'owns requires pct in (0,100]');
      if (e.visibility === 'public') bad('owns-public', at, 'ownership is public — confirm this is deliberate');
    }
    if (e.type === 'controls') {
      if (e.pct !== undefined) bad('controls-has-pct', at, 'controls never carries a percentage — a caller disclosing a quantum wants owns');
      if (e.visibility !== 'public') bad('controls-not-public', at, 'controls is public by design; a private control claim is an assertion nobody can check');
    }
    if (e.type === 'holds' && (typeof e.qty !== 'number' || !e.unit)) bad('holds-no-qty', at, 'holds requires qty and unit');
  }

  for (const n of nodes)
    if (n.kind === 'Organization' && !accountable.has(n.id)) bad('no-accountable-human', asString(n.id), 'no accountableFor edge — every organisation names a human');

  // Sorted output means two builds of the same data produce no diff.
  const idList = nodes.map((n) => asString(n.id));
  const sorted = [...idList].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(idList) !== JSON.stringify(sorted)) bad('unsorted', '', 'nodes are not sorted by id — the emitter is not deterministic');

  return out.findings;
}

/** One line, the way check-directory.mjs prints it. */
export const directorySummary = (doc: unknown, findings: readonly Finding[]): string => {
  const f = isRecord(doc) ? doc : {};
  return `${asString(f.source) || '(no source)'} — ${asArray(f.nodes).length} nodes · ${asArray(f.edges).length} edges · ${findings.length} problem(s)`;
};

// ── Emitting from the charter ───────────────────────────────────────────────

/**
 * The machine surfaces a property serves, as directory.mjs detects them:
 * [profile, served filename, candidate paths relative to the publishing root].
 * A surface is declared only when one of its candidates is actually on disk -
 * a declared surface that cannot be fetched is a promise with nothing behind it.
 */
export const SURFACE_PATHS: readonly (readonly [profile: string, served: string, candidates: readonly string[]])[] = [
  ['backlog/1', 'backlog.json', ['public/.well-known/backlog.json']],
  ['shipped/1', 'shiplog.json', ['public/.well-known/shiplog.json']],
  ['checkpoint/1', 'checkpoint.json', ['public/.well-known/checkpoint.json']],
  ['flashyos/1', 'flashyos.json', ['public/.well-known/flashyos.json', 'well-known/flashyos.json', 'src/app/.well-known/flashyos.json']],
  ['aao/0.1', 'flashyos-charter.json', ['public/.well-known/flashyos-charter.json', 'src/app/.well-known/flashyos-charter.json']],
];

export const profileSlug = (profile: string): string => profile.replace(/[^a-z0-9]+/g, '-');

/** A machine the organisation operates: the bot that emits and signs one of its records. Not a charter role. */
export interface DirectoryEmitter {
  /** `agent/<slug>` - the id the emitter signs with (read from its config, never derived). */
  id: string;
  name: string;
  description?: string;
  /** The formats it emits, e.g. ['shipped/1']. */
  formats: string[];
}

export interface DirectoryProperty {
  domain: string;
  name: string;
  tenure?: string;
}

export interface DirectoryOptions {
  /** YYYY-MM-DD; also the fragment's `generated`. */
  asserted: string;
  /** YYYY-MM-DD, after `asserted`. */
  expires: string;
  /** `person/<slug>`: the accountable human. Defined by another repository; referenced here (goes into externals). */
  assertedBy: string;
  /** `repo/<name>`; default `repo/<default repository>` else `repo/<slug>`. */
  source?: string;
  platform?: string;
  vertical?: string;
  properties?: DirectoryProperty[];
  emitters?: DirectoryEmitter[];
  /** Paths (relative to the publishing root) that exist on disk, tested against SURFACE_PATHS. */
  served?: string[];
  /** The host a reader fetches surfaces from; default the first property's domain; null = no URL. */
  surfaceHost?: string | null;
  visibility?: Visibility;
}

const cmp = (a: string, b: string): number => a.localeCompare(b);

/** The fragment and its externals, derived from the charter the way directory.mjs derives them. Deterministic. */
export function directoryFromCharter(charter: Charter, opts: DirectoryOptions): { fragment: DirectoryFragment; externals: DirectoryExternals } {
  if (!DATE_RE.test(opts.asserted)) throw new TypeError(`asserted "${opts.asserted}" is not a YYYY-MM-DD date`);
  if (!DATE_RE.test(opts.expires)) throw new TypeError(`expires "${opts.expires}" is not a YYYY-MM-DD date`);
  if (!opts.assertedBy.startsWith('person/')) throw new TypeError(`assertedBy must be a person/<slug> id, got "${opts.assertedBy}"`);
  const BY = opts.assertedBy;
  const repo = defaultRepository(charter);
  const SOURCE = opts.source ?? `repo/${repo?.name ?? charter.slug}`;
  const base: Provenance = { asserted: opts.asserted, assertedBy: BY, expires: opts.expires, visibility: opts.visibility ?? 'public' };
  const nodes: DirectoryNode[] = [];
  const edges: DirectoryEdge[] = [];
  const node = (kind: NodeKind, slug: string, name: string, extra: Record<string, unknown> = {}): string => {
    const id = `${NODE_KINDS[kind]}/${slug}`;
    nodes.push({ ...base, id, kind, name, ...extra });
    return id;
  };
  const edge = (type: EdgeType, from: string, to: string, extra: Record<string, unknown> = {}): void => {
    edges.push({ ...base, type, from, to, ...extra });
  };
  const site: Record<string, unknown> = {};
  if (opts.platform !== undefined) site.platform = opts.platform;
  if (opts.vertical !== undefined) site.vertical = opts.vertical;

  const ORG = node('Organization', charter.slug, charter.name, { description: charter.description, ...site });
  edge('accountableFor', BY, ORG);

  for (const r of charter.roles) {
    const agent = node('Agent', `${charter.slug}-${r.name}`, r.name, { description: r.purpose });
    edge('declares', ORG, agent, { role: r.name, scope: r.capabilities ?? [] });
  }

  // The machines the org operates, and whose authority they act on: operates says the
  // organisation runs the machine; delegatedTo (person → agent, same scope) says who answers.
  for (const m of opts.emitters ?? []) {
    if (!m.id.startsWith('agent/')) throw new TypeError(`emitter id must be an agent/<slug> id, got "${m.id}"`);
    const bot = node('Agent', m.id.slice('agent/'.length), m.name, {
      description: m.description ?? `The machine that emits ${m.formats.join(', ')} for this repository and signs each record as ${m.id}.`,
    });
    edge('operates', ORG, bot, { scope: [...m.formats] });
    edge('delegatedTo', BY, bot, { scope: [...m.formats] });
  }

  for (const p of opts.properties ?? []) {
    const prop = node('Property', p.domain, p.name, { url: `https://${p.domain}`, tenure: p.tenure ?? 'freehold', ...site });
    edge('operates', ORG, prop);
  }

  const served = new Set(opts.served ?? []);
  const host = opts.surfaceHost === undefined ? (opts.properties?.[0]?.domain ?? null) : opts.surfaceHost;
  const surfaceExternals: string[] = [];
  for (const [profile, servedName, candidates] of SURFACE_PATHS) {
    if (!candidates.some((c) => served.has(c))) continue;
    const slug = profileSlug(profile);
    const src = node('Source', `${charter.slug}-${slug}`, `${profile} — ${charter.slug}`, {
      ...(host ? { url: `https://${host}/.well-known/${servedName}` } : {}),
      description: `The ${profile} surface this organisation serves.`,
    });
    edge('declares', ORG, src);
    // A citation, never a definition: serving a standard is not authoring it.
    edge('cites', src, `std/${slug}`);
    surfaceExternals.push(`std/${slug}`);
  }

  const fragment: DirectoryFragment = {
    directory: '0.1',
    source: SOURCE,
    generated: opts.asserted,
    nodes: nodes.sort((a, b) => cmp(a.id, b.id)),
    edges: edges.sort((a, b) => cmp(edgeKey(a), edgeKey(b))),
  };
  const externals: DirectoryExternals = {
    '//': 'Generated by @bsh/mesh emit-directory. Ids this fragment references and another repository is the authority for.',
    ids: [...new Set([...surfaceExternals, BY])].sort(),
  };
  return { fragment, externals };
}
