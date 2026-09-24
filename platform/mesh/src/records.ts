// The records a publishing directory keeps beside its charter: shipped/1 (the sealed
// log), devlog/1 (the changelog beside it) and checkpoint/1 (the head over everything
// sealed). This is the pipeline `mesh emit <dir>` / `mesh check <dir>` run when
// `<dir>/shiplog.config.json` exists; shipped.ts and checkpoint.ts hold the formats.
//
// Layout (relative to the publishing directory):
//   shiplog.config.json                    source: who seals, who the authors are, the lexicon, visibility
//   shiplog.fragment.json                  GENERATED: the whole sealed log, private entries included
//   public/.well-known/shiplog.json        GENERATED: the public projection of the fragment (what is served)
//   public/.well-known/devlog.fragment.json GENERATED: devlog/1
//   public/.well-known/checkpoint.json     GENERATED: checkpoint/1 head over the served shiplog + directory fragment
//   public/.well-known/checkpoint.signed.json  GENERATED only when MESH_CHECKPOINT_KEY names a key: the same head under x-signature
//
// `emit` APPENDS: entries already in the committed fragment are kept byte for byte (they are
// sealed history), only commits not yet in it are derived and sealed. Timestamps are derived,
// not read from the clock (`generated` = the newest entry's `at`, the head's `at` = the
// fragment's `generated`), so two runs over the same inputs are byte-identical and CI can diff.
import { execFileSync } from 'node:child_process';
import { canonicalStringify } from './canonical.ts';
import { canonicalHead, type CheckpointHead, checkpointHead, claimsOf, recomputeCheckpoint, verifyCheckpointHead } from './checkpoint.ts';
import { Collector, DATE_RE, type Finding, isRecord, isVisibility, NODE_ID_RE, ORG_ID_RE, REPO_ID_RE } from './common.ts';
import {
  type DevlogFragment, devlogFragment, devlogFromGitLog, gitLogArgs, mergeDevlogEntries, mergeEntries, publicShippedView, SHIP_KINDS, type ShiplogConfig, type ShippedEntry,
  type ShippedFragment, shippedFragment, shippedFromGitLog, validateDevlog, validateShipped,
} from './shipped.ts';

export const RECORD_PATHS = {
  config: 'shiplog.config.json',
  fragment: 'shiplog.fragment.json',
  shiplog: 'public/.well-known/shiplog.json',
  devlog: 'public/.well-known/devlog.fragment.json',
  checkpoint: 'public/.well-known/checkpoint.json',
  checkpointSigned: 'public/.well-known/checkpoint.signed.json',
} as const;

/** The environment variable naming the Ed25519 private key (PKCS#8 PEM) that signs the head. Never a key, never committed. */
export const CHECKPOINT_KEY_ENV = 'MESH_CHECKPOINT_KEY';

/** `shiplog.config.json`: a ShiplogConfig plus what the checkpoint and the git run need. */
export interface RecordsConfig extends ShiplogConfig {
  /** The head's `origin` (`repo/<name>` or the site URL); default `source`. */
  origin?: string;
  /** The revision `git log --first-parent` walks; default HEAD. */
  rev?: string;
}

const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');

/** The config as written, checked field by field. Throws TypeError with the field named. */
export function readRecordsConfig(doc: unknown): RecordsConfig {
  if (!isRecord(doc)) throw new TypeError('shiplog.config.json is a JSON object');
  const c = doc;
  const str = (k: string, re?: RegExp, what?: string): string => {
    const v = c[k];
    if (typeof v !== 'string' || (re && !re.test(v))) throw new TypeError(`shiplog.config.json needs "${k}"${what ? ` (${what})` : ''}`);
    return v;
  };
  const config: RecordsConfig = {
    source: str('source', REPO_ID_RE, 'repo/<name>'),
    org: str('org', ORG_ID_RE, 'org/<slug>'),
    assertedBy: str('assertedBy', NODE_ID_RE, 'agent/<slug> or person/<slug>'),
    defaultAuthor: str('defaultAuthor', /^person\/[a-z0-9][a-z0-9._-]*$/, 'person/<slug>'),
  };
  if (c.authors !== undefined) {
    if (!isStringMap(c.authors) || !Object.values(c.authors).every((id) => NODE_ID_RE.test(id))) throw new TypeError('shiplog.config.json "authors" maps email → person/ or agent/ id');
    config.authors = Object.fromEntries(Object.entries(c.authors).map(([email, id]) => [email.toLowerCase(), id]));
  }
  if (c.visibility !== undefined) {
    if (!isVisibility(c.visibility)) throw new TypeError('shiplog.config.json "visibility" is public, partner or private');
    config.visibility = c.visibility;
  }
  if (c.lexicon !== undefined) {
    const ok = c.lexicon === 'imperative' || (isRecord(c.lexicon) && Object.entries(c.lexicon).every(([k, v]) => (SHIP_KINDS as readonly string[]).includes(k) && Array.isArray(v) && v.every((w) => typeof w === 'string')));
    if (!ok) throw new TypeError('shiplog.config.json "lexicon" is "imperative" or a map of kind → words');
    config.lexicon = c.lexicon as RecordsConfig['lexicon'];
  }
  for (const k of ['prBase', 'commitBase', 'origin', 'rev'] as const) {
    if (c[k] === undefined) continue;
    if (typeof c[k] !== 'string' || !c[k]) throw new TypeError(`shiplog.config.json "${k}" is a string`);
    config[k] = c[k] as string;
  }
  for (const k of ['kinds', 'held'] as const) {
    if (c[k] === undefined) continue;
    if (!isStringMap(c[k])) throw new TypeError(`shiplog.config.json "${k}" maps sha → string`);
    config[k] = c[k] as Record<string, string>;
  }
  if (c.asserted !== undefined) {
    if (typeof c.asserted !== 'string' || !DATE_RE.test(c.asserted)) throw new TypeError('shiplog.config.json "asserted" is YYYY-MM-DD');
    config.asserted = c.asserted;
  }
  if (c.keepIntegrationMerges !== undefined) {
    if (typeof c.keepIntegrationMerges !== 'boolean') throw new TypeError('shiplog.config.json "keepIntegrationMerges" is a boolean');
    config.keepIntegrationMerges = c.keepIntegrationMerges;
  }
  return config;
}

