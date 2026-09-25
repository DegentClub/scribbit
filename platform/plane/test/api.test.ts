import { describe, expect, it } from 'vitest';
import { hashApiKey, generateApiKey } from '@bsh/edge';
import { validatePlaneDocument } from '@bsh/mesh';
import { verifyAuditChain, type AuditHead } from '../src/audit.ts';
import { verifyAuthorization, type SpendAuthorization } from '../src/authorization.ts';
import { appHarness, envelopeInput, MAIN_P2TR, MAIN_P2WPKH, ORG, STRANGER_KEY, transfer } from './helpers.ts';
import { assertSchema, expectContract, openapi } from './contract.ts';

const P = {
  propose: '/v1/orgs/{org}/wallet/propose',
  settle: '/v1/orgs/{org}/wallet/settle',
  envelopes: '/v1/orgs/{org}/wallet/envelopes/{agent}',
  decisions: '/v1/orgs/{org}/wallet/decisions',
  resolve: '/v1/orgs/{org}/wallet/decisions/{decisionId}/resolve',
};
const url = {
  propose: `/v1/orgs/${ORG}/wallet/propose`,
  settle: `/v1/orgs/${ORG}/wallet/settle`,
  envelopes: (a = 'settlement') => `/v1/orgs/${ORG}/wallet/envelopes/${a}`,
  decisions: `/v1/orgs/${ORG}/wallet/decisions`,
  resolve: (id: string) => `/v1/orgs/${ORG}/wallet/decisions/${id}/resolve`,
};
const TX = 'ab'.repeat(32);

async function ready() {
  const h = appHarness();
  const put = await h.humanPut('settlement', envelopeInput());
  expect(put.status).toBe(200);
  return h;
}

const errorCode = async (res: Response, status: number): Promise<string> => {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string } };
  assertSchema('Error', body);
  return body.error.code;
};

describe('contract file', () => {
  it('is OpenAPI 3.1 and declares every route the app serves', () => {
    expect(openapi.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(openapi.paths).sort()).toEqual(['/.well-known/flashyos-plane.json', '/v1/health', P.decisions, P.resolve, P.envelopes, P.propose, P.settle].sort());
  });
  it('its schemas bite: an ALLOW without an authorization, or an unknown denial code, is refused', () => {
    expect(() => assertSchema('Verdict', { verdict: 'ALLOW', decisionId: 'dec_1', reasons: [], impact: 'LOW' })).toThrow(/contract violation/);
    expect(() => assertSchema('Verdict', { verdict: 'DENY', code: 'NOPE', reason: 'x', reasons: [], decisionId: 'dec_1' })).toThrow(/contract violation/);
    expect(() => assertSchema('Verdict', { verdict: 'DENY', code: 'DAILY_CAP', reason: 'x', reasons: [], decisionId: 'dec_1' })).not.toThrow();
  });
  it('names the FlashyOS denial codes exactly', () => {
    expect(openapi.components.schemas.DenialCode.enum).toEqual(['SCOPE_MISSING', 'NO_ENVELOPE', 'ENVELOPE_INACTIVE', 'KIND_NOT_PERMITTED', 'ASSET_NOT_PERMITTED', 'DESTINATION_NOT_PERMITTED', 'PER_TX_CAP', 'DAILY_CAP', 'INVALID_AMOUNT', 'INVALID_RECORD']);
  });
});

