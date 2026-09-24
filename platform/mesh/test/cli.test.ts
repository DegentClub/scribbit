import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyCheckpointHead } from '../src/checkpoint.ts';
import { EXIT_FATAL, EXIT_FINDINGS, EXIT_OK, parseArgv, runCli } from '../src/cli.ts';
import { NOT_AUTHORITY } from '../src/frontdoor.ts';

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'mesh-cli-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = async (args: string[], cwd = root): Promise<{ code: number; out: string; err: string }> => {
  let out = '';
  let err = '';
  const code = await runCli(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd });
  return { code, out, err };
};
const json = async (args: string[], cwd = root): Promise<Record<string, unknown> & { findings?: { code: string }[] }> => JSON.parse((await run([...args, '--json'], cwd)).out) as never;
const write = (rel: string, value: unknown): string => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const read = (rel: string): unknown => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const charter = {
  aao: '0.1',
  name: 'Example',
  slug: 'example',
  description: 'An example organisation.',
  accountableTo: 'a@example.org',
  repositories: [{ name: 'example', default: true }],
  roles: [{ name: 'settlement', family: 'finance', purpose: 'Moves value once.', capabilities: ['post'] }],
};
const doorConfig = {
  property: 'example',
  org: 'example-org',
  lanes: [{ id: 'integrate', question: 'What?' }, { id: 'general' }],
  rungs: [{ n: 0, id: 'open', name: 'Open', did: 'd', owed: 'o', sla: 's' }, { n: 1, id: 'one', name: 'One', did: 'd', cost: 'c', owed: 'o', sla: 's' }],
  endpoint: 'https://example.org/frontdoor',
  ladder: 'https://example.org/engage/',
  updated: '2026-09-24',
};
const dirConfig = { asserted: '2026-09-24', expires: '2027-09-24', assertedBy: 'person/alice', properties: [{ domain: 'example.org', name: 'example.org' }] };

describe('parseArgv', () => {
  it('separates the command, positionals, value flags and boolean flags', () => {
    expect(parseArgv(['check-directory', 'f.json', '--externals', 'e.json', '--json'])).toEqual({ command: 'check-directory', positionals: ['f.json'], flags: { externals: 'e.json', json: true } });
    expect(parseArgv(['checkpoint', 'a', 'b', '--origin=repo/x', '--out', 'h.json'])).toEqual({ command: 'checkpoint', positionals: ['a', 'b'], flags: { origin: 'repo/x', out: 'h.json' } });
    expect(parseArgv([])).toEqual({ command: 'help', positionals: [], flags: {} });
    expect(() => parseArgv(['keygen', '--out'])).toThrow(/needs a value/);
  });
});

