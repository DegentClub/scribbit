import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '../src/canonical.ts';
import {
  buildLexicon, canonicalEntry, commitBaseFrom, devlogFragment, devlogFromGitLog, fromCommits, GIT_LOG_FORMAT, gitLogArgs, IMPERATIVE_LEXICON, isDevlogWorthy, isIntegrationMerge, isMachineAddress, isOwnBookkeeping,
  mergeDevlogEntries, mergeEntries, parseCloses, parseGitLog, parseKindTrailer, parseSubject, publicShippedView, renderDevlogMarkdown, sealEntry, shippedFragment, shippedFromGitLog, type ShiplogConfig,
  summaryFromSubject, UNATTRIBUTED_AGENT, validateDevlog, validateShipped, verifyEntry, withoutPrefix,
} from '../src/shipped.ts';

const RS = '\x1e';
const US = '\x1f';
const rec = (sha: string, at: string, email: string, subject: string, body = ''): string => [sha, at, email, subject, body].join(US) + RS;
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const SHA4 = 'd'.repeat(40);
const raw =
  rec(SHA1, '2026-09-22T19:40:06Z', 'alice@example.org', 'feat: publish the door (#12)', 'Body text.\n\nCloses backlog/example/door\nCo-Authored-By: Claude <noreply@anthropic.com>') +
  rec(SHA2, '2026-09-21T10:00:00Z', 'noreply@anthropic.com', 'Add the checker', 'kind: docs') +
  rec(SHA3, '2026-09-20T10:00:00Z', 'bob@example.org', "Merge branch 'main' into feature") +
  rec(SHA4, '2026-09-19T10:00:00Z', 'shiplog@users.noreply.github.com', 'shipped/1: refresh the log, and the checkpoint over it [skip ci]');

const config: ShiplogConfig = {
  source: 'repo/example',
  org: 'org/example',
  assertedBy: 'agent/example-ci',
  defaultAuthor: 'person/alice',
  authors: { 'alice@example.org': 'person/alice', 'noreply@anthropic.com': 'agent/claude' },
  lexicon: 'imperative',
  prBase: 'https://github.com/example/example/pull/',
  asserted: '2026-09-24',
};

describe('sealing', () => {
  it('digest = sha256(canonicalStringify(entry minus digest)), and verifies', () => {
    const entry = { id: 'ship/x/abc', title: 'T', by: ['person/a'], nested: { z: 1, a: 2 } };
    const sealed = sealEntry(entry);
    expect(sealed.digest).toBe(createHash('sha256').update(canonicalStringify(entry), 'utf8').digest('hex'));
    expect(canonicalEntry(sealed)).toBe(canonicalStringify(entry));
    expect(verifyEntry(sealed).ok).toBe(true);
    expect(verifyEntry({ ...sealed, title: 'tampered' })).toMatchObject({ ok: false, claimed: sealed.digest });
  });
});