describe('public routes', () => {
  it('GET /v1/health', async () => {
    const h = appHarness();
    expect(await expectContract(await h.req('/v1/health'), '/v1/health', 'get', 200)).toMatchObject({ status: 'ok', chains: ['btc:mainnet', 'btc:signet', 'btc:testnet'], ledger: false });
  });
  it('GET /.well-known/flashyos-plane.json is a valid plane document, never cached', async () => {
    const h = appHarness();
    const res = await h.req('/.well-known/flashyos-plane.json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const doc = await expectContract(res, '/.well-known/flashyos-plane.json', 'get', 200);
    expect(validatePlaneDocument(doc)).toEqual([]);
  });
});

describe('POST propose (wallet:propose)', () => {
  it('201 ALLOW with a verifiable authorization; 202 ESCALATE; 200 DENY - all in the contract', async () => {
    const h = await ready();
    const allow = await expectContract<{ authorization: SpendAuthorization }>(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(25_000) }), P.propose, 'post', 201);
    expect(await verifyAuthorization(allow.authorization, { trustedKeys: h.service.trustedKeys(), now: h.clock.now() })).toEqual({ ok: true });
    expect(await expectContract(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(60_000) }), P.propose, 'post', 202)).toMatchObject({ verdict: 'ESCALATE' });
    expect(await expectContract(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(1, MAIN_P2WPKH, { chain: 'btc:signet', destination: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }) }), P.propose, 'post', 200)).toMatchObject({ verdict: 'DENY', code: 'NO_ENVELOPE' });
    expect(await expectContract(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: { kind: 'transfer', amount: 'lots' } }), P.propose, 'post', 200)).toMatchObject({ verdict: 'DENY', code: 'INVALID_RECORD' });
  });
  it('a key without wallet:propose - the signer, a reader, a person - gets DENY SCOPE_MISSING, recorded', async () => {
    const h = await ready();
    for (const k of [h.keys.signer, h.keys.reader, h.keys.human])
      expect(await expectContract(await h.req(url.propose, { method: 'POST', key: k.key, json: transfer(1_000) }), P.propose, 'post', 200)).toMatchObject({ verdict: 'DENY', code: 'SCOPE_MISSING' });
    const log = await h.service.listAudit(ORG);
    expect(log.entries.filter((e) => e.kind === 'decision').map((e) => (e.data as { code?: string }).code)).toEqual(['SCOPE_MISSING', 'SCOPE_MISSING', 'SCOPE_MISSING']);
  });
  it('401 without a key; 403 org_mismatch for another organisation\'s agent (not recorded here)', async () => {
    const h = await ready();
    expect(await errorCode(await h.req(url.propose, { method: 'POST', json: transfer(1) }), 401)).toBe('missing_api_key');
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: 'bsh_test_nope', json: transfer(1) }), 401)).toBe('invalid_api_key');
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: h.keys.otherOrg.key, json: transfer(1) }), 403)).toBe('org_mismatch');
    expect((await h.service.listAudit(ORG)).entries.filter((e) => e.kind === 'decision')).toHaveLength(0);
  });
  it('400 for non-JSON, 415 for another media type, 400 for a bad Idempotency-Key, 422 for a reused one', async () => {
    const h = await ready();
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, body: '{nope', headers: { 'content-type': 'application/json' } }), 400)).toBe('invalid_json');
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, body: '[]', headers: { 'content-type': 'application/json' } }), 400)).toBe('invalid_request');
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, body: 'x', headers: { 'content-type': 'text/plain' } }), 415)).toBe('unsupported_media_type');
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(1), headers: { 'idempotency-key': 'no spaces' } }), 400)).toBe('invalid_idempotency_key');
    const first = await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(1_000), headers: { 'idempotency-key': 'op-1' } });
    expect(first.status).toBe(201);
    const replay = await expectContract<{ replayed?: boolean }>(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(1_000), headers: { 'idempotency-key': 'op-1' } }), P.propose, 'post', 201);
    expect(replay.replayed).toBe(true);
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(2_000), headers: { 'idempotency-key': 'op-1' } }), 422)).toBe('idempotency_conflict');
  });
});

