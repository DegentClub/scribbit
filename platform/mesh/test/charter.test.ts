import { describe, expect, it } from 'vitest';
import { assertCharter, type Charter, charterSummary, defaultRepository, FAMILIES, isCharter, PLACEHOLDER_EMAIL, validateCharter } from '../src/charter.ts';

const valid = (): Charter => ({
  aao: '0.1',
  name: 'Example Org',
  slug: 'example-org',
  description: 'An organisation that exists to be validated.',
  accountableTo: 'someone@example.org',
  escalation: 'coordination',
  repositories: [{ name: 'example', url: 'github.com/example/example', holds: ['src'], default: true }],
  roles: [
    { name: 'settlement', family: 'finance', purpose: 'Moves value once.', capabilities: ['post', 'reverse'], humanApprovalAtOrAbove: 'CRITICAL', worksIn: ['example'] },
    { name: 'coordination', family: 'governance', purpose: 'Settles conflicts between roles.', capabilities: ['arbitrate'], humanApprovalAtOrAbove: 'MEDIUM' },
  ],
});

const codes = (doc: unknown): string[] => validateCharter(doc).map((f) => f.code);
const at = (doc: unknown, code: string): string[] => validateCharter(doc).filter((f) => f.code === code).map((f) => f.path);

describe('validateCharter', () => {
  it('accepts a conformant charter, x- extensions included', () => {
    expect(validateCharter(valid())).toEqual([]);
    expect(validateCharter({ ...valid(), 'x-comment': ['free text'], 'x-bitcoin': { networks: ['mainnet'] } })).toEqual([]);
    expect(isCharter(valid())).toBe(true);
    expect(assertCharter(valid()).slug).toBe('example-org');
  });
  it('refuses anything but a JSON object', () => {
    expect(codes(null)).toEqual(['not-an-object']);
    expect(codes([])).toEqual(['not-an-object']);
    expect(codes('charter')).toEqual(['not-an-object']);
  });
  it('requires aao "0.1", a name, a url-safe slug and a description', () => {
    expect(codes({ ...valid(), aao: '0.2' })).toEqual(['aao-version']);
    expect(codes({ ...valid(), name: '  ' })).toEqual(['name-missing']);
    expect(at({ ...valid(), slug: 'Example' }, 'slug-invalid')).toEqual(['slug']);
    expect(codes({ ...valid(), slug: 'a--b' })).toEqual(['slug-invalid']);
    expect(codes({ ...valid(), slug: 'a1-b2' })).toEqual([]);
    expect(codes({ ...valid(), description: '' })).toEqual(['description-missing']);
  });
  it('requires a reachable human: an email, and never the template placeholder', () => {
    expect(codes({ ...valid(), accountableTo: 'nobody' })).toEqual(['accountable-not-email']);
    expect(codes({ ...valid(), accountableTo: 'a@b' })).toEqual(['accountable-not-email']);
    expect(codes({ ...valid(), accountableTo: 'a@b.c' })).toEqual([]);
    expect(codes({ ...valid(), accountableTo: PLACEHOLDER_EMAIL })).toEqual(['accountable-placeholder']);
    expect(codes({ ...valid(), accountableTo: undefined })).toEqual(['accountable-not-email']);
  });
  it('rejects bare keys outside aao 0.1 and points at the key', () => {
    const doc = { ...valid(), website: 'https://example.org' } as unknown;
    expect(validateCharter(doc)).toEqual([{ code: 'unknown-top-key', path: 'website', message: 'not part of aao 0.1 — prefix "x-" to carry it as an explicit extension', severity: 'error' }]);
    expect(codes({ ...valid(), network: { anything: true } })).toEqual([]);
  });
  it('allows at most one default repository', () => {
    const doc = { ...valid(), repositories: [{ name: 'a', default: true }, { name: 'b', default: true }] };
    expect(codes(doc)).toContain('repositories-multiple-default');
    expect(codes({ ...valid(), repositories: 'nope' })).toContain('repositories-not-array');
  });
  it('requires a non-empty list of roles', () => {
    expect(codes({ ...valid(), roles: [], escalation: undefined })).toEqual(['roles-empty']);
    expect(codes({ ...valid(), roles: undefined, escalation: undefined })).toEqual(['roles-empty']);
    expect(codes({ ...valid(), roles: [null], escalation: undefined })).toEqual(['role-not-object']);
  });
  it('names roles for the function performed: lowercase, hyphens, 3-24 characters, at most three words, unique', () => {
    const role = (name: string) => ({ ...valid(), escalation: undefined, roles: [{ name, purpose: 'p' }] });
    expect(codes(role('Settlement'))).toEqual(['role-name-invalid']);
    expect(codes(role('settle_ment'))).toEqual(['role-name-invalid']);
    expect(codes(role('-abc'))).toEqual(['role-name-invalid']);
    expect(codes(role('1abc'))).toEqual(['role-name-invalid']);
    expect(codes(role('ab'))).toEqual(['role-name-length']);
    expect(codes(role('a'.repeat(25)))).toEqual(['role-name-length']);
    expect(codes(role('a'.repeat(24)))).toEqual([]);
    expect(codes(role('one-two-three-four'))).toEqual(['role-name-words']);
    expect(codes(role('l2-relay'))).toEqual([]);
    const dup = { ...valid(), escalation: undefined, roles: [{ name: 'settlement', purpose: 'a' }, { name: 'settlement', purpose: 'b' }] };
    expect(validateCharter(dup)).toEqual([{ code: 'role-duplicate', path: 'roles[1]', message: 'duplicate role name "settlement"', severity: 'error' }]);
  });
  it('checks family, purpose, capabilities, approval level, worksIn and unknown keys per role', () => {
    const one = (patch: Record<string, unknown>) => ({ ...valid(), escalation: undefined, roles: [{ name: 'settlement', purpose: 'p', ...patch }] });
    expect(at(one({ family: 'sales' }), 'role-family-unknown')).toEqual(['roles[0].family']);
    for (const f of FAMILIES) expect(codes(one({ family: f }))).toEqual([]);
    expect(codes(one({ purpose: ' ' }))).toEqual(['role-purpose-missing']);
    expect(at(one({ capabilities: ['post', 'finance'] }), 'role-capability-is-family')).toEqual(['roles[0].capabilities']);
    expect(at(one({ humanApprovalAtOrAbove: 'low' }), 'role-approval-invalid')).toEqual(['roles[0].humanApprovalAtOrAbove']);
    expect(at(one({ worksIn: ['other'] }), 'role-worksin-unknown')).toEqual(['roles[0].worksIn']);
    expect(codes({ ...one({ worksIn: ['anything'] }), repositories: undefined })).toEqual([]);
    expect(at(one({ owner: 'x' }), 'role-unknown-key')).toEqual(['roles[0].owner']);
    expect(codes(one({ 'x-owner': 'x', renamedFrom: ['old-name'], measure: 'm' }))).toEqual([]);
  });
  it('requires escalation to name a declared role', () => {
    expect(codes({ ...valid(), escalation: 'nobody' })).toEqual(['escalation-unknown']);
    expect(codes({ ...valid(), escalation: undefined })).toEqual([]);
  });
  it('reports every problem at once, each with a stable code and path', () => {
    const findings = validateCharter({ aao: '0.1', name: 'x', slug: 'x', description: 'd', accountableTo: 'a@b.co', roles: [{ name: 'Bad Name', family: 'nope', humanApprovalAtOrAbove: 'x' }] });
    expect(findings.map((f) => `${f.code}@${f.path}`)).toEqual([
      'role-name-invalid@roles[0]',
      'role-family-unknown@roles[0].family',
      'role-purpose-missing@roles[0]',
      'role-approval-invalid@roles[0].humanApprovalAtOrAbove',
    ]);
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
  });
  it('assertCharter throws with every finding listed; the summary reads like check-charter.mjs', () => {
    expect(() => assertCharter({ ...valid(), aao: '2' })).toThrow(/aao: declares "2"/);
    expect(charterSummary(valid(), [])).toBe('Example Org — 2 role(s) · 0 problem(s)');
    expect(defaultRepository(valid())?.name).toBe('example');
    expect(defaultRepository({ ...valid(), repositories: [{ name: 'a' }, { name: 'b' }] })?.name).toBe('a');
  });
});