describe('parsing', () => {
  it('reads GIT_LOG_FORMAT records, bodies and co-authors', () => {
    expect(gitLogArgs({ rev: 'origin/main', since: '2026-01-01' })).toEqual(['log', '--first-parent', `--pretty=format:${GIT_LOG_FORMAT}`, 'origin/main', '--since=2026-01-01']);
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(4);
    expect(commits[0]).toMatchObject({ sha: SHA1, at: '2026-09-22T19:40:06Z', authorEmail: 'alice@example.org', subject: 'feat: publish the door (#12)', coAuthorEmails: ['noreply@anthropic.com'] });
    expect(commits[0]!.body).toContain('Closes backlog/example/door');
    expect(commits[2]!.body).toBeUndefined();
    expect(parseGitLog('')).toEqual([]);
  });
  it('classifies subjects: conventional prefixes first, then the lexicon, else other', () => {
    expect(parseSubject('feat: publish the door')).toEqual({ kind: 'feature', title: 'publish the door', breaking: false });
    expect(parseSubject('fix(core)!: stop the leak')).toEqual({ kind: 'fix', title: 'stop the leak', breaking: true });
    expect(parseSubject('chore(release): v1.2.0')).toMatchObject({ kind: 'release' });
    expect(parseSubject('perf: faster')).toMatchObject({ kind: 'perf' });
    expect(parseSubject('rfc: the shape')).toMatchObject({ kind: 'spec' });
    const lex = buildLexicon(IMPERATIVE_LEXICON);
    expect(parseSubject('Add the checker', lex)).toMatchObject({ kind: 'feature', title: 'Add the checker' });
    expect(parseSubject('Phase 3: fix the mesh', lex)).toMatchObject({ kind: 'fix' });
    expect(parseSubject('Bump deps', lex)).toMatchObject({ kind: 'infra' });
    expect(parseSubject('Something nobody classified', lex)).toMatchObject({ kind: 'other' });
    expect(parseSubject('Add the checker')).toMatchObject({ kind: 'other' });
    expect(withoutPrefix('XP-7: the public page')).toBe('the public page');
    expect(withoutPrefix('a sentence that happens to contain a colon: and goes on')).toBe('a sentence that happens to contain a colon: and goes on');
    expect(buildLexicon({ nope: ['x'], fix: ['Mend'] }).get('mend')).toBe('fix');
  });
  it('reads the kind trailer and the backlog items a message closes', () => {
    expect(parseKindTrailer('text\nkind: security\n')).toBe('security');
    expect(parseKindTrailer('kind: bogus')).toBeUndefined();
    expect(parseCloses('Closes backlog/x/a, fixes backlog/x/b and closes backlog/x/a')).toEqual(['backlog/x/a', 'backlog/x/b']);
  });
  it('knows a machine address and its own bookkeeping', () => {
    expect(isMachineAddress('noreply@anthropic.com')).toBe(true);
    expect(isMachineAddress('49699333+dependabot[bot]@users.noreply.github.com')).toBe(true);
    expect(isMachineAddress('shiplog@users.noreply.github.com')).toBe(true);
    expect(isMachineAddress('alice@bots.example.org')).toBe(false);
    expect(isIntegrationMerge("Merge remote-tracking branch 'origin/main'")).toBe(true);
    expect(isIntegrationMerge('Merge pull request #1 from x')).toBe(false);
    expect(isOwnBookkeeping('shipped/1: refresh the log, and the checkpoint over it [skip ci]')).toBe(true);
    expect(isOwnBookkeeping('shipped/1: refresh the logic')).toBe(false);
    expect(isOwnBookkeeping('Estate record: merged 2026-09-01')).toBe(true);
    expect(isOwnBookkeeping('Estate record: merged, finally')).toBe(false);
  });
});