describe('POST settle (wallet:settle, the signer only)', () => {
  it('the agent cannot report settlement (403); the signer can (200, in the contract), replay 200, conflict 409, unknown 404, bad 400', async () => {
    const h = await ready();
    const v = (await (await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(25_000) })).json()) as { authorization: SpendAuthorization };
    const body = { authorizationId: v.authorization.id, outcome: 'CONFIRMED', txHash: TX };
    expect(await errorCode(await h.req(url.settle, { method: 'POST', key: h.keys.agent.key, json: body }), 403)).toBe('insufficient_scope');
    expect(await errorCode(await h.req(url.settle, { method: 'POST', key: h.keys.human.key, json: body }), 403)).toBe('insufficient_scope');
    expect(await expectContract(await h.req(url.settle, { method: 'POST', key: h.keys.signer.key, json: body }), P.settle, 'post', 200)).toMatchObject({ authorization: { status: 'SPENT', txHash: TX }, reservation: { status: 'COMMITTED' }, anomaly: null });
    expect(await expectContract(await h.req(url.settle, { method: 'POST', key: h.keys.signer.key, json: body }), P.settle, 'post', 200)).toMatchObject({ replayed: true });
    expect(await errorCode(await h.req(url.settle, { method: 'POST', key: h.keys.signer.key, json: { ...body, outcome: 'REVERTED' } }), 409)).toBe('SETTLEMENT_CONFLICT');
    expect(await errorCode(await h.req(url.settle, { method: 'POST', key: h.keys.signer.key, json: { ...body, authorizationId: 'auth_nope' } }), 404)).toBe('AUTHORIZATION_NOT_FOUND');
    expect(await errorCode(await h.req(url.settle, { method: 'POST', key: h.keys.signer.key, json: { authorizationId: v.authorization.id } }), 400)).toBe('SETTLEMENT_INVALID');
  });
  it('a key holding both wallet:propose and wallet:settle is refused at the door even if a store hands one in', async () => {
    const h = await ready();
    const k = generateApiKey('test');
    h.apiKeyStore.add({ id: 'key-both', hash: hashApiKey(k.key), env: 'test', scopes: ['wallet:propose', 'wallet:settle'], ownerId: `${ORG}/rogue` });
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: k.key, json: transfer(1) }), 403)).toBe('insufficient_scope');
    expect(await errorCode(await h.req(url.settle, { method: 'POST', key: k.key, json: {} }), 403)).toBe('insufficient_scope');
    const n = generateApiKey('test');
    h.apiKeyStore.add({ id: 'key-noowner', hash: hashApiKey(n.key), env: 'test', scopes: ['wallet:propose'] });
    expect(await errorCode(await h.req(url.propose, { method: 'POST', key: n.key, json: transfer(1) }), 403)).toBe('not_a_plane_key');
  });
});

describe('envelopes (wallet:delegate + X-Approval)', () => {
  it('GET needs wallet:delegate; lists the current envelopes in the contract shape', async () => {
    const h = await ready();
    const list = await expectContract<{ envelopes: { version: number; setBy: { approver: string } }[] }>(await h.req(url.envelopes(), { key: h.keys.human.key }), P.envelopes, 'get', 200);
    expect(list.envelopes).toHaveLength(1);
    expect(list.envelopes[0]).toMatchObject({ version: 1, setBy: { approver: 'alice', apiKeyId: 'key-human' } });
    expect(await errorCode(await h.req(url.envelopes(), { key: h.keys.agent.key }), 403)).toBe('insufficient_scope');
    expect(await expectContract(await h.req(url.envelopes('nobody'), { key: h.keys.human.key }), P.envelopes, 'get', 200)).toMatchObject({ envelopes: [] });
    expect(await errorCode(await h.req(url.envelopes('Bad Name'), { key: h.keys.human.key }), 400)).toBe('invalid_request');
  });
  it('PUT: 200 with a valid approval; 403 without, with a replayed one, a stranger\'s, or one for another body', async () => {
    const h = await ready();
    const input = envelopeInput({ destinations: [MAIN_P2TR] });
    const body = JSON.stringify(input);
    const approval = h.approve('PUT', url.envelopes(), body);
    const ok = await expectContract<{ version: number; destinations: string[] }>(await h.humanPut('settlement', input, { approval }), P.envelopes, 'put', 200);
    expect(ok).toMatchObject({ version: 2, destinations: [MAIN_P2TR] });
    expect(await errorCode(await h.humanPut('settlement', input, { approval }), 403)).toBe('approval_invalid');
    expect(await errorCode(await h.req(url.envelopes(), { method: 'PUT', key: h.keys.human.key, body, headers: { 'content-type': 'application/json' } }), 403)).toBe('approval_required');
    expect(await errorCode(await h.humanPut('settlement', input, { approval: h.approve('PUT', url.envelopes(), body, 'key-human', STRANGER_KEY.privateKey) }), 403)).toBe('approval_invalid');
    expect(await errorCode(await h.humanPut('settlement', input, { approval: h.approve('PUT', url.envelopes(), JSON.stringify(envelopeInput())) }), 403)).toBe('approval_invalid');
    expect(await errorCode(await h.humanPut('settlement', input, { approval: h.approve('PUT', url.envelopes('fee-oracle'), body) }), 403)).toBe('approval_invalid');
  });
  it('an agent cannot set its own envelope even with a valid approval; an invalid envelope is 400', async () => {
    const h = await ready();
    const input = envelopeInput({ perTxMax: '999999999' });
    const body = JSON.stringify(input);
    expect(await errorCode(await h.req(url.envelopes(), { method: 'PUT', key: h.keys.agent.key, body, headers: { 'content-type': 'application/json', 'x-approval': h.approve('PUT', url.envelopes(), body, 'key-agent') } }), 403)).toBe('insufficient_scope');
    expect(await errorCode(await h.humanPut('settlement', { ...envelopeInput(), destinations: ['bc1bad'] }), 400)).toBe('invalid_envelope');
    expect(await errorCode(await h.humanPut('settlement', { ...envelopeInput(), chain: 'evm:8453' }), 400)).toBe('invalid_envelope');
  });
});

