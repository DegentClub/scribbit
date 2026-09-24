// Records: the git log → shipped/1 + devlog/1 → checkpoint/1 pipeline behind `mesh emit|check <dir>`.
// Unit tests over a raw `git log` fixture, then the CLI end to end over a temporary git repository.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalStringify } from '../src/canonical.ts';
import { checkpointHead, claimsOf, verifyCheckpointHead } from '../src/checkpoint.ts';
import { EXIT_FATAL, EXIT_FINDINGS, EXIT_OK, runCli } from '../src/cli.ts';
import { deriveRecords, generatedOf, projectShiplog, readRecordsConfig, RECORD_PATHS, recordsHead, type RecordsConfig, validateRecords } from '../src/records.ts';
import { buildLexicon, type DevlogFragment, parseGitLog, parseSubject, type ShippedFragment, verifyEntry } from '../src/shipped.ts';

const RAW = readFileSync(new URL('./fixtures/git-log.txt', import.meta.url), 'utf8');

/** The lexicon flashy/shiplog.config.json declares: leading words, not verbs. */
const LEXICON = {
  feature: ['feat', 'feature'], fix: ['fix'], security: ['security'], perf: ['perf'], docs: ['docs'], infra: ['ci', 'infra', 'build'], spec: ['spec', 'contract', 'adr'], release: ['release'],
};
const config: RecordsConfig = {
  source: 'repo/example', org: 'org/example', assertedBy: 'agent/example-records', defaultAuthor: 'person/alice',
  authors: { 'alice@example.org': 'person/alice', 'noreply@anthropic.com': 'agent/unattributed' },
  lexicon: LEXICON, visibility: 'public', prBase: 'https://github.com/example/example/pull/', asserted: '2026-09-24', origin: 'https://example.org',
};
const A = 'a'.repeat(12);
const B = 'b'.repeat(12);
const E = 'e'.repeat(12);

describe('the raw git log fixture', () => {
  it('parses into commits: sha, ISO author date, email, subject, body and co-authors', () => {
    const commits = parseGitLog(RAW);
    expect(commits.map((c) => c.sha.slice(0, 12))).toEqual([A, B, 'c'.repeat(12), 'd'.repeat(12), E]);
    expect(commits[0]).toMatchObject({ at: '2026-09-22T19:40:06+00:00', authorEmail: 'alice@example.org', subject: 'feat: publish the door (#12)', coAuthorEmails: ['noreply@anthropic.com'] });
    expect(commits[0]!.body).toBe('Body text.\n\nCloses backlog/example/door\nCo-Authored-By: Claude <noreply@anthropic.com>');
    expect(commits[1]!.body).toBeUndefined();
    expect(commits[4]!.body).toBe('kind: spec');
  });
});

describe('the lexicon', () => {
  const lex = buildLexicon(LEXICON);
  it.each([
    ['feat: publish the door', 'feature'], ['feature flags for the door', 'feature'], ['fix(core): stop the leak', 'fix'], ['security: rotate the key', 'security'], ['perf: faster', 'perf'],
    ['docs: the README', 'docs'], ['ci: pin actions', 'infra'], ['infra: the runner', 'infra'], ['build the site', 'infra'], ['spec: the fees API', 'spec'], ['contract: the fees API, 1.1.0', 'spec'],
    ['adr: 0011 records', 'spec'], ['release: 1.0.0', 'release'], ['mesh: records for scribb.it', 'other'], ['Split the monorepo: scribbit becomes the platform repo', 'other'],
  ])('%s → %s', (subject, kind) => {
    expect(parseSubject(subject, lex).kind).toBe(kind);
  });
});

