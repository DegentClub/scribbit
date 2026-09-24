import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { InMemoryApiKeyStore, generateApiKey } from '@bsh/edge';
import { InMemoryAuditLog, InMemoryKeyProvider, Signer, createSignerApp, deny } from '../src/index.js';
import { PRIV_A, PRIV_B, keyPathPsbt } from './helpers.js';

const DIGEST = hex.encode(sha256(new TextEncoder().encode('attest')));

function setup(opts: { denyTaproot?: boolean; keyPerMinute?: number } = {}) {
  const store = new InMemoryApiKeyStore();
  const signerKey = generateApiKey('live');
  const readKey = generateApiKey('live');
  const adminKey = generateApiKey('live');
  const testKey = generateApiKey('test');
  store.add({ id: 'svc-a', hash: signerKey.hash, env: 'live', scopes: ['sign:a'] });
  store.add({ id: 'reader', hash: readKey.hash, env: 'live', scopes: ['keys:read'] });
  store.add({ id: 'admin', hash: adminKey.hash, env: 'live', scopes: ['audit:read'] });
  store.add({ id: 'tester', hash: testKey.hash, env: 'test', scopes: ['sign:a'] });
  const auditLog = new InMemoryAuditLog();
  const signer = new Signer({
    keys: new InMemoryKeyProvider([['a', PRIV_A], ['b', PRIV_B]]),
    audit: auditLog,
    allowedPurposes: ['blockspace.certify'],
    taprootPolicies: opts.denyTaproot ? [{ name: 'lockdown', inspect: () => deny('maintenance window') }] : [],
    network: 'signet',
  });
  const app = createSignerApp({ signer, keys: store, keyEnv: 'live', auditLog, rateLimit: { keyPerMinute: opts.keyPerMinute ?? 3 } });
  const call = (path: string, init: RequestInit & { key?: string; json?: unknown } = {}) =>
    app.request(path, {
      method: init.json !== undefined ? 'POST' : (init.method ?? 'GET'),
      headers: {
        ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}),
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  return { app, call, signerKey: signerKey.key, readKey: readKey.key, adminKey: adminKey.key, testKey: testKey.key, auditLog };
}

const err = async (res: Response) => (await res.json()) as { error: { code: string; message: string; requestId: string } };

describe('signer HTTP service', () => {
  it('health is public and JSON; everything else needs a key', async () => {
    const { call } = setup();
    const h = await call('/v1/health');
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: 'ok', service: 'signer', network: 'signet', keys: 2 });
    expect(h.headers.get('X-Request-Id')).toBeTruthy();
    expect(h.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const r = await call('/v1/keys/a/pubkey');
    expect(r.status).toBe(401);
    expect((await err(r)).error.code).toBe('missing_api_key');
    const nf = await call('/nope');
    expect(nf.status).toBe(404);
    expect((await err(nf)).error.code).toBe('not_found');
  });

  it('refuses test-environment keys on a live instance', async () => {
    const { call, testKey } = setup();
    const r = await call('/v1/keys/a/pubkey', { key: testKey });
    expect(r.status).toBe(401);
    expect((await err(r)).error.code).toBe('invalid_api_key');
  });

  it('scopes are per key id: sign:a cannot sign with b or read audit; keys:read cannot sign', async () => {
    const { call, signerKey, readKey, adminKey } = setup();
    const { psbtBase64 } = keyPathPsbt();
    const ok = await call('/v1/sign/taproot-keypath', { key: signerKey, json: { psbtBase64, inputIndex: 0, keyId: 'a' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ keyId: 'a', inputIndex: 0, sighashType: 0, signature: expect.stringMatching(/^[0-9a-f]{128}$/) });

    const wrongKey = await call('/v1/sign/digest', { key: signerKey, json: { keyId: 'b', digest32: DIGEST, purpose: 'blockspace.certify' } });
    expect(wrongKey.status).toBe(403);
    expect((await err(wrongKey)).error).toMatchObject({ code: 'insufficient_scope', message: expect.stringContaining('sign:b') });

    const reader = await call('/v1/sign/digest', { key: readKey, json: { keyId: 'a', digest32: DIGEST, purpose: 'blockspace.certify' } });
    expect(reader.status).toBe(403);

    expect((await call('/v1/keys/b/pubkey', { key: readKey })).status).toBe(200);
    expect((await call('/v1/keys/a/pubkey', { key: signerKey })).status).toBe(200); // sign:a implies reading a's pubkey
    expect((await call('/v1/keys/b/pubkey', { key: signerKey })).status).toBe(403);
    expect((await call('/v1/keys/ghost/pubkey', { key: readKey })).status).toBe(404);

    expect((await call('/v1/audit', { key: signerKey })).status).toBe(403);
    expect((await call('/v1/audit', { key: adminKey })).status).toBe(200);
  });

  it('policy denials are 403 policy_denied with the reason, and appear in the audit endpoint', async () => {
    const { call, signerKey, adminKey } = setup({ denyTaproot: true });
    const { psbtBase64 } = keyPathPsbt();
    const r = await call('/v1/sign/taproot-keypath', { key: signerKey, json: { psbtBase64, inputIndex: 0, keyId: 'a' } });
    expect(r.status).toBe(403);
    const body = await err(r);
    expect(body.error).toMatchObject({ code: 'policy_denied', message: 'lockdown: maintenance window' });

    const audit = await call('/v1/audit?decision=deny&keyId=a', { key: adminKey });
    const { records, total } = (await audit.json()) as { records: Array<Record<string, unknown>>; total: number };
    expect(total).toBe(1);
    expect(records[0]).toMatchObject({ decision: 'deny', principal: 'svc-a', requestId: body.error.requestId, reason: 'lockdown: maintenance window' });
    expect(JSON.stringify(records)).not.toContain(psbtBase64);

    expect((await call('/v1/audit?decision=bogus', { key: adminKey })).status).toBe(400);
    expect((await call('/v1/audit?limit=0', { key: adminKey })).status).toBe(400);
  });

  it('signer errors map to their HTTP statuses; bad bodies are 400/415', async () => {
    const { call, signerKey } = setup({ keyPerMinute: 100 });
    const { psbtBase64 } = keyPathPsbt();
    const cases: Array<[unknown, number, string]> = [
      [{ psbtBase64: 'AAAA', inputIndex: 0, keyId: 'a' }, 400, 'psbt_invalid'],
      [{ psbtBase64, inputIndex: 7, keyId: 'a' }, 400, 'invalid_request'],
      [{ psbtBase64, keyId: 'a' }, 400, 'invalid_request'],
      [{ inputIndex: 0 }, 400, 'invalid_request'],
    ];
    for (const [json, status, code] of cases) {
      const r = await call('/v1/sign/taproot-keypath', { key: signerKey, json });
      expect(r.status, code).toBe(status);
      expect((await err(r)).error.code).toBe(code);
    }
    const notJson = await call('/v1/sign/taproot-keypath', { key: signerKey, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(notJson.status).toBe(400);
    expect((await err(notJson)).error.code).toBe('invalid_json');
    const text = await call('/v1/sign/taproot-keypath', { key: signerKey, method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(text.status).toBe(415);
    const denied = await call('/v1/sign/digest', { key: signerKey, json: { keyId: 'a', digest32: DIGEST, purpose: 'other.purpose' } });
    expect(denied.status).toBe(403);
    expect((await err(denied)).error.code).toBe('policy_denied');
  });

  it('rate limits signing per API key', async () => {
    const { call, signerKey } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call('/v1/sign/digest', { key: signerKey, json: { keyId: 'a', digest32: DIGEST, purpose: 'blockspace.certify' } });
      statuses.push(r.status);
      if (r.status === 429) expect(r.headers.get('Retry-After')).toBeTruthy();
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