describe('decisions: the audit log and resolution', () => {
  it('GET is readable with wallet:read or wallet:delegate, pages with since/next, and verifies against the signed head', async () => {
    const h = await ready();
    for (const amount of [1_000, 2_000, 3_000]) await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(amount) });
    const all = await expectContract<{ entries: { seq: number; hash: string }[]; head: AuditHead }>(await h.req(url.decisions, { key: h.keys.reader.key }), P.decisions, 'get', 200);
    expect(all.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(verifyAuditChain(all.entries, { head: all.head, trustedKeys: h.service.planeDocument().keys.map((k) => k.publicKey) })).toMatchObject({ ok: true });
    const page = await expectContract<{ entries: { seq: number }[]; next?: number }>(await h.req(`${url.decisions}?since=2&limit=2`, { key: h.keys.human.key }), P.decisions, 'get', 200);
    expect(page.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(page.next).toBe(4);
    expect(verifyAuditChain(page.entries, { prev: all.entries[2]!.hash, startSeq: 3 })).toMatchObject({ ok: true });
    expect(await errorCode(await h.req(url.decisions, { key: h.keys.agent.key }), 403)).toBe('insufficient_scope');
    expect(await errorCode(await h.req(`${url.decisions}?since=x`, { key: h.keys.reader.key }), 400)).toBe('invalid_request');
    expect(await errorCode(await h.req(`${url.decisions}?limit=5000`, { key: h.keys.reader.key }), 400)).toBe('invalid_request');
  });
  it('an empty log has a null head', async () => {
    const h = appHarness();
    expect(await expectContract(await h.req(url.decisions, { key: h.keys.reader.key }), P.decisions, 'get', 200)).toEqual({ org: ORG, entries: [], head: null });
  });
  it('POST resolve: a person approves an escalation with an approval and gets the authorization; 409 when not pending; 404 unknown', async () => {
    const h = await ready();
    const esc = (await (await h.req(url.propose, { method: 'POST', key: h.keys.agent.key, json: transfer(60_000) })).json()) as { decisionId: string };
    const body = JSON.stringify({ resolution: 'APPROVED', note: 'known artist' });
    const res = await h.req(url.resolve(esc.decisionId), { method: 'POST', key: h.keys.human.key, body, headers: { 'content-type': 'application/json', 'x-approval': h.approve('POST', url.resolve(esc.decisionId), body) } });
    const out = await expectContract<{ decision: { status: string }; authorization: SpendAuthorization }>(res, P.resolve, 'post', 200);
    expect(out.decision.status).toBe('APPROVED');
    expect(await verifyAuthorization(out.authorization, { trustedKeys: h.service.trustedKeys(), now: h.clock.now() })).toEqual({ ok: true });
    const again = JSON.stringify({ resolution: 'REJECTED' });
    expect(await errorCode(await h.req(url.resolve(esc.decisionId), { method: 'POST', key: h.keys.human.key, body: again, headers: { 'content-type': 'application/json', 'x-approval': h.approve('POST', url.resolve(esc.decisionId), again) } }), 409)).toBe('DECISION_NOT_PENDING');
    expect(await errorCode(await h.req(url.resolve('dec_nope'), { method: 'POST', key: h.keys.human.key, body: again, headers: { 'content-type': 'application/json', 'x-approval': h.approve('POST', url.resolve('dec_nope'), again) } }), 404)).toBe('DECISION_NOT_FOUND');
    expect(await errorCode(await h.req(url.resolve(esc.decisionId), { method: 'POST', key: h.keys.human.key, body: again, headers: { 'content-type': 'application/json' } }), 403)).toBe('approval_required');
    const bad = JSON.stringify({ resolution: 'MAYBE' });
    expect(await errorCode(await h.req(url.resolve(esc.decisionId), { method: 'POST', key: h.keys.human.key, body: bad, headers: { 'content-type': 'application/json', 'x-approval': h.approve('POST', url.resolve(esc.decisionId), bad) } }), 400)).toBe('invalid_request');
  });
});