// ── git ─────────────────────────────────────────────────────────────────────

/** The repository root that contains `dir` (git's own answer), or `dir` when git says it is not a repository. */
export function repoRootOf(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || dir;
  } catch {
    return dir;
  }
}

/** Raw `git log --first-parent` output in GIT_LOG_FORMAT for `rev`, run in `repoRoot`. A repository with no commits yet yields ''. */
export function gitLog(repoRoot: string, rev = 'HEAD'): string {
  try {
    return execFileSync('git', gitLogArgs({ rev }), { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (/does not have any commits yet|unknown revision|bad revision/i.test(stderr)) return '';
    throw new Error(`git log failed in ${repoRoot}: ${stderr.trim() || (err as Error).message}`);
  }
}

// ── Deriving ────────────────────────────────────────────────────────────────

export interface Records {
  /** The whole sealed log: the committed entries byte for byte, plus the newly derived ones. Newest first. */
  fragment: ShippedFragment;
  /** The public projection of `fragment` - the served file. */
  shiplog: ShippedFragment;
  devlog: DevlogFragment;
  /** Ids sealed in this run (not in the existing fragment). */
  appended: string[];
  unmapped: string[];
  badKinds: [string, string][];
}

const midnight = (date: string): string => `${date}T00:00:00.000Z`;

/** `generated` for a log: the newest entry's `at`, else the asserted date - never the clock. */
export const generatedOf = (entries: readonly { at: string }[], config: Pick<ShiplogConfig, 'asserted'>): string => {
  const newest = entries.reduce<string | undefined>((max, e) => (max === undefined || e.at > max ? e.at : max), undefined);
  return newest ?? midnight(config.asserted ?? new Date().toISOString().slice(0, 10));
};

const asIso = (at: string): string => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : new Date(ms).toISOString();
};

/** Raw git log + the committed records → the records after this run. Pure. */
export function deriveRecords(rawLog: string, config: RecordsConfig, existing: { fragment?: ShippedFragment | undefined; devlog?: DevlogFragment | undefined } = {}): Records {
  const derived = shippedFromGitLog(rawLog, config);
  const known = new Set((existing.fragment?.entries ?? []).map((e) => e.id));
  const merged = mergeEntries(existing.fragment?.entries ?? [], derived.entries);
  const generated = asIso(generatedOf(merged, config));
  const devlogEntries = mergeDevlogEntries(existing.devlog?.entries ?? [], devlogFromGitLog(rawLog, config));
  return {
    fragment: shippedFragment(config, merged, generated),
    shiplog: shippedFragment(config, publicShippedView(merged, config.held), generated),
    devlog: devlogFragment(config, devlogEntries, asIso(generatedOf(devlogEntries, { asserted: generated.slice(0, 10) }))),
    appended: derived.entries.map((e) => e.id).filter((id) => !known.has(id)),
    unmapped: derived.unmapped,
    badKinds: derived.badKinds,
  };
}

/** What the served shiplog must be for a fragment: its public projection under the same header. */
export const projectShiplog = (config: Pick<ShiplogConfig, 'source' | 'org' | 'held'>, fragment: ShippedFragment): ShippedFragment =>
  shippedFragment(config, publicShippedView(fragment.entries, config.held), fragment.generated);

/** The head over what is served: the public shiplog and the directory fragment. `at` is the shiplog's `generated`. */
export function recordsHead(shiplog: ShippedFragment, directory: unknown, origin: string): CheckpointHead {
  return checkpointHead(claimsOf(directory === undefined ? [shiplog] : [shiplog, directory]), origin, shiplog.generated);
}

// ── Validating ──────────────────────────────────────────────────────────────

export interface RecordFiles {
  config: RecordsConfig;
  /** Each is `undefined` when the file is absent; the finding says so. */
  fragment?: unknown;
  shiplog?: unknown;
  devlog?: unknown;
  checkpoint?: unknown;
  /** Absent is fine (signing is optional); present must verify and match the unsigned head. */
  checkpointSigned?: unknown;
  /** The served directory fragment, when there is one. */
  directory?: unknown;
}

const prefixed = (file: string, findings: Finding[]): Finding[] => findings.map((f) => ({ ...f, path: f.path ? `${file}#${f.path}` : file }));

/** Every problem in a directory's records: shape and seals of each file, the projection, and the head recomputed from what is served. */
export function validateRecords(files: RecordFiles): Finding[] {
  const out = new Collector();
  const { config } = files;
  if (files.fragment === undefined) out.bad('shiplog-fragment-missing', RECORD_PATHS.fragment, 'no sealed log - run `mesh emit`');
  else out.findings.push(...prefixed(RECORD_PATHS.fragment, validateShipped(files.fragment)));
  if (files.shiplog === undefined) out.bad('shiplog-not-served', RECORD_PATHS.shiplog, 'the log is not in the served directory - run `mesh emit`');
  else {
    out.findings.push(...prefixed(RECORD_PATHS.shiplog, validateShipped(files.shiplog)));
    if (files.fragment !== undefined && isRecord(files.fragment) && Array.isArray(files.fragment.entries)) {
      const expected = projectShiplog(config, files.fragment as unknown as ShippedFragment);
      if (canonicalStringify(files.shiplog) !== canonicalStringify(expected)) out.bad('shiplog-stale', RECORD_PATHS.shiplog, 'the served log is not the public projection of shiplog.fragment.json - run `mesh emit`');
    }
  }
  if (files.devlog === undefined) out.bad('devlog-not-served', RECORD_PATHS.devlog, 'the devlog is not written - run `mesh emit`');
  else out.findings.push(...prefixed(RECORD_PATHS.devlog, validateDevlog(files.devlog)));

  if (files.checkpoint === undefined) out.bad('checkpoint-not-served', RECORD_PATHS.checkpoint, 'no head over the records - run `mesh emit`');
  else if (isRecord(files.shiplog) && typeof files.shiplog.generated === 'string' && Array.isArray(files.shiplog.entries)) {
    const expected = recordsHead(files.shiplog as unknown as ShippedFragment, files.directory, config.origin ?? config.source);
    const recomputed = recomputeCheckpoint(files.checkpoint, claimsOf(files.directory === undefined ? [files.shiplog] : [files.shiplog, files.directory]));
    if (!recomputed.ok) out.bad('checkpoint-stale', RECORD_PATHS.checkpoint, `${recomputed.code}: ${recomputed.detail} - run \`mesh emit\``);
    else if (canonicalStringify(files.checkpoint) !== canonicalStringify(expected)) out.bad('checkpoint-stale', RECORD_PATHS.checkpoint, 'the head differs from the one derived from the served files (origin, at or counts) - run `mesh emit`');
  }
  if (files.checkpointSigned !== undefined) {
    const check = verifyCheckpointHead(files.checkpointSigned);
    if (!check.ok) out.bad('checkpoint-signature-invalid', RECORD_PATHS.checkpointSigned, `${check.code}: ${check.detail}`);
    if (files.checkpoint !== undefined && isRecord(files.checkpointSigned) && isRecord(files.checkpoint) && !canonicalHead(files.checkpointSigned).equals(canonicalHead(files.checkpoint)))
      out.bad('checkpoint-signed-stale', RECORD_PATHS.checkpointSigned, `the signed head is not the served head - re-sign it (\`${CHECKPOINT_KEY_ENV}=<key.pem> mesh emit\`)`);
  }
  return out.findings;
}

/** A one-line account of a fragment for the CLI. */
export const recordsSummary = (fragment: ShippedFragment | undefined, head: CheckpointHead | undefined): string => {
  const entries = fragment?.entries ?? [];
  const pub = entries.filter((e: ShippedEntry) => e.visibility === 'public').length;
  return `${entries.length} sealed (${pub} public)${head ? ` · head ${head.size} claims, root ${head.root.slice(0, 12)}…` : ''}`;
};
