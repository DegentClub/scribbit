// Conformance against what FlashyLabs actually publishes (test/fixtures/flashy-ledger,
// Apache-2.0): our validators accept their files, our emitters re-derive them byte
// for byte, our seals recompute theirs, and our Merkle root is their checkpoint root.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '../src/canonical.ts';
import { type Charter, validateCharter } from '../src/charter.ts';
import { checkpointHead, claimsOf, inclusionProof, verifyInclusionProof } from '../src/checkpoint.ts';
import { type DirectoryFragment, directoryFromCharter, validateDirectory } from '../src/directory.ts';
import { emitFrontdoor, type FrontdoorConfig, validateFrontdoor } from '../src/frontdoor.ts';
import { type ShippedFragment, validateShipped, verifyEntry } from '../src/shipped.ts';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/flashy-ledger/${name}`, import.meta.url), 'utf8')) as T;
const charter = fixture<Charter>('flashyos.roles.json');
const fragment = fixture<DirectoryFragment>('directory.fragment.json');
const externals = fixture<{ ids: string[] }>('directory.externals.json');
const doorConfig = fixture<FrontdoorConfig>('frontdoor.config.json');
const door = fixture<unknown>('frontdoor.json');
const shiplog = fixture<ShippedFragment>('shiplog.fragment.json');
const head = fixture<{ size: number; root: string; counts: Record<string, number> }>('checkpoint.json');

describe('FlashyLabs flashy-ledger, as published', () => {
  it('its charter conforms under our validator', () => {
    expect(validateCharter(charter)).toEqual([]);
    expect(charter.roles).toHaveLength(9);
  });
  it('its door conforms, and our emitter re-derives it from its config', () => {
    expect(validateFrontdoor(door)).toEqual([]);
    expect(canonicalStringify(emitFrontdoor(doorConfig))).toBe(canonicalStringify(door));
  });
  it('its directory fragment conforms against its externals, and our emitter re-derives it from its charter', () => {
    expect(validateDirectory(fragment, externals.ids)).toEqual([]);
    const ours = directoryFromCharter(charter, {
      asserted: '2026-08-28',
      expires: '2027-08-28',
      assertedBy: 'person/michael',
      platform: 'infrastructure',
      vertical: 'flashy',
      emitters: [
        { id: 'agent/flashy-ledger-ci', name: 'Record emitter', formats: ['shipped/1'], description: "The workflow that derives and seals this repository's record. It emits shipped/1 on the default branch and signs each entry as agent/flashy-ledger-ci." },
        { id: 'agent/flashy-ledger-bot', name: 'Backlog emitter', formats: ['backlog/1'], description: "The tool that files and promotes this repository's intentions. It emits backlog/1 and signs each item as agent/flashy-ledger-bot." },
      ],
      served: ['public/.well-known/backlog.json', 'public/.well-known/shiplog.json', 'public/.well-known/checkpoint.json', 'public/.well-known/flashyos-charter.json'],
      surfaceHost: null,
    });
    expect(canonicalStringify(ours.fragment)).toBe(canonicalStringify(fragment));
    expect(ours.externals.ids).toEqual(externals.ids);
  });
  it('every one of its 88 seals recomputes, and the fragment validates', () => {
    expect(shiplog.entries).toHaveLength(88);
    const broken = shiplog.entries.map((e) => verifyEntry(e as unknown as Record<string, unknown>)).filter((c) => !c.ok);
    expect(broken).toEqual([]);
    expect(validateShipped(shiplog)).toEqual([]);
  });
  it('our RFC 6962 root over its claims is its published checkpoint root', () => {
    const claims = claimsOf([shiplog, fragment]);
    const ours = checkpointHead(claims, 'repo/flashy-ledger');
    expect(ours.size).toBe(head.size);
    expect(ours.root).toBe(head.root);
    expect(ours.counts).toEqual(head.counts);
    const proof = inclusionProof(claims, shiplog.entries[0]!.id)!;
    expect(verifyInclusionProof(proof, head.root)).toBe(true);
  });
});
