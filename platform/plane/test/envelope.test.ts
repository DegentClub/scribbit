import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { destinationPermitted, envelopeForRole, parseEnvelopeInput, policyGrade } from '../src/envelope.ts';
import { parseOperationRecord, type OperationRecord } from '../src/record.ts';
import { envelopeInput, MAIN_P2TR, MAIN_P2WPKH, TEST_P2WPKH, transfer } from './helpers.ts';

const rec = (v: unknown): OperationRecord => {
  const r = parseOperationRecord(v);
  if (!r.ok) throw new Error(r.reason);
  return r.record;
};

describe('SpendEnvelopeInput', () => {
  it('fills FlashyOS defaults (alwaysEscalate false, escalationImpact MEDIUM) and ours (active true), normalising addresses', () => {
    const r = parseEnvelopeInput(envelopeInput({ destinations: [MAIN_P2WPKH.toUpperCase(), 'payee:artist'] }));
    expect(r).toEqual({ ok: true, value: { chain: 'btc:mainnet', kinds: ['transfer'], assets: ['native'], destinations: [MAIN_P2WPKH, 'payee:artist'], perTxMax: '100000', dailyMax: '250000', autoApproveMax: '50000', alwaysEscalate: false, escalationImpact: 'MEDIUM', active: true } });
  });
  it('reports every problem at once', () => {
    const r = parseEnvelopeInput({ chain: 'btc:mainnet', kinds: ['transfer', 'transfer', 'mint'], assets: [''], destinations: [TEST_P2WPKH, 'payee:friend'], perTxMax: '-1', dailyMax: 5, autoApproveMax: '1', escalationImpact: 'LOW', humanApprovalAtOrAbove: 'SEVERE', active: 'yes', alwaysEscalate: 1, extra: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBe(11);
  });
  it('refuses delegation and chains the plane does not authorize', () => {
    expect(parseEnvelopeInput(envelopeInput({ delegable: true as unknown as false }))).toMatchObject({ ok: false, errors: [expect.stringContaining('delegation is not implemented')] });
    expect(parseEnvelopeInput(envelopeInput({ delegable: false })).ok).toBe(true);
    expect(parseEnvelopeInput(envelopeInput({ chain: 'evm:8453', destinations: ['0xabc'] }), { chains: ['btc:mainnet'] })).toMatchObject({ ok: false });
    expect(parseEnvelopeInput(envelopeInput({ chain: 'evm:8453', destinations: ['0xABC'] })).ok).toBe(true);
  });
  it('an empty destination list is valid and permits nothing but an internal swap', () => {
    const r = parseEnvelopeInput(envelopeInput({ destinations: [] }));
    expect(r.ok).toBe(true);
    expect(destinationPermitted({ destinations: [] }, rec(transfer(1)))).toEqual({ ok: false });
    expect(destinationPermitted({ destinations: [] }, rec({ kind: 'swap', chain: 'btc:mainnet', asset: 'native', amount: '1', destination: null }))).toEqual({ ok: true, via: 'internal swap' });
  });
});

describe('destinations: exact addresses and payee classes (ours)', () => {
  const env = { destinations: [MAIN_P2WPKH, 'payee:artist'] };
  it('an exact address matches after normalisation', () => {
    expect(destinationPermitted(env, rec(transfer(1, MAIN_P2WPKH.toUpperCase())))).toEqual({ ok: true, via: 'exact address' });
  });
  it('payee:<kind> matches a record naming a payee of that kind, and no other kind', () => {
    expect(destinationPermitted(env, rec(transfer(1, MAIN_P2TR, { payee: { kind: 'artist', ref: 'ada' } })))).toEqual({ ok: true, via: 'payee:artist' });
    expect(destinationPermitted(env, rec(transfer(1, MAIN_P2TR, { payee: { kind: 'club', ref: 'c' } })))).toEqual({ ok: false });
    expect(destinationPermitted(env, rec(transfer(1, MAIN_P2TR)))).toEqual({ ok: false });
  });
});

describe('grading policy: autoApproveMax, alwaysEscalate, humanApprovalAtOrAbove', () => {
  const base = { autoApproveMax: '50000', alwaysEscalate: false, escalationImpact: 'MEDIUM' as const };
  it('FlashyOS rule (no threshold): at or below autoApproveMax LOW and allowed, above escalates at escalationImpact', () => {
    expect(policyGrade(base, 50_000n)).toMatchObject({ impact: 'LOW', escalate: false });
    expect(policyGrade(base, 50_001n)).toMatchObject({ impact: 'MEDIUM', escalate: true });
    expect(policyGrade({ ...base, escalationImpact: 'CRITICAL' }, 50_001n)).toMatchObject({ impact: 'CRITICAL', escalate: true });
  });
  it('alwaysEscalate escalates every amount', () => {
    expect(policyGrade({ ...base, alwaysEscalate: true, escalationImpact: 'HIGH' }, 1n)).toMatchObject({ impact: 'HIGH', escalate: true });
  });
  it('the role threshold decides which impacts need a person', () => {
    // LOW: every spend goes to a person, even small ones
    expect(policyGrade({ ...base, humanApprovalAtOrAbove: 'LOW' }, 1n)).toMatchObject({ impact: 'LOW', escalate: true });
    // CRITICAL: a MEDIUM-impact spend above autoApproveMax does not need a person; a CRITICAL one does
    expect(policyGrade({ ...base, humanApprovalAtOrAbove: 'CRITICAL' }, 60_000n)).toMatchObject({ impact: 'MEDIUM', escalate: false });
    expect(policyGrade({ ...base, humanApprovalAtOrAbove: 'CRITICAL', escalationImpact: 'CRITICAL' }, 60_000n)).toMatchObject({ impact: 'CRITICAL', escalate: true });
    expect(policyGrade({ ...base, humanApprovalAtOrAbove: 'HIGH', escalationImpact: 'HIGH' }, 50_000n)).toMatchObject({ impact: 'LOW', escalate: false });
  });
});

describe('envelopeForRole: the charter role supplies humanApprovalAtOrAbove', () => {
  const charter = JSON.parse(readFileSync(new URL('../../../flashy/charter.json', import.meta.url), 'utf8')) as { roles: { name: string; humanApprovalAtOrAbove?: string }[] };
  it('maps this repository\'s own charter roles', () => {
    expect(envelopeForRole(charter, 'settlement', envelopeInput()).humanApprovalAtOrAbove).toBe('CRITICAL');
    expect(envelopeForRole(charter, 'agent-gateway', envelopeInput()).humanApprovalAtOrAbove).toBe('MEDIUM');
    expect(envelopeForRole(charter, 'inscription-engine', envelopeInput()).humanApprovalAtOrAbove).toBe('LOW');
    expect(parseEnvelopeInput(envelopeForRole(charter, 'settlement', envelopeInput())).ok).toBe(true);
  });
  it('refuses a role the charter does not have, or a threshold that is not an impact', () => {
    expect(() => envelopeForRole(charter, 'treasurer', envelopeInput())).toThrow(/no role/);
    expect(() => envelopeForRole({ roles: [{ name: 'x', humanApprovalAtOrAbove: 'SOMETIMES' }] }, 'x', envelopeInput())).toThrow(/not an impact/);
    expect(envelopeForRole({ roles: [{ name: 'x' }] }, 'x', envelopeInput()).humanApprovalAtOrAbove).toBeUndefined();
  });
});
