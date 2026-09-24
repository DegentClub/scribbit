// This repository's own published files (flashy/ at the repo root) conform, and are
// what `pnpm mesh:emit` produces from their sources - the same gate CI runs.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Charter } from '../src/charter.ts';
import { runCli } from '../src/cli.ts';
import type { DirectoryFragment } from '../src/directory.ts';
import type { Frontdoor } from '../src/frontdoor.ts';
import { checkpointHead, claimsOf } from '../src/checkpoint.ts';
import { RECORD_PATHS, readRecordsConfig } from '../src/records.ts';
import { type ShippedFragment, verifyEntry } from '../src/shipped.ts';

const FLASHY = fileURLToPath(new URL('../../../flashy/', import.meta.url));
const read = <T>(rel: string): T => JSON.parse(readFileSync(path.join(FLASHY, rel), 'utf8')) as T;

describe.skipIf(!existsSync(FLASHY))('flashy/ (this repository\'s published files)', () => {
  it('passes `mesh check` with no findings', async () => {
    let out = '';
    const code = await runCli(['check', FLASHY, '--json'], { stdout: (s) => (out += s), stderr: () => {} });
    expect(JSON.parse(out)).toMatchObject({ ok: true, findings: [] });
    expect(code).toBe(0);
  });
  it('declares scribb.it with the four roles, and the served copies are the source', () => {
    const charter = read<Charter>('charter.json');
    expect(charter).toMatchObject({ aao: '0.1', slug: 'scribbit', name: 'scribb.it', escalation: 'settlement' });
    expect(charter.roles.map((r) => `${r.name}:${r.family}:${r.humanApprovalAtOrAbove}`)).toEqual([
      'inscription-engine:engineering:LOW', 'fee-oracle:data:LOW', 'agent-gateway:engineering:MEDIUM', 'settlement:finance:CRITICAL',
    ]);
    expect(charter['x-bitcoin']).toMatchObject({ chains: ['btc:mainnet', 'btc:testnet4', 'btc:signet'] });
    expect(read('public/.well-known/flashyos-charter.json')).toEqual(charter);
    expect(read('public/flashyos.roles.json')).toEqual(charter);
  });
  it('the accountable human is still the placeholder the README says to replace', () => {
    expect(read<Charter>('charter.json').accountableTo).toBe('accountable@scribb.it');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('accountable@scribb.it');
    expect(readme).toContain('person/bsh-accountable');
  });
  it('opens the door at scribb.it with four lanes and rungs 0-3', () => {
    const door = read<Frontdoor>('public/.well-known/frontdoor.json');
    expect(door).toMatchObject({ frontdoor: '1', property: 'scribbit', org: 'blockspace-holdings', endpoint: 'https://scribb.it/frontdoor', ladder: 'https://scribb.it/engage/', updated: '2026-09-24' });
    expect(door.lanes.map((l) => l.id)).toEqual(['integrate', 'partnership', 'machine', 'general']);
    expect(door.rungs.map((r) => r.n)).toEqual([0, 1, 2, 3]);
  });
  it('the directory fragment names the org, its agents, the property and the charter surface it serves', () => {
    const fragment = read<DirectoryFragment>('public/directory.fragment.json');
    expect(fragment.source).toBe('repo/scribbit');
    expect(fragment.nodes.map((n) => n.id)).toEqual([
      'agent/scribbit-agent-gateway', 'agent/scribbit-fee-oracle', 'agent/scribbit-inscription-engine', 'agent/scribbit-records', 'agent/scribbit-settlement', 'org/scribbit', 'prop/scribb.it',
      'src/scribbit-aao-0-1', 'src/scribbit-checkpoint-1', 'src/scribbit-shipped-1',
    ]);
    expect(fragment.nodes.find((n) => n.id === 'src/scribbit-aao-0-1')?.url).toBe('https://scribb.it/.well-known/flashyos-charter.json');
    expect(fragment.nodes.find((n) => n.id === 'src/scribbit-shipped-1')?.url).toBe('https://scribb.it/.well-known/shiplog.json');
    expect(fragment.nodes.find((n) => n.id === 'src/scribbit-checkpoint-1')?.url).toBe('https://scribb.it/.well-known/checkpoint.json');
    expect(read<{ ids: string[] }>('directory.externals.json').ids).toEqual(['person/bsh-accountable', 'std/aao-0-1', 'std/checkpoint-1', 'std/shipped-1']);
  });
  it('the records: a public log sealed by agent/scribbit-records, its projection served, and a head over it at origin https://scribb.it', () => {
    const config = readRecordsConfig(read('shiplog.config.json'));
    expect(config).toMatchObject({ source: 'repo/scribbit', org: 'org/scribbit', assertedBy: 'agent/scribbit-records', defaultAuthor: 'person/bsh-accountable', visibility: 'public', origin: 'https://scribb.it', authors: { 'noreply@anthropic.com': 'agent/unattributed' } });
    const fragment = read<ShippedFragment>(RECORD_PATHS.fragment);
    expect(fragment.entries.length).toBeGreaterThan(0);
    expect(fragment.entries.every((e) => verifyEntry(e as unknown as Record<string, unknown>).ok && e.assertedBy === 'agent/scribbit-records' && e.repo === 'repo/scribbit')).toBe(true);
    // A machine's address is never filed under the accountable person.
    expect(fragment.entries.some((e) => e.by.includes('person/bsh-accountable'))).toBe(false);
    const served = read<ShippedFragment>(RECORD_PATHS.shiplog);
    expect(served.entries.every((e) => e.visibility === 'public')).toBe(true);
    expect(read(RECORD_PATHS.devlog)).toMatchObject({ devlog: '1', source: 'repo/scribbit' });
    const head = read<{ root: string; size: number; at: string }>(RECORD_PATHS.checkpoint);
    const expected = checkpointHead(claimsOf([served, read('public/directory.fragment.json')]), 'https://scribb.it', served.generated);
    expect(head).toEqual(expected);
    expect(head.at).toBe(fragment.generated);
    expect(existsSync(path.join(FLASHY, RECORD_PATHS.checkpointSigned))).toBe(false); // signed only when an operator provides MESH_CHECKPOINT_KEY; never committed by CI
  });
});
