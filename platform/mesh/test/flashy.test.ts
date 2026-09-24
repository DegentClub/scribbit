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
      'agent/scribbit-agent-gateway', 'agent/scribbit-fee-oracle', 'agent/scribbit-inscription-engine', 'agent/scribbit-settlement', 'org/scribbit', 'prop/scribb.it', 'src/scribbit-aao-0-1',
    ]);
    expect(fragment.nodes.find((n) => n.id === 'src/scribbit-aao-0-1')?.url).toBe('https://scribb.it/.well-known/flashyos-charter.json');
    expect(read<{ ids: string[] }>('directory.externals.json').ids).toEqual(['person/bsh-accountable', 'std/aao-0-1']);
  });
});