describe('fromCommits / shippedFromGitLog', () => {
  it('derives sealed, private-by-default entries with attribution, refs and closes; drops merges and bookkeeping', () => {
    const { entries, unmapped, badKinds } = shippedFromGitLog(raw, config);
    expect(entries.map((e) => e.id)).toEqual([`ship/example/${'a'.repeat(12)}`, `ship/example/${'b'.repeat(12)}`]);
    const [first, second] = entries;
    expect(first).toMatchObject({ repo: 'repo/example', at: '2026-09-22T19:40:06Z', kind: 'feature', title: 'publish the door (#12)', by: ['person/alice', 'agent/claude'], asserted: '2026-09-24', assertedBy: 'agent/example-ci', visibility: 'private', refs: { commit: SHA1, pr: 'https://github.com/example/example/pull/12' }, closes: ['backlog/example/door'] });
    expect(first!.detail).toContain('Body text.');
    expect(verifyEntry(first as unknown as Record<string, unknown>).ok).toBe(true);
    expect(second).toMatchObject({ kind: 'docs', by: ['agent/claude'], refs: { commit: SHA2 } });
    expect(second!.closes).toBeUndefined();
    expect(unmapped).toEqual([]);
    expect(badKinds).toEqual([]);
  });
  it('never files a machine under a person, and reports unmapped addresses and bad recorded kinds', () => {
    const { entries, unmapped, badKinds } = shippedFromGitLog(raw, { ...config, authors: {}, kinds: { [SHA1.slice(0, 12)]: 'security', [SHA2]: 'bogus' } });
    expect(entries[0]!.by).toEqual(['person/alice', UNATTRIBUTED_AGENT]);
    expect(entries[0]!.kind).toBe('security');
    expect(entries[1]!.by).toEqual([UNATTRIBUTED_AGENT]);
    expect(entries[1]!.kind).toBe('docs');
    expect(unmapped).toEqual(['alice@example.org', 'noreply@anthropic.com']);
    expect(badKinds).toEqual([[SHA2.slice(0, 12), 'bogus']]);
  });
  it('honours the repository visibility, holds, breaking titles, truncation and keepIntegrationMerges', () => {
    const { entries } = shippedFromGitLog(raw, { ...config, visibility: 'public', held: { [SHA2.slice(0, 12)]: 'names a live secret' } });
    expect(entries.map((e) => e.visibility)).toEqual(['public', 'private']);
    const long = rec(SHA3, '2026-09-20T10:00:00Z', 'alice@example.org', `feat!: ${'x'.repeat(200)}`);
    expect(shippedFromGitLog(long, config).entries[0]!.title).toHaveLength(140);
    expect(shippedFromGitLog(long, config).entries[0]!.title.startsWith('xxx')).toBe(true);
    const kept = fromCommits(parseGitLog(raw), { ...config, keepIntegrationMerges: true });
    expect(kept.entries).toHaveLength(4);
    expect(fromCommits([{ sha: SHA4, at: '2026-01-01T00:00:00Z', authorEmail: '', subject: 'x' }], config).entries[0]!.by).toEqual(['person/alice']);
  });
  it('produces a fragment that validates, and merges without restating sealed history', () => {
    const { entries } = shippedFromGitLog(raw, config);
    const fragment = shippedFragment(config, entries, '2026-09-24T00:00:00.000Z');
    expect(fragment).toMatchObject({ shipped: '1', source: 'repo/example', org: 'org/example' });
    expect(validateShipped(fragment)).toEqual([]);
    const restated = { ...entries[0]!, title: 'restated', digest: 'x' };
    const merged = mergeEntries([restated], entries);
    expect(merged.find((e) => e.id === restated.id)?.title).toBe('restated');
    expect(merged).toHaveLength(2);
    expect(merged[0]!.at >= merged[1]!.at).toBe(true);
    expect(publicShippedView(entries)).toEqual([]);
    const open = shippedFromGitLog(raw, { ...config, visibility: 'public' }).entries;
    expect(publicShippedView(open, { [SHA1]: 'held' }).map((e) => e.id)).toEqual([`ship/example/${'b'.repeat(12)}`]);
  });
});