describe('deriveRecords', () => {
  it('seals one entry per work commit (merges and bookkeeping dropped), attributes, projects and dates without a clock', () => {
    const r = deriveRecords(RAW, config);
    expect(r.fragment.entries.map((e) => e.id)).toEqual([`ship/example/${A}`, `ship/example/${B}`, `ship/example/${E}`]);
    expect(r.appended).toEqual(r.fragment.entries.map((e) => e.id));
    const [feat, mesh, contract] = r.fragment.entries;
    expect(feat).toMatchObject({ kind: 'feature', by: ['person/alice', 'agent/unattributed'], visibility: 'public', assertedBy: 'agent/example-records', asserted: '2026-09-24', refs: { pr: 'https://github.com/example/example/pull/12' }, closes: ['backlog/example/door'] });
    expect(mesh).toMatchObject({ kind: 'other', by: ['agent/unattributed'] });
    expect(contract).toMatchObject({ kind: 'spec', by: ['person/alice'] });
    expect(r.unmapped).toEqual(['carol@example.org']);
    expect(r.fragment.entries.every((e) => verifyEntry(e as unknown as Record<string, unknown>).ok)).toBe(true);
    // generated is the newest entry's `at`, normalised to ISO, never `new Date()`.
    expect(r.fragment.generated).toBe('2026-09-22T19:40:06.000Z');
    expect(r.shiplog).toEqual(projectShiplog(config, r.fragment));
    expect(r.shiplog.entries).toEqual(r.fragment.entries);
    // devlog/1: a machine's commit is dropped outright, a merge and bookkeeping too.
    expect(r.devlog.entries.map((e) => e.id)).toEqual([`devlog/example/${A}`, `devlog/example/${E}`]);
    expect(r.devlog.entries[0]).toMatchObject({ summary: 'Publish the door (#12)', ref: `https://github.com/example/example/commit/${'a'.repeat(40)}` });
    expect(r.devlog.generated).toBe('2026-09-22T19:40:06.000Z');
    expect(generatedOf([], { asserted: '2026-01-02' })).toBe('2026-01-02T00:00:00.000Z');
  });
  it('holds and private visibility leave the fragment whole and the projection smaller', () => {
    const r = deriveRecords(RAW, { ...config, held: { [B]: 'names a live secret' } });
    expect(r.fragment.entries.map((e) => e.visibility)).toEqual(['public', 'private', 'public']);
    expect(r.shiplog.entries.map((e) => e.id)).toEqual([`ship/example/${A}`, `ship/example/${E}`]);
    expect(deriveRecords(RAW, { ...config, visibility: 'private' }).shiplog.entries).toEqual([]);
  });
  it('is a union with the committed records: existing entries are kept byte for byte, only new ids are appended, and re-running changes nothing', () => {
    const first = deriveRecords(RAW, config);
    const restated = { ...first.fragment.entries[0]!, title: 'restated by hand', digest: 'f'.repeat(64) };
    const orphan = { ...first.fragment.entries[1]!, id: `ship/example/${'f'.repeat(12)}` }; // a sha no longer in history stays sealed
    const committed: ShippedFragment = { ...first.fragment, entries: [restated, orphan] };
    const committedDevlog: DevlogFragment = { ...first.devlog, entries: [{ ...first.devlog.entries[0]!, summary: 'Restated' }] };
    const second = deriveRecords(RAW, config, { fragment: committed, devlog: committedDevlog });
    expect(second.fragment.entries.map((e) => e.id)).toEqual([`ship/example/${A}`, `ship/example/${B}`, `ship/example/${'f'.repeat(12)}`, `ship/example/${E}`]);
    expect(second.fragment.entries.find((e) => e.id === restated.id)).toEqual(restated);
    expect(second.fragment.entries.find((e) => e.id === orphan.id)).toEqual(orphan);
    expect(second.appended).toEqual([`ship/example/${B}`, `ship/example/${E}`]);
    expect(second.devlog.entries[0]!.summary).toBe('Restated');
    const third = deriveRecords(RAW, config, { fragment: second.fragment, devlog: second.devlog });
    expect(canonicalStringify(third.fragment)).toBe(canonicalStringify(second.fragment));
    expect(canonicalStringify(third.devlog)).toBe(canonicalStringify(second.devlog));
    expect(third.appended).toEqual([]);
  });
  it('the head is the RFC 6962 root over the served log and the directory fragment, dated by the log', () => {
    const r = deriveRecords(RAW, config);
    const directory = { directory: '0.1', nodes: [{ id: 'org/example', digest: '1'.repeat(64) }], edges: [{ id: 'edge/x', digest: '2'.repeat(64) }] };
    const head = recordsHead(r.shiplog, directory, 'https://example.org');
    expect(head).toEqual(checkpointHead(claimsOf([r.shiplog, directory]), 'https://example.org', r.shiplog.generated));
    expect(head).toMatchObject({ checkpoint: '1', origin: 'https://example.org', size: 5, at: '2026-09-22T19:40:06.000Z', counts: { shipped: 3, directory: 2 } });
    expect(recordsHead(r.shiplog, undefined, 'repo/example').size).toBe(3);
  });
});

