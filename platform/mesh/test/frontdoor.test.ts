import { describe, expect, it } from 'vitest';
import { hasErrors } from '../src/common.ts';
import { emitFrontdoor, type Frontdoor, type FrontdoorConfig, frontdoorHtml, frontdoorSummary, isHttpsUrl, LANES, NOT_AUTHORITY, validateFrontdoor } from '../src/frontdoor.ts';

const config = (): FrontdoorConfig => ({
  property: 'example',
  org: 'example-org',
  voice: 'What are you building?',
  lanes: [{ id: 'integrate', question: 'What are you building on this?' }, { id: 'machine', question: 'Who delegated this authority?', minRung: 1 }, { id: 'general' }],
  rungs: [
    { n: 0, id: 'open', name: 'Open', did: 'You sent a message', detail: 'The ordinary form.', cost: 'Two minutes', owed: 'We read everything.', sla: 'No SLA — and we say so' },
    { n: 1, id: 'identified', name: 'Identified', did: 'You published a charter', cost: 'Twenty minutes', owed: 'A reply within five business days.', sla: 'Five business days' },
  ],
  endpoint: 'https://example.org/frontdoor',
  ladder: 'https://example.org/engage/',
  updated: '2026-09-24',
});

const codes = (doc: unknown): string[] => validateFrontdoor(doc).map((f) => f.code);

describe('NOT_AUTHORITY', () => {
  it('is the normative paragraph, verbatim', () => {
    expect(NOT_AUTHORITY).toBe(
      'A rung buys a reply and a place in a queue. It never buys authority, money, or access. ' +
        'Publishing a file at a domain proves that someone can write to that host — it does not prove ' +
        'an organisation is who it says it is, and this door does not treat it as though it did. ' +
        'Where real authority is needed it is delegated and verified through flashyID, and the chain is checked.',
    );
  });
});

describe('emitFrontdoor', () => {
  it('emits the door in emit-frontdoor.mjs key order, with the paragraph and without config-only keys', () => {
    const door = emitFrontdoor({ ...config(), out: 'x.json', htmlOut: 'y.html' });
    expect(Object.keys(door)).toEqual(['frontdoor', 'property', 'org', 'lanes', 'rungs', 'endpoint', 'ladder', 'updated', 'notAuthority']);
    expect(door.notAuthority).toBe(NOT_AUTHORITY);
    expect(validateFrontdoor(door)).toEqual([]);
  });
  it('renders a framework-free HTML partial with escaped content', () => {
    const html = frontdoorHtml(emitFrontdoor(config()), 'A <b>"voice"</b> & more');
    expect(html).toContain('A &lt;b&gt;&quot;voice&quot;&lt;/b&gt; &amp; more');
    expect(html).toContain('<span class="fd-lane-name">integrate</span>');
    expect(html).toContain('<link rel="frontdoor" href="/.well-known/frontdoor.json">');
    expect(html).not.toContain('<script');
  });
});

describe('validateFrontdoor', () => {
  const door = (): Frontdoor => emitFrontdoor(config());
  it('refuses a non-object and the wrong contract version', () => {
    expect(codes(null)).toEqual(['not-an-object']);
    expect(codes({ ...door(), frontdoor: 1 })).toEqual(['frontdoor-version']);
  });
  it('requires property, org, https endpoint and ladder, and an ISO date', () => {
    expect(codes({ ...door(), property: '' })).toEqual(['property-missing']);
    expect(codes({ ...door(), org: undefined })).toEqual(['org-missing']);
    expect(codes({ ...door(), endpoint: 'http://example.org/x' })).toEqual(['endpoint-not-https']);
    expect(codes({ ...door(), ladder: 'https://localhost/x' })).toEqual(['ladder-not-https']);
    expect(codes({ ...door(), updated: '2026-9-24' })).toEqual(['updated-not-date']);
    expect(isHttpsUrl('https://EXAMPLE.org')).toBe(true);
    expect(isHttpsUrl('https://example')).toBe(false);
  });
  it('requires notAuthority verbatim', () => {
    expect(codes({ ...door(), notAuthority: `${NOT_AUTHORITY} ` })).toEqual(['not-authority-drift']);
    expect(codes({ ...door(), notAuthority: undefined })).toEqual(['not-authority-drift']);
  });
  it('checks lanes: at least one, from the allowed set, opened once, with a question except general', () => {
    expect(codes({ ...door(), lanes: [] })).toEqual(['lanes-empty']);
    expect(codes({ ...door(), lanes: 'x' })).toEqual(['lanes-empty']);
    expect(codes({ ...door(), lanes: [{ id: 'sales', question: 'q' }] })).toEqual(['lane-unknown']);
    expect(codes({ ...door(), lanes: [{ id: 'general' }, { id: 'general' }] })).toEqual(['lane-duplicate']);
    expect(codes({ ...door(), lanes: [{ id: 'capital' }] })).toEqual(['lane-no-question']);
    for (const id of LANES) expect(codes({ ...door(), lanes: [{ id, question: 'q' }] })).toEqual([]);
  });
  it('checks rungs: a ladder, a rung 0, unique numbers, and did/owed/sla on each', () => {
    expect(codes({ ...door(), rungs: [] })).toEqual(['rungs-empty']);
    const r = door().rungs;
    expect(codes({ ...door(), lanes: [{ id: 'general' }], rungs: [r[1]] })).toEqual(['rung-0-missing']);
    expect(codes({ ...door(), rungs: [r[0], { ...r[1], n: 0 }] })).toEqual(['rung-duplicate-n', 'lane-min-rung-missing']);
    expect(validateFrontdoor({ ...door(), rungs: [{ ...r[0], sla: '' }, r[1]] })).toEqual([
      { code: 'rung-incomplete', path: 'rungs[0]', message: 'rung 0 does not state what was done, what is owed, and the promise', severity: 'error' },
    ]);
  });
  it('warns, and only warns, when a rung above 0 says nothing about cost', () => {
    const r = door().rungs;
    const findings = validateFrontdoor({ ...door(), rungs: [r[0], { ...r[1], cost: undefined }] });
    expect(findings).toEqual([{ code: 'rung-no-cost', path: 'rungs[1]', message: 'rung 1 does not say what it costs an applicant', severity: 'warning' }]);
    expect(hasErrors(findings)).toBe(false);
    expect(codes({ ...door(), rungs: [{ ...r[0], cost: undefined }, r[1]] })).toEqual([]);
  });
  it('requires a lane minRung to be a rung the door publishes', () => {
    expect(validateFrontdoor({ ...door(), lanes: [{ id: 'machine', question: 'q', minRung: 5 }] })).toEqual([
      { code: 'lane-min-rung-missing', path: 'lanes[0]', message: 'lane "machine" requires rung 5, which this door does not publish', severity: 'error' },
    ]);
  });
  it('summarises like check-frontdoor.mjs', () => {
    expect(frontdoorSummary(door(), [])).toBe('example — 3 lane(s) · 2 rung(s) · 0 problem(s)');
  });
});
