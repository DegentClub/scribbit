import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@bsh/mesh';
import { approvalMessage, parseApprovalHeader, parseApprovers, signApproval, verifyApproval } from '../src/approval.ts';
import { MemoryNonceStore } from '../src/authorization.ts';
import { APPROVER_KEY, STRANGER_KEY, T0 } from './helpers.ts';

const approvers = parseApprovers([{ org: 'scribbit', name: 'alice', publicKey: APPROVER_KEY.publicKey }]);
const REQ = { method: 'PUT', path: '/v1/orgs/scribbit/wallet/envelopes/settlement', body: '{"chain":"btc:mainnet"}', apiKeyId: 'key-human' };
const now = new Date(T0);
const ctx = (over: Partial<Parameters<typeof verifyApproval>[1]> = {}) => ({ ...REQ, org: 'scribbit', approvers, now, nonces: new MemoryNonceStore(() => T0), ...over });
const header = (over: Partial<typeof REQ & { at: string }> = {}, key = APPROVER_KEY.privateKey) => signApproval(key, { ...REQ, at: now.toISOString(), ...over });

describe('X-Approval: the second factor for people', () => {
  it('signs the canonical request: method, path, body digest, calling key and time', () => {
    expect(approvalMessage({ ...REQ, method: 'put', at: '2026-09-24T10:00:00.000Z' }).toString()).toBe(
      `{"apiKeyId":"key-human","at":"2026-09-24T10:00:00.000Z","bodySha256":"${sha256Hex(REQ.body)}","method":"PUT","path":"/v1/orgs/scribbit/wallet/envelopes/settlement","v":"plane-approval/1"}`,
    );
    expect(parseApprovalHeader(header())).toEqual({ kid: approvers[0]!.kid, at: now.toISOString(), sig: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) });
  });
  it('accepts the listed approver\'s signature over exactly this request, once', async () => {
    const c = ctx();
    const h = header();
    expect(await verifyApproval(h, c)).toMatchObject({ ok: true, approver: { name: 'alice', org: 'scribbit' } });
    expect(await verifyApproval(h, c)).toMatchObject({ ok: false, code: 'approval_invalid', detail: expect.stringContaining('already used') });
  });
  it('approval_required without the header', async () => {
    expect(await verifyApproval(undefined, ctx())).toMatchObject({ ok: false, code: 'approval_required' });
  });
  it.each([
    ['another body', { body: '{"chain":"btc:signet"}' }],
    ['another path', { path: '/v1/orgs/scribbit/wallet/envelopes/fee-oracle' }],
    ['another method', { method: 'POST' }],
    ['another API key', { apiKeyId: 'key-agent' }],
  ])('is bound to the request: refused for %s', async (_what, over) => {
    expect(await verifyApproval(header(), ctx(over))).toMatchObject({ ok: false, code: 'approval_invalid' });
  });
  it('refuses a stranger\'s key, another organisation, a stale or future time, and garbage', async () => {
    expect(await verifyApproval(header({}, STRANGER_KEY.privateKey), ctx())).toMatchObject({ code: 'approval_invalid', detail: expect.stringContaining('not an approver') });
    expect(await verifyApproval(header(), ctx({ org: 'degent' }))).toMatchObject({ code: 'approval_invalid' });
    expect(await verifyApproval(header({ at: new Date(T0 - 300_001).toISOString() }), ctx())).toMatchObject({ code: 'approval_invalid', detail: expect.stringContaining('window') });
    expect(await verifyApproval(header({ at: new Date(T0 + 300_001).toISOString() }), ctx())).toMatchObject({ code: 'approval_invalid' });
    expect(await verifyApproval(header({ at: new Date(T0 - 299_000).toISOString() }), ctx())).toMatchObject({ ok: true });
    for (const junk of ['yes', 'kid=abc, at=now, sig=x', `kid=${approvers[0]!.kid}, kid=${approvers[0]!.kid}, at=${now.toISOString()}, sig=x`, 'x'.repeat(600)])
      expect(await verifyApproval(junk, ctx())).toMatchObject({ code: 'approval_invalid' });
    const h = header().replace(/sig=.*/, 'sig=AAAA');
    expect(await verifyApproval(h, ctx())).toMatchObject({ code: 'approval_invalid' });
  });
  it('approvers configuration: Ed25519 keys only, no duplicates per organisation', () => {
    expect(() => parseApprovers({})).toThrow(/array/);
    expect(() => parseApprovers([{ org: 'scribbit', name: 'bob', publicKey: 'nope' }])).toThrow(/Ed25519/);
    expect(() => parseApprovers([{ org: 'scribbit', publicKey: APPROVER_KEY.publicKey }])).toThrow(/org and name/);
    expect(() => parseApprovers([{ org: 'scribbit', name: 'a', publicKey: APPROVER_KEY.publicKey }, { org: 'scribbit', name: 'b', publicKey: APPROVER_KEY.publicKey }])).toThrow(/twice/);
    expect(parseApprovers([{ org: 'scribbit', name: 'a', publicKey: APPROVER_KEY.publicKey }, { org: 'degent', name: 'a', publicKey: APPROVER_KEY.publicKey }])).toHaveLength(2);
  });
});