describe('readRecordsConfig / validateRecords', () => {
  it('checks every field and lowercases author addresses', () => {
    expect(readRecordsConfig({ ...config, authors: { 'Alice@Example.org': 'person/alice' } }).authors).toEqual({ 'alice@example.org': 'person/alice' });
    expect(() => readRecordsConfig({ ...config, source: 'example' })).toThrow(/"source"/);
    expect(() => readRecordsConfig({ ...config, defaultAuthor: 'agent/x' })).toThrow(/"defaultAuthor"/);
    expect(() => readRecordsConfig({ ...config, lexicon: { bogus: ['x'] } })).toThrow(/"lexicon"/);
    expect(() => readRecordsConfig({ ...config, visibility: 'secret' })).toThrow(/"visibility"/);
    expect(() => readRecordsConfig({ ...config, held: { a: 1 } })).toThrow(/"held"/);
    expect(() => readRecordsConfig(null)).toThrow(/JSON object/);
  });
  it('names each missing file, a stale projection and a stale head', () => {
    const r = deriveRecords(RAW, config);
    const head = recordsHead(r.shiplog, undefined, 'https://example.org');
    const codes = (files: Parameters<typeof validateRecords>[0]) => validateRecords(files).map((f) => f.code);
    expect(codes({ config })).toEqual(['shiplog-fragment-missing', 'shiplog-not-served', 'devlog-not-served', 'checkpoint-not-served']);
    expect(codes({ config, fragment: r.fragment, shiplog: r.shiplog, devlog: r.devlog, checkpoint: head })).toEqual([]);
    expect(codes({ config, fragment: r.fragment, shiplog: { ...r.shiplog, entries: r.shiplog.entries.slice(1) }, devlog: r.devlog, checkpoint: head })).toEqual(['shiplog-stale', 'checkpoint-stale']);
    expect(codes({ config, fragment: r.fragment, shiplog: r.shiplog, devlog: r.devlog, checkpoint: { ...head, at: '2026-01-01T00:00:00.000Z' } })).toEqual(['checkpoint-stale']);
    expect(codes({ config, fragment: r.fragment, shiplog: r.shiplog, devlog: r.devlog, checkpoint: { ...head, root: '0'.repeat(64) } })).toEqual(['checkpoint-stale']);
    const tampered = { ...r.fragment, entries: [{ ...r.fragment.entries[0]!, title: 'x' }, ...r.fragment.entries.slice(1)] };
    expect(codes({ config, fragment: tampered, shiplog: r.shiplog, devlog: r.devlog, checkpoint: head })).toEqual(['broken-seal', 'shiplog-stale']);
    expect(codes({ config, fragment: r.fragment, shiplog: r.shiplog, devlog: r.devlog, checkpoint: head, checkpointSigned: head })).toEqual(['checkpoint-signature-invalid']);
  });
});

// ── End to end over a real repository ───────────────────────────────────────

