import { describe, expect, it } from 'vitest';
import type { Charter } from '../src/charter.ts';
import { canonicalStringify } from '../src/canonical.ts';
import { type DirectoryEdge, type DirectoryFragment, type DirectoryNode, directoryFromCharter, directorySummary, EDGE_REQUIRES, EDGE_TYPES, edgeKey, missingRequired, NODE_KINDS, profileSlug, validateDirectory } from '../src/directory.ts';

const charter: Charter = {
  aao: '0.1',
  name: 'Example Org',
  slug: 'example',
  description: 'An organisation that exists to be graphed.',
  accountableTo: 'a@example.org',
  repositories: [{ name: 'example-repo', default: true }, { name: 'other' }],
  roles: [
    { name: 'settlement', family: 'finance', purpose: 'Moves value once.', capabilities: ['post', 'reverse'] },
    { name: 'coordination', family: 'governance', purpose: 'Settles conflicts.' },
  ],
};
const BASE = { asserted: '2026-09-24', expires: '2027-09-24', assertedBy: 'person/alice' };
const emit = (extra: Partial<Parameters<typeof directoryFromCharter>[1]> = {}) => directoryFromCharter(charter, { ...BASE, ...extra });
// person/alice is the accountable human: referenced by every fixture, defined by another repository, so declared external.
const EXT = ['person/alice'];
const codes = (doc: unknown, ext: string[] = EXT): string[] => validateDirectory(doc, ext).map((f) => f.code);

const prov = { asserted: '2026-09-24', assertedBy: 'person/alice', expires: '2027-09-24', visibility: 'public' as const };
const node = (id: string, kind: keyof typeof NODE_KINDS, extra: Record<string, unknown> = {}): DirectoryNode => ({ ...prov, id, kind, name: id, ...extra });
const edge = (type: DirectoryEdge['type'], from: string, to: string, extra: Record<string, unknown> = {}): DirectoryEdge => ({ ...prov, type, from, to, ...extra });
const fragment = (nodes: DirectoryNode[], edges: DirectoryEdge[]): DirectoryFragment => ({ directory: '0.1', source: 'repo/x', generated: '2026-09-24', nodes, edges });
const minimal = (): DirectoryFragment => fragment([node('org/x', 'Organization')], [edge('accountableFor', 'person/alice', 'org/x')]);