describe('validateShipped', () => {
  const good = () => shippedFragment(config, shippedFromGitLog(raw, config).entries, '2026-09-24T00:00:00.000Z');
  const codes = (doc: unknown) => validateShipped(doc).map((f) => f.code);
  it('checks the header and the entry list', () => {
    expect(codes(null)).toEqual(['not-an-object']);
    expect(codes({ ...good(), shipped: '2' })).toEqual(['bad-version']);
    expect(codes({ ...good(), source: 'example' })).toEqual(['bad-fragment-source', 'foreign-entry', 'bad-repo', 'foreign-entry', 'bad-repo']);
    expect(codes({ ...good(), org: 'x' })).toEqual(['bad-fragment-org']);
    expect(codes({ ...good(), generated: 'now-ish' })).toEqual(['bad-generated']);
    expect(codes({ ...good(), entries: {} })).toEqual(['no-entries']);
  });
  it('recomputes every seal and checks every entry field', () => {
    const f = good();
    const [e] = f.entries;
    const one = (patch: Record<string, unknown>) => ({ ...f, entries: [{ ...e, ...patch }] });
    expect(codes(one({ title: 'tampered' }))).toEqual(['broken-seal']);
    expect(codes(one({ digest: 'abc' }))).toEqual(['bad-digest']);
    expect(codes(one({ id: 'ship/other/abc' }))).toEqual(['foreign-entry', 'broken-seal']);
    expect(codes(one({ id: 'nope' }))).toEqual(['bad-id', 'broken-seal']);
    expect(codes(one({ kind: 'thing' }))).toEqual(['bad-kind', 'broken-seal']);
    expect(codes(one({ by: [] }))).toEqual(['bad-by', 'broken-seal']);
    expect(codes(one({ visibility: 'secret' }))).toEqual(['bad-visibility', 'broken-seal']);
    expect(codes(one({ at: 'soon' }))).toEqual(['bad-at', 'broken-seal']);
    expect(codes(one({ title: 'x'.repeat(141) }))).toEqual(['title-too-long', 'broken-seal']);
    expect(codes({ ...f, entries: [e, e] })).toEqual(['duplicate-id']);
    expect(codes({ ...f, entries: ['x'] })).toEqual(['not-an-entry']);
  });
});

describe('devlog/1', () => {
  it('keeps only a person\'s real commits, capitalises the summary and derives the commit link from prBase', () => {
    expect(commitBaseFrom(config)).toBe('https://github.com/example/example/commit/');
    expect(commitBaseFrom({ prBase: 'https://gitlab.example/x/-/merge_requests/' })).toBeUndefined();
    const entries = devlogFromGitLog(raw, config);
    expect(entries.map((e) => e.id)).toEqual([`devlog/example/${'a'.repeat(12)}`]);
    expect(entries[0]).toMatchObject({ summary: 'Publish the door (#12)', commitSha: SHA1, ref: `https://github.com/example/example/commit/${SHA1}` });
    expect(isDevlogWorthy({ sha: SHA1, at: 'x', authorEmail: 'a@b.co', subject: 'fix [skip ci]' })).toBe(false);
    expect(summaryFromSubject('feat: ' + 'y'.repeat(300))).toHaveLength(280);
    expect(devlogFromGitLog(raw, { ...config, prBase: undefined })[0]!.ref).toBe(`repo/example#${'a'.repeat(12)}`);
  });
  it('renders markdown grouped by day and validates the fragment', () => {
    const entries = mergeDevlogEntries([], [
      { id: 'devlog/example/aaaaaaaaaaaa', at: '2026-09-22T19:40:06Z', summary: 'Publish the door', commitSha: SHA1, ref: 'https://x/a' },
      { id: 'devlog/example/bbbbbbbbbbbb', at: '2026-09-21T10:00:00Z', summary: 'Add the checker', commitSha: SHA2, ref: 'https://x/b' },
    ]);
    const md = renderDevlogMarkdown(entries, { title: 'Example devlog' });
    expect(md).toContain('# Example devlog');
    expect(md).toContain('## 2026-09-22\n\n- Publish the door ([`aaaaaaaaaaaa`](https://x/a))\n\n## 2026-09-21');
    expect(renderDevlogMarkdown([])).toContain('Nothing shipped yet.');
    const fragment = devlogFragment(config, entries, '2026-09-24T00:00:00.000Z');
    expect(validateDevlog(fragment)).toEqual([]);
    expect(validateDevlog({ ...fragment, entries: [{ ...entries[0], summary: '', commitSha: 'ZZ' }] }).map((f) => f.code)).toEqual(['no-summary', 'bad-commit']);
    expect(validateDevlog({ ...fragment, devlog: '2', entries: [entries[0], entries[0]] }).map((f) => f.code)).toEqual(['bad-version', 'duplicate-id']);
  });
});