describe('mesh CLI', () => {
  it('prints usage, and exits 2 on an unknown command, a missing argument, a missing file and bad JSON', async () => {
    expect((await run(['help'])).code).toBe(EXIT_OK);
    expect((await run([])).out).toContain('mesh check-charter <file>');
    expect((await run(['frobnicate'])).code).toBe(EXIT_FATAL);
    expect((await run(['check-charter'])).code).toBe(EXIT_FATAL);
    expect((await run(['check-charter', 'nope.json'])).code).toBe(EXIT_FATAL);
    write('bad.json', '{not json');
    const r = await run(['check-charter', 'bad.json']);
    expect(r.code).toBe(EXIT_FATAL);
    expect(r.err).toContain('not valid JSON');
    expect(await json(['check-charter', 'bad.json'])).toMatchObject({ command: 'check-charter', ok: false, exit: EXIT_FATAL });
  });
  it('check-charter: 0 for a conformant charter, 1 with findings otherwise', async () => {
    write('charter.json', charter);
    expect(await run(['check-charter', 'charter.json'])).toMatchObject({ code: EXIT_OK });
    expect((await run(['check-charter', 'charter.json'])).out).toContain('Example — 1 role(s) · 0 problem(s)');
    write('charter-bad.json', { ...charter, aao: '0.2', roles: [] });
    const r = await run(['check-charter', 'charter-bad.json']);
    expect(r.code).toBe(EXIT_FINDINGS);
    expect(r.err).toContain('aao-version');
    const j = await json(['check-charter', 'charter-bad.json']);
    expect(j).toMatchObject({ command: 'check-charter', ok: false, exit: EXIT_FINDINGS });
    expect(j.findings!.map((f) => f.code)).toEqual(['aao-version', 'roles-empty']);
  });
  it('emit-charter and emit-frontdoor write only when the result conforms', async () => {
    write('charter.json', charter);
    expect((await run(['emit-charter', 'charter.json', 'out/a.json', 'out/b.json'])).code).toBe(EXIT_OK);
    expect(read('out/a.json')).toEqual(charter);
    expect(read('out/b.json')).toEqual(charter);
    write('charter-bad.json', { ...charter, slug: 'Bad' });
    expect((await run(['emit-charter', 'charter-bad.json', 'out/c.json'])).code).toBe(EXIT_FINDINGS);
    expect(existsSync(path.join(root, 'out/c.json'))).toBe(false);

    write('frontdoor.config.json', doorConfig);
    const j = await json(['emit-frontdoor', 'frontdoor.config.json', 'out/frontdoor.json']);
    expect(j).toMatchObject({ ok: true, written: ['out/frontdoor.json'] });
    expect(read('out/frontdoor.json')).toMatchObject({ frontdoor: '1', property: 'example', notAuthority: NOT_AUTHORITY });
    expect((await run(['check-frontdoor', 'out/frontdoor.json'])).code).toBe(EXIT_OK);
    write('frontdoor-bad.config.json', { ...doorConfig, lanes: [] });
    expect((await run(['emit-frontdoor', 'frontdoor-bad.config.json', 'out/bad-door.json'])).code).toBe(EXIT_FINDINGS);
    expect(existsSync(path.join(root, 'out/bad-door.json'))).toBe(false);
    write('door-broken.json', { ...read('out/frontdoor.json') as object, updated: 'today' });
    expect((await json(['check-frontdoor', 'door-broken.json'])).findings!.map((f) => f.code)).toEqual(['updated-not-date']);
  });
  it('emit-directory derives a fragment and its externals; check-directory resolves them', async () => {
    write('charter.json', charter);
    write('directory.config.json', dirConfig);
    const j = await json(['emit-directory', 'charter.json', 'out/directory.fragment.json', '--config', 'directory.config.json']);
    expect(j).toMatchObject({ ok: true, written: ['out/directory.fragment.json', 'directory.externals.json'] });
    const fragment = read('out/directory.fragment.json') as { nodes: { id: string }[] };
    expect(fragment.nodes.map((n) => n.id)).toEqual(['agent/example-settlement', 'org/example', 'prop/example.org']);
    expect(read('directory.externals.json')).toMatchObject({ ids: ['person/alice'] });
    expect((await run(['check-directory', 'out/directory.fragment.json', '--externals', 'directory.externals.json'])).code).toBe(EXIT_OK);
    const unresolved = await json(['check-directory', 'out/directory.fragment.json', '--externals', 'out/none.json']);
    expect(unresolved.exit).toBe(EXIT_FATAL);
    write('out/empty-externals.json', { ids: [] });
    expect((await json(['check-directory', 'out/directory.fragment.json', '--externals', 'out/empty-externals.json'])).findings!.map((f) => f.code)).toEqual(['unresolved-endpoint']);
    write('directory-bad.config.json', { expires: '2027-09-24' });
    expect((await run(['emit-directory', 'charter.json', 'out/x.json', '--config', 'directory-bad.config.json'])).code).toBe(EXIT_FATAL);
    write('charter-bad.json', { ...charter, roles: [] });
    expect((await run(['emit-directory', 'charter-bad.json', 'out/y.json', '--config', 'directory.config.json'])).code).toBe(EXIT_FINDINGS);
    expect(existsSync(path.join(root, 'out/y.json'))).toBe(false);
  });
  it('checkpoint builds a head over sealed claims, optionally signed, naming fragments it could not find', async () => {
    write('charter.json', charter);
    write('directory.config.json', dirConfig);
    await run(['emit-directory', 'charter.json', 'out/directory.fragment.json', '--config', 'directory.config.json']);
    write('out/shiplog.fragment.json', { shipped: '1', entries: [{ id: 'ship/example/aaaaaaaaaaaa', digest: 'a'.repeat(64) }, { id: 'ship/example/bbbbbbbbbbbb', digest: 'b'.repeat(64) }] });
    const j = await json(['checkpoint', 'out/shiplog.fragment.json', 'out/directory.fragment.json', 'out/missing.json', '--origin', 'repo/example', '--out', 'out/checkpoint.json', '--at', '2026-09-24T00:00:00.000Z']);
    expect(j).toMatchObject({ ok: true, missing: ['out/missing.json'], head: { checkpoint: '1', origin: 'repo/example', size: 2, at: '2026-09-24T00:00:00.000Z', counts: { shipped: 2 } } });
    expect(read('out/checkpoint.json')).toEqual(j.head);
    expect((await run(['checkpoint', '--origin', 'x', '--out', 'y'])).code).toBe(EXIT_FATAL);
    expect((await run(['checkpoint', 'out/shiplog.fragment.json'])).code).toBe(EXIT_FATAL);

    await run(['keygen', '--out', 'keys']);
    const signed = await json(['checkpoint', 'out/shiplog.fragment.json', '--origin', 'repo/example', '--out', 'out/signed.json', '--sign', 'keys/ed25519.key.pem']);
    expect(signed.ok).toBe(true);
    const head = read('out/signed.json');
    expect(verifyCheckpointHead(head, { trustedKeys: [readFileSync(path.join(root, 'keys/ed25519.pub.pem'), 'utf8')] })).toMatchObject({ ok: true });
  });
  it('keygen writes a 0600 private key, the public key, public.json, refuses to overwrite, and can add a BIP340 key', async () => {
    const j = await json(['keygen', '--out', 'keys2', '--bip340']);
    expect(j).toMatchObject({ ok: true, kid: expect.stringMatching(/^[0-9a-f]{64}$/), xonlyPubkeyHex: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(j.written).toEqual(['keys2/ed25519.key.pem', 'keys2/ed25519.pub.pem', 'keys2/bip340.secret.hex', 'keys2/bip340.xonly.hex', 'keys2/public.json']);
    expect(statSync(path.join(root, 'keys2/ed25519.key.pem')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(root, 'keys2/bip340.secret.hex')).mode & 0o777).toBe(0o600);
    expect(read('keys2/public.json')).toEqual({ kid: j.kid, publicKey: j.publicKey, xonlyPubkeyHex: j.xonlyPubkeyHex });
    expect(readFileSync(path.join(root, 'keys2/ed25519.pub.pem'), 'utf8')).toBe(j.publicKey);
    expect(JSON.stringify(j)).not.toContain('PRIVATE KEY');
    expect((await run(['keygen', '--out', 'keys2'])).code).toBe(EXIT_FATAL);
    expect((await run(['keygen'])).code).toBe(EXIT_FATAL);
  });
  it('emit <dir> regenerates every published file and check <dir> passes, then catches anything stale or missing', async () => {
    const dir = path.join(root, 'site');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'charter.json'), JSON.stringify(charter));
    writeFileSync(path.join(dir, 'frontdoor.config.json'), JSON.stringify(doorConfig));
    writeFileSync(path.join(dir, 'directory.config.json'), JSON.stringify(dirConfig));
    const emitted = await json(['emit', 'site']);
    expect(emitted).toMatchObject({ ok: true });
    expect(emitted.written).toEqual([
      'site/public/.well-known/flashyos-charter.json', 'site/public/flashyos.roles.json', 'site/public/.well-known/frontdoor.json', 'site/public/directory.fragment.json', 'site/directory.externals.json',
    ]);
    const fragment = read('site/public/directory.fragment.json') as { nodes: { id: string; url?: string }[] };
    expect(fragment.nodes.map((n) => n.id)).toEqual(['agent/example-settlement', 'org/example', 'prop/example.org', 'src/example-aao-0-1']);
    expect(fragment.nodes.find((n) => n.id === 'src/example-aao-0-1')?.url).toBe('https://example.org/.well-known/flashyos-charter.json');
    expect(read('site/directory.externals.json')).toMatchObject({ ids: ['person/alice', 'std/aao-0-1'] });

    const checked = await json(['check', 'site']);
    expect(checked).toMatchObject({ ok: true, exit: EXIT_OK, findings: [] });
    expect(checked.checked).toHaveLength(6);

    writeFileSync(path.join(dir, 'public/flashyos.roles.json'), JSON.stringify({ ...charter, name: 'Edited by hand' }));
    expect((await json(['check', 'site'])).findings!.map((f) => f.code)).toEqual(['charter-served-stale']);
    rmSync(path.join(dir, 'public/.well-known/frontdoor.json'));
    writeFileSync(path.join(dir, 'directory.config.json'), JSON.stringify({ ...dirConfig, expires: '2028-01-01' }));
    expect((await json(['check', 'site'])).findings!.map((f) => f.code)).toEqual(['charter-served-stale', 'frontdoor-not-served', 'directory-stale']);
    expect((await run(['check', 'site'])).code).toBe(EXIT_FINDINGS);
    expect((await run(['emit', 'site'])).code).toBe(EXIT_OK);
    expect((await run(['check', 'site'])).code).toBe(EXIT_OK);

    writeFileSync(path.join(dir, 'charter.json'), JSON.stringify({ ...charter, accountableTo: 'you@example.com' }));
    const bad = await json(['emit', 'site']);
    expect(bad).toMatchObject({ ok: false, exit: EXIT_FINDINGS });
    expect(bad.findings!.map((f) => f.code)).toEqual(['accountable-placeholder']);
    expect((await json(['check', 'site'])).findings!.map((f) => f.code)).toContain('accountable-placeholder');
  });
});