describe('directoryFromCharter', () => {
  it('derives the org, one agent per role with a declares edge, and the accountable human, and validates', () => {
    const { fragment: f, externals } = emit();
    expect(validateDirectory(f, externals.ids)).toEqual([]);
    expect(f.source).toBe('repo/example-repo');
    expect(f.generated).toBe('2026-09-24');
    const org = f.nodes.find((n) => n.kind === 'Organization')!;
    expect(org).toMatchObject({ id: 'org/example', name: 'Example Org', description: charter.description, ...prov });
    expect(Object.keys(org)).toEqual(['asserted', 'assertedBy', 'expires', 'visibility', 'id', 'kind', 'name', 'description']);
    expect(f.nodes.filter((n) => n.kind === 'Agent').map((n) => n.id)).toEqual(['agent/example-coordination', 'agent/example-settlement']);
    expect(f.edges.find((e) => e.type === 'declares' && e.to === 'agent/example-settlement')).toMatchObject({ from: 'org/example', role: 'settlement', scope: ['post', 'reverse'] });
    expect(f.edges.find((e) => e.type === 'declares' && e.to === 'agent/example-coordination')?.scope).toEqual([]);
    expect(f.edges.find((e) => e.type === 'accountableFor')).toMatchObject({ from: 'person/alice', to: 'org/example' });
    expect(externals.ids).toEqual(['person/alice']);
  });
  it('is deterministic and sorted: nodes by id, edges by from·type·to', () => {
    const a = emit();
    const b = emit();
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(a.fragment.nodes.map((n) => n.id)).toEqual([...a.fragment.nodes.map((n) => n.id)].sort((x, y) => x.localeCompare(y)));
    expect(a.fragment.edges.map(edgeKey)).toEqual([...a.fragment.edges.map(edgeKey)].sort((x, y) => x.localeCompare(y)));
  });
  it('declares emitter machines as operated by the org and delegated by the human, same scope', () => {
    const { fragment: f } = emit({ emitters: [{ id: 'agent/example-ci', name: 'Record emitter', formats: ['shipped/1'] }] });
    expect(f.nodes.find((n) => n.id === 'agent/example-ci')?.description).toBe('The machine that emits shipped/1 for this repository and signs each record as agent/example-ci.');
    expect(f.edges.find((e) => e.type === 'operates')).toMatchObject({ from: 'org/example', to: 'agent/example-ci', scope: ['shipped/1'] });
    expect(f.edges.find((e) => e.type === 'delegatedTo')).toMatchObject({ from: 'person/alice', to: 'agent/example-ci', scope: ['shipped/1'] });
    expect(() => emit({ emitters: [{ id: 'bot/x', name: 'x', formats: [] }] })).toThrow(/agent\/<slug>/);
  });
  it('declares properties and uses the first as the surface host', () => {
    const served = ['public/.well-known/flashyos-charter.json', 'public/.well-known/shiplog.json'];
    const { fragment: f, externals } = emit({ properties: [{ domain: 'example.org', name: 'example.org' }], served, platform: 'infra', vertical: 'v' });
    expect(f.nodes.find((n) => n.id === 'prop/example.org')).toMatchObject({ kind: 'Property', url: 'https://example.org', tenure: 'freehold', platform: 'infra', vertical: 'v' });
    expect(f.edges.find((e) => e.type === 'operates' && e.to === 'prop/example.org')).toBeTruthy();
    expect(f.nodes.find((n) => n.id === 'src/example-aao-0-1')).toMatchObject({ kind: 'Source', name: 'aao/0.1 — example', url: 'https://example.org/.well-known/flashyos-charter.json' });
    expect(f.nodes.find((n) => n.id === 'src/example-shipped-1')?.url).toBe('https://example.org/.well-known/shiplog.json');
    expect(f.edges.filter((e) => e.type === 'cites').map((e) => e.to).sort()).toEqual(['std/aao-0-1', 'std/shipped-1']);
    expect(externals.ids).toEqual(['person/alice', 'std/aao-0-1', 'std/shipped-1']);
    expect(validateDirectory(f, externals.ids)).toEqual([]);
  });
  it('declares no surface it cannot see on disk, and no URL when there is no host', () => {
    expect(emit({ served: ['public/.well-known/backlog.json', 'nope.json'] }).fragment.nodes.filter((n) => n.kind === 'Source').map((n) => n.id)).toEqual(['src/example-backlog-1']);
    const { fragment: f } = emit({ served: ['public/.well-known/checkpoint.json'], surfaceHost: null });
    expect(f.nodes.find((n) => n.kind === 'Source')?.url).toBeUndefined();
    expect(profileSlug('aao/0.1')).toBe('aao-0-1');
  });
  it('refuses malformed options', () => {
    expect(() => emit({ asserted: '24-09-2026' })).toThrow(TypeError);
    expect(() => emit({ assertedBy: 'agent/x' })).toThrow(/person\//);
  });
});

describe('validateDirectory', () => {
  it('accepts a minimal fragment and refuses a non-object', () => {
    expect(validateDirectory(minimal(), EXT)).toEqual([]);
    expect(codes(minimal(), [])).toEqual(['unresolved-endpoint']);
    expect(codes(null)).toEqual(['not-an-object']);
  });
  it('checks the fragment header', () => {
    expect(codes({ ...minimal(), directory: '1' })).toEqual(['bad-version']);
    expect(codes({ ...minimal(), source: '' })).toEqual(['no-source']);
    expect(codes({ ...minimal(), generated: 'yesterday' })).toEqual(['bad-generated']);
  });
  it('checks node ids, kinds, prefixes, names and provenance', () => {
    const f = minimal();
    expect(codes(fragment([node('org/x', 'Organization'), node('org/x', 'Organization')], f.edges))).toEqual(['duplicate-id']);
    expect(codes(fragment([node('Org/x', 'Organization')], []))).toEqual(['bad-id', 'prefix-mismatch', 'no-accountable-human']);
    expect(codes(fragment([node('org/x', 'Company' as 'Organization')], f.edges))).toEqual(['bad-kind']);
    expect(codes(fragment([node('agent/x', 'Organization')], [edge('accountableFor', 'person/alice', 'agent/x')]))).toEqual(['prefix-mismatch']);
    expect(codes(fragment([node('org/x', 'Organization', { name: ' ' })], f.edges))).toEqual(['no-name']);
    expect(codes(fragment([node('org/x', 'Organization', { asserted: 'x', expires: 'y' })], f.edges))).toEqual(['bad-asserted', 'bad-expires']);
    expect(codes(fragment([node('org/x', 'Organization', { expires: '2026-09-24' })], f.edges))).toEqual(['expires-before-asserted']);
    expect(codes(fragment([node('org/x', 'Organization', { assertedBy: 'alice' })], f.edges))).toEqual(['no-asserter']);
    expect(codes(fragment([node('org/x', 'Organization', { visibility: 'secret' })], f.edges))).toEqual(['bad-visibility']);
  });
  it('checks edge types, endpoints and externals resolution', () => {
    const f = minimal();
    expect(codes(fragment(f.nodes, [edge('accountableFor', 'person/alice', 'org/x'), edge('likes' as 'owns', 'org/x', 'org/x')]))).toEqual(['bad-edge-type']);
    // As in check-directory.mjs: a malformed `from` is reported, and the edge still counts as the org's accountableFor.
    expect(codes(fragment(f.nodes, [edge('accountableFor', 'alice', 'org/x')]))).toEqual(['bad-endpoint']);
    expect(codes(fragment(f.nodes, [edge('accountableFor', 'person/alice', 'org/x'), edge('cites', 'org/x', 'std/aao-0-1')]))).toEqual(['unresolved-endpoint']);
    expect(codes(fragment(f.nodes, [edge('accountableFor', 'person/alice', 'org/x'), edge('cites', 'org/x', 'std/aao-0-1')]), [...EXT, 'std/aao-0-1'])).toEqual([]);
    const finding = validateDirectory(fragment(f.nodes, [edge('accountableFor', 'person/alice', 'org/x'), edge('cites', 'org/x', 'std/aao-0-1')]), EXT)[0]!;
    expect(finding.path).toBe('org/x·cites·std/aao-0-1');
  });
  it('rejects a contested definition', () => {
    const nodes = [node('org/a', 'Organization'), node('org/b', 'Organization'), node('std/s', 'Standard')];
    const edges = [edge('accountableFor', 'person/alice', 'org/a'), edge('accountableFor', 'person/alice', 'org/b'), edge('defines', 'org/a', 'std/s'), edge('defines', 'org/b', 'std/s')];
    expect(validateDirectory(fragment(nodes, edges), EXT)).toEqual([{ code: 'contested-claim', path: 'std/s', message: 'org/a and org/b both define it', severity: 'error' }]);
  });
  it('requires what each edge type must carry, and the role only when declares names an agent', () => {
    const nodes = [node('agent/x-bot', 'Agent'), node('org/x', 'Organization'), node('src/x-aao', 'Source')];
    const ok = [edge('accountableFor', 'person/alice', 'org/x')];
    expect(codes(fragment(nodes, [...ok, edge('delegatedTo', 'person/alice', 'agent/x-bot')]))).toEqual(['delegatedTo-no-scope']);
    expect(codes(fragment(nodes, [...ok, edge('declares', 'org/x', 'agent/x-bot')]))).toEqual(['declares-no-role']);
    expect(codes(fragment(nodes, [...ok, edge('declares', 'org/x', 'agent/x-bot', { role: '' })]))).toEqual(['declares-no-role']);
    expect(codes(fragment(nodes, [...ok, edge('declares', 'org/x', 'src/x-aao')]))).toEqual([]);
    expect(missingRequired({ type: 'owns', to: 'org/y' })).toEqual(['pct', 'instrument', 'since']);
    expect(missingRequired({ type: 'settled', to: 'txn/1', sealed: true, capability: 'post' })).toEqual([]);
    for (const t of EDGE_TYPES) expect(EDGE_REQUIRES[t]).toBeDefined();
  });
  it('applies the owns, controls and holds rules', () => {
    const nodes = [node('inst/i', 'Instrument'), node('org/x', 'Organization'), node('org/y', 'Organization')];
    const ok = [edge('accountableFor', 'person/alice', 'org/x'), edge('accountableFor', 'person/alice', 'org/y')];
    const owns = (extra: Record<string, unknown>) => edge('owns', 'org/x', 'org/y', { pct: 10, instrument: 'inst/i', since: '2026-01-01', visibility: 'private', ...extra });
    expect(codes(fragment(nodes, [...ok, owns({})]))).toEqual([]);
    expect(codes(fragment(nodes, [...ok, owns({ pct: 0 })]))).toEqual(['owns-bad-pct']);
    expect(codes(fragment(nodes, [...ok, owns({ pct: 101 })]))).toEqual(['owns-bad-pct']);
    expect(codes(fragment(nodes, [...ok, owns({ visibility: 'public' })]))).toEqual(['owns-public']);
    const controls = (extra: Record<string, unknown>) => edge('controls', 'org/x', 'org/y', { basis: 'board', since: '2026-01-01', ...extra });
    expect(codes(fragment(nodes, [...ok, controls({})]))).toEqual([]);
    expect(codes(fragment(nodes, [...ok, controls({ pct: 51 })]))).toEqual(['controls-has-pct']);
    expect(codes(fragment(nodes, [...ok, controls({ visibility: 'private' })]))).toEqual(['controls-not-public']);
    expect(codes(fragment(nodes, [...ok, edge('holds', 'org/x', 'inst/i', { qty: 5, unit: 'BTC' })]))).toEqual([]);
    expect(codes(fragment(nodes, [...ok, edge('holds', 'org/x', 'inst/i', { qty: '5', unit: 'BTC' })]))).toEqual(['holds-no-qty']);
  });
  it('requires every organisation to name a human, and nodes to be sorted', () => {
    expect(codes(fragment([node('org/x', 'Organization')], []))).toEqual(['no-accountable-human']);
    const f = minimal();
    expect(codes(fragment([node('person/zed', 'Person'), ...f.nodes], f.edges))).toEqual(['unsorted']);
    expect(directorySummary(f, [])).toBe('repo/x — 1 nodes · 1 edges · 0 problem(s)');
  });
});