let tmp: string;
let repo: string;
let site: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mesh-records-'));
  repo = path.join(tmp, 'repo');
  site = path.join(repo, 'flashy');
  mkdirSync(site, { recursive: true });
  git(['init', '-q', '-b', 'main']);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const git = (args: string[]): string => execFileSync('git', ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.org', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let day = 1;
const commit = (subject: string, body = '', email = 'alice@example.org'): string => {
  writeFileSync(path.join(repo, `f${day}.txt`), subject);
  git(['add', '.']);
  const date = `2026-09-${String(day++).padStart(2, '0')}T10:00:00Z`;
  execFileSync('git', ['-c', 'user.name=Alice', `-c`, `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return git(['rev-parse', 'HEAD']);
};
const run = async (args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; json: Record<string, unknown> & { findings: { code: string }[]; written?: string[] } }> => {
  let out = '';
  const code = await runCli([...args, '--json'], { stdout: (s) => (out += s), stderr: () => {}, cwd: repo, env });
  return { code, json: JSON.parse(out) as never };
};
const read = <T = unknown>(rel: string): T => JSON.parse(readFileSync(path.join(site, rel), 'utf8')) as T;
const write = (rel: string, value: unknown): void => writeFileSync(path.join(site, rel), `${JSON.stringify(value, null, 2)}\n`);

const charter = {
  aao: '0.1', name: 'Example', slug: 'example', description: 'An example organisation.', accountableTo: 'a@example.org',
  repositories: [{ name: 'example', default: true }], roles: [{ name: 'settlement', family: 'finance', purpose: 'Moves value once.', capabilities: ['post'] }],
};

describe('mesh emit / check <dir> with shiplog.config.json, over a temporary git repository', () => {
  it('emit seals the three commits, projects them, declares the surfaces and writes a head the check recomputes', async () => {
    const shas = [commit('feat: open the door'), commit('contract: the fees API', 'kind: spec'), commit('Add the checker', 'Closes backlog/example/checker', 'noreply@anthropic.com')];
    write('charter.json', charter);
    write('directory.config.json', { asserted: '2026-09-24', expires: '2027-09-24', assertedBy: 'person/alice', properties: [{ domain: 'example.org', name: 'example.org' }] });
    write('shiplog.config.json', { ...config, held: undefined, asserted: '2026-09-24' });
    const emitted = await run(['emit', 'flashy']);
    expect(emitted.json).toMatchObject({ ok: true, exit: EXIT_OK, sealed: 3, repoRoot: '.' });
    expect(emitted.json.appended).toEqual(shas.map((s) => `ship/example/${s.slice(0, 12)}`).reverse());
    expect(emitted.json.written).toEqual([
      'flashy/public/.well-known/flashyos-charter.json', 'flashy/public/flashyos.roles.json', 'flashy/shiplog.fragment.json', 'flashy/public/.well-known/shiplog.json', 'flashy/public/.well-known/devlog.fragment.json',
      'flashy/public/directory.fragment.json', 'flashy/directory.externals.json', 'flashy/public/.well-known/checkpoint.json',
    ]);
    const fragment = read<ShippedFragment>(RECORD_PATHS.fragment);
    expect(fragment.entries.map((e) => [e.kind, e.by, e.visibility, e.refs?.commit])).toEqual([
      ['other', ['agent/unattributed'], 'public', shas[2]], ['spec', ['person/alice'], 'public', shas[1]], ['feature', ['person/alice'], 'public', shas[0]],
    ]);
    expect(fragment.entries[0]!.closes).toEqual(['backlog/example/checker']);
    expect(fragment.generated).toBe('2026-09-03T10:00:00.000Z');
    expect(read(RECORD_PATHS.shiplog)).toEqual(fragment);
    expect(read<DevlogFragment>(RECORD_PATHS.devlog).entries.map((e) => e.summary)).toEqual(['Contract: the fees API', 'Open the door']);
    const directory = read<{ nodes: { id: string }[] }>('public/directory.fragment.json');
    expect(directory.nodes.map((n) => n.id)).toContain('src/example-shipped-1');
    expect(directory.nodes.map((n) => n.id)).toContain('src/example-checkpoint-1');
    expect(read<{ ids: string[] }>('directory.externals.json').ids).toEqual(['person/alice', 'std/aao-0-1', 'std/checkpoint-1', 'std/shipped-1']);
    const head = read<Record<string, unknown>>(RECORD_PATHS.checkpoint);
    expect(head).toEqual(checkpointHead(claimsOf([fragment, directory]), 'https://example.org', fragment.generated));
    // The directory's nodes and edges carry no digest (FlashyOS seals shipped entries, not directory records), so only the log is in the tree.
    expect(directory.nodes.every((n) => !('digest' in n))).toBe(true);
    expect(head).toMatchObject({ size: 3, at: fragment.generated, counts: { shipped: 3 } });
    expect(emitted.json.head).toEqual(head);

    const checked = await run(['check', 'flashy']);
    expect(checked.json).toMatchObject({ ok: true, findings: [] });
    expect((checked.json.checked as string[]).slice(-5)).toEqual(['flashy/shiplog.config.json', 'flashy/shiplog.fragment.json', 'flashy/public/.well-known/shiplog.json', 'flashy/public/.well-known/devlog.fragment.json', 'flashy/public/.well-known/checkpoint.json']);
    expect(String(checked.json.summary)).toContain('records: 3 sealed (3 public) · head');

    // A second emit over the same history is a no-op, byte for byte.
    const before = readFileSync(path.join(site, RECORD_PATHS.fragment), 'utf8');
    const again = await run(['emit', 'flashy']);
    expect(again.json.appended).toEqual([]);
    expect(readFileSync(path.join(site, RECORD_PATHS.fragment), 'utf8')).toBe(before);
    expect(readFileSync(path.join(site, RECORD_PATHS.checkpoint), 'utf8')).toBe(JSON.stringify(head, null, 2) + '\n');
  });
  it('check catches a tampered seal, a hand-edited projection and a stale head', async () => {
    const fragment = read<ShippedFragment>(RECORD_PATHS.fragment);
    write(RECORD_PATHS.shiplog, { ...fragment, entries: fragment.entries.slice(1) });
    expect((await run(['check', 'flashy'])).json.findings.map((f) => f.code)).toEqual(['shiplog-stale', 'checkpoint-stale']);
    write(RECORD_PATHS.shiplog, fragment);
    write(RECORD_PATHS.fragment, { ...fragment, entries: [{ ...fragment.entries[0]!, title: 'rewritten' }, ...fragment.entries.slice(1)] });
    const r = await run(['check', 'flashy']);
    expect(r.code).toBe(EXIT_FINDINGS);
    expect(r.json.findings.map((f) => f.code)).toEqual(['broken-seal', 'shiplog-stale']);
    expect(r.json.findings[0]).toMatchObject({ path: `shiplog.fragment.json#${fragment.entries[0]!.id}` });
    write(RECORD_PATHS.fragment, fragment);
    const head = read<Record<string, unknown>>(RECORD_PATHS.checkpoint);
    write(RECORD_PATHS.checkpoint, { ...head, root: '0'.repeat(64) });
    expect((await run(['check', 'flashy'])).json.findings.map((f) => f.code)).toEqual(['checkpoint-stale']);
    write(RECORD_PATHS.checkpoint, head);
    expect((await run(['check', 'flashy'])).json.findings).toEqual([]);
  });
  it('emit appends a new commit and keeps the sealed ones byte for byte; --frozen never reads git; --rev picks the revision', async () => {
    const before = read<ShippedFragment>(RECORD_PATHS.fragment);
    const sha = commit('fix: close the leak');
    commit('shipped/1: refresh the log [skip ci]'); // our own bookkeeping is not work
    const frozen = await run(['emit', 'flashy', '--frozen']);
    expect(frozen.json).toMatchObject({ ok: true, appended: [] });
    expect(read<ShippedFragment>(RECORD_PATHS.fragment)).toEqual(before);
    expect((await run(['check', 'flashy'])).json.findings).toEqual([]);

    const emitted = await run(['emit', 'flashy']);
    expect(emitted.json.appended).toEqual([`ship/example/${sha.slice(0, 12)}`]);
    const after = read<ShippedFragment>(RECORD_PATHS.fragment);
    expect(after.entries).toHaveLength(4);
    expect(after.entries[0]).toMatchObject({ id: `ship/example/${sha.slice(0, 12)}`, kind: 'fix' });
    expect(after.entries.slice(1)).toEqual(before.entries);
    expect(after.generated).toBe('2026-09-04T10:00:00.000Z');
    expect(read<Record<string, unknown>>(RECORD_PATHS.checkpoint)).toMatchObject({ at: after.generated, counts: { shipped: 4 } });
    expect((await run(['check', 'flashy'])).json.findings).toEqual([]);

    const older = await run(['emit', 'flashy', '--rev', 'HEAD~4']);
    expect(older.json.appended).toEqual([]);
    expect(read<ShippedFragment>(RECORD_PATHS.fragment)).toEqual(after);
  });
  it('signs the head only when MESH_CHECKPOINT_KEY names a key, and check verifies the signed copy against the served head', async () => {
    expect(existsSync(path.join(site, RECORD_PATHS.checkpointSigned))).toBe(false);
    await run(['keygen', '--out', 'keys']);
    const missing = await run(['emit', 'flashy'], { MESH_CHECKPOINT_KEY: 'keys/nope.pem' });
    expect(missing.code).toBe(EXIT_FATAL);
    const signed = await run(['emit', 'flashy'], { MESH_CHECKPOINT_KEY: 'keys/ed25519.key.pem' });
    expect(signed.json).toMatchObject({ ok: true, kid: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(signed.json.written).toContain('flashy/public/.well-known/checkpoint.signed.json');
    const doc = read<Record<string, unknown>>(RECORD_PATHS.checkpointSigned);
    expect(verifyCheckpointHead(doc, { trustedKeys: [readFileSync(path.join(repo, 'keys/ed25519.pub.pem'), 'utf8')] })).toMatchObject({ ok: true, kid: signed.json.kid });
    const { 'x-signature': _sig, ...unsigned } = doc;
    expect(unsigned).toEqual(read(RECORD_PATHS.checkpoint));
    expect(JSON.stringify(doc)).not.toContain('PRIVATE');
    const checked = await run(['check', 'flashy']);
    expect(checked.json.findings).toEqual([]);
    expect(checked.json.checked).toContain('flashy/public/.well-known/checkpoint.signed.json');

    write(RECORD_PATHS.checkpointSigned, { ...doc, at: '2026-01-01T00:00:00.000Z' });
    expect((await run(['check', 'flashy'])).json.findings.map((f) => f.code)).toEqual(['checkpoint-signature-invalid', 'checkpoint-signed-stale']);
    write(RECORD_PATHS.checkpointSigned, doc);
    commit('feat: one more');
    await run(['emit', 'flashy']); // no key this time: the signed copy is left behind, and check says so
    expect((await run(['check', 'flashy'])).json.findings.map((f) => f.code)).toEqual(['checkpoint-signed-stale']);
    rmSync(path.join(site, RECORD_PATHS.checkpointSigned));
    expect((await run(['check', 'flashy'])).json.findings).toEqual([]);
  });
  it('--frozen without a committed fragment, and a broken config, are fatal', async () => {
    const bare = path.join(tmp, 'bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(path.join(bare, 'charter.json'), JSON.stringify(charter));
    writeFileSync(path.join(bare, 'shiplog.config.json'), JSON.stringify(config));
    const frozen = await run(['emit', bare, '--frozen']);
    expect(frozen.code).toBe(EXIT_FATAL);
    expect(String(frozen.json.error)).toContain('--frozen');
    writeFileSync(path.join(bare, 'shiplog.config.json'), JSON.stringify({ ...config, org: 'nope' }));
    expect((await run(['emit', bare])).code).toBe(EXIT_FATAL);
    expect((await run(['check', bare])).code).toBe(EXIT_FATAL);
  });
});
