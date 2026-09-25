import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateApiKey } from '@bsh/edge';
import { ConfigError, loadConfig, parsePlaneKey, parsePlaneKeys, principalOf, scopeConflict, splitPems } from '../src/config.ts';
import { httpLedgerPort, LedgerPortError } from '../src/ledger.ts';
import { APPROVER_KEY, PLANE_KEY, RETIRED_KEY, STRANGER_KEY } from './helpers.ts';

const hash = generateApiKey('live').hash;
const key = (over: Record<string, unknown> = {}) => ({ id: 'k1', hash, env: 'live', scopes: ['wallet:propose'], org: 'scribbit', name: 'settlement', ...over });

describe('API keys: separation of duties is enforced when the configuration loads', () => {
  it('a key is bound to an organisation and a name (ownerId org/name)', () => {
    expect(parsePlaneKey(key(), 0)).toEqual({ id: 'k1', hash, env: 'live', scopes: ['wallet:propose'], ownerId: 'scribbit/settlement', name: 'settlement' });
    expect(principalOf('scribbit/settlement')).toEqual({ org: 'scribbit', name: 'settlement' });
    expect(principalOf('scribbit')).toBeUndefined();
    expect(principalOf('Scribbit/x')).toBeUndefined();
  });
  it.each([
    [['wallet:propose', 'wallet:settle'], /SCOPE_CONFLICT.*never held by one key/],
    [['wallet:delegate', 'wallet:propose'], /SCOPE_CONFLICT.*people/],
    [['wallet:delegate', 'wallet:settle'], /SCOPE_CONFLICT.*people/],
  ])('refuses %j', (scopes, message) => {
    expect(() => parsePlaneKey(key({ scopes }), 0)).toThrow(message);
    expect(scopeConflict(scopes)).toBeDefined();
  });
  it('allows the combinations that keep duties apart', () => {
    for (const scopes of [['wallet:propose', 'wallet:read'], ['wallet:settle', 'wallet:read'], ['wallet:delegate', 'wallet:read'], ['wallet:read']]) expect(scopeConflict(scopes)).toBeUndefined();
  });
  it('refuses plaintext keys, bad hashes, unknown scopes, bad names, duplicates', () => {
    expect(() => parsePlaneKey(key({ key: 'bsh_live_x' }), 0)).toThrow(/plaintext/);
    expect(() => parsePlaneKey(key({ hash: 'ABC' }), 0)).toThrow(/SHA-256/);
    expect(() => parsePlaneKey(key({ scopes: ['wallet:propose', 'ledger'] }), 0)).toThrow(/unknown scope/);
    expect(() => parsePlaneKey(key({ scopes: [] }), 0)).toThrow(/non-empty/);
    expect(() => parsePlaneKey(key({ org: 'Scribbit!' }), 0)).toThrow(/org/);
    expect(() => parsePlaneKey(key({ name: 'a/b' }), 0)).toThrow(/name/);
    expect(() => parsePlaneKey(key({ env: 'prod' }), 0)).toThrow(/env/);
    expect(() => parsePlaneKey(key({ quota: { limit: 0 } }), 0)).toThrow(/quota/);
    expect(() => parsePlaneKeys(JSON.stringify([key(), key()]))).toThrow(/duplicate/);
    expect(() => parsePlaneKeys('{')).toThrow(ConfigError);
    expect(() => parsePlaneKeys('{}')).toThrow(/array/);
  });
});

describe('loadConfig', () => {
  const base = { PLANE_AUTHZ_PRIVATE_KEY: PLANE_KEY.privateKey, PLANE_API_KEYS_JSON: JSON.stringify([key()]) };
  it('defaults: port 3070, loopback, btc chains, 300 s authorizations, 24 h decisions, first-time rule at 100 000 sats', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ port: 3070, host: '127.0.0.1', chains: ['btc:mainnet', 'btc:signet', 'btc:testnet'], authorizationTtlMs: 300_000, decisionTtlMs: 86_400_000, firstTimeEscalateAbove: 100_000n, keyEnv: 'live', ledger: undefined, dbPath: undefined });
  });
  it('reads approvers, retired keys, the denylist, chains, the ledger, and caps the authorization TTL at 300 s', () => {
    const c = loadConfig({
      ...base,
      PLANE_APPROVERS_JSON: JSON.stringify([{ org: 'scribbit', name: 'alice', publicKey: APPROVER_KEY.publicKey }]),
      PLANE_AUTHZ_RETIRED_PUBLIC_KEYS: `${RETIRED_KEY.publicKey}\n${STRANGER_KEY.publicKey}`,
      PLANE_DENYLIST: 'bc1qa, bc1qb',
      PLANE_CHAINS: 'btc:signet',
      PLANE_FIRST_TIME_ESCALATE_ABOVE: 'off',
      PLANE_AUTHORIZATION_TTL_SECONDS: '900',
      PLANE_LEDGER_URL: 'http://ledger.internal:3050',
      PLANE_LEDGER_API_KEY: 'bsh_live_x',
    });
    expect(c.approvers.map((a) => a.name)).toEqual(['alice']);
    expect(c.retiredPublicKeys).toHaveLength(2);
    expect(c).toMatchObject({ denylist: ['bc1qa', 'bc1qb'], chains: ['btc:signet'], firstTimeEscalateAbove: null, authorizationTtlMs: 300_000, ledger: { url: 'http://ledger.internal:3050' } });
  });
  it('refuses a missing signing key, no keys, wrong-environment keys, unknown chains, half a ledger, bad thresholds', () => {
    expect(() => loadConfig({ PLANE_API_KEYS_JSON: base.PLANE_API_KEYS_JSON })).toThrow(/PLANE_AUTHZ_PRIVATE_KEY/);
    expect(() => loadConfig({ PLANE_AUTHZ_PRIVATE_KEY: PLANE_KEY.privateKey })).toThrow(/no API keys/);
    expect(() => loadConfig({ ...base, PLANE_KEY_ENV: 'test' })).toThrow(/not test keys/);
    expect(() => loadConfig({ ...base, PLANE_CHAINS: 'evm:1' })).toThrow(/PLANE_CHAINS/);
    expect(() => loadConfig({ ...base, PLANE_LEDGER_URL: 'http://x' })).toThrow(/PLANE_LEDGER_API_KEY/);
    expect(() => loadConfig({ ...base, PLANE_LEDGER_API_KEY: 'k' })).toThrow(/PLANE_LEDGER_URL/);
    expect(() => loadConfig({ ...base, PLANE_FIRST_TIME_ESCALATE_ABOVE: '1.5' })).toThrow(/sats/);
    expect(() => loadConfig({ ...base, PLANE_APPROVERS_JSON: '[{"org":"scribbit","name":"x","publicKey":"no"}]' })).toThrow(/PLANE_APPROVERS_JSON/);
    expect(() => loadConfig({ ...base, PLANE_API_KEYS_JSON: JSON.stringify([key({ scopes: ['wallet:propose', 'wallet:settle'] })]) })).toThrow(/SCOPE_CONFLICT/);
  });
  it('reads the key and the key list from files when given paths', () => {
    const files: Record<string, string> = { '/run/secrets/key.pem': PLANE_KEY.privateKey, '/run/secrets/keys.json': JSON.stringify([key()]) };
    const c = loadConfig({ PLANE_AUTHZ_PRIVATE_KEY_FILE: '/run/secrets/key.pem', PLANE_API_KEYS_FILE: '/run/secrets/keys.json' }, (p) => files[p]!);
    expect(c.signingKey).toBe(PLANE_KEY.privateKey);
    expect(c.keys).toHaveLength(1);
  });
  it('splitPems splits concatenated public keys', () => {
    expect(splitPems(`${RETIRED_KEY.publicKey}${STRANGER_KEY.publicKey}`)).toHaveLength(2);
    expect(splitPems('')).toEqual([]);
  });
  it('env.schema.json documents every variable the loader reads', () => {
    const schema = JSON.parse(readFileSync(new URL('../env.schema.json', import.meta.url), 'utf8')) as { properties: Record<string, unknown> };
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const read = new Set([...src.matchAll(/env(?:\.|, ')([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!));
    expect([...read].filter((v) => !(v in schema.properties))).toEqual([]);
  });
});

describe('httpLedgerPort (contracts/openapi/ledger.yaml observations)', () => {
  const obs = { paymentId: 'pay_1', outputs: [{ scriptHex: '51', valueSats: 1 }], confirmations: 2 };
  it('POSTs the observation with the key as a bearer token and reads applied/reason', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = httpLedgerPort({ url: 'http://ledger/', apiKey: 'bsh_live_secret', fetch: async (u, init) => (seen.push({ url: u, init: init! }), new Response(JSON.stringify({ applied: false, reason: 'already applied' }), { status: 200 })) });
    expect(await port.observe('ab'.repeat(32), obs)).toEqual({ applied: false, reason: 'already applied' });
    expect(seen[0]!.url).toBe('http://ledger/v1/payments/pay_1/observations');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer bsh_live_secret');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ txid: 'ab'.repeat(32), outputs: obs.outputs, confirmations: 2 });
  });
  it('turns failures into LedgerPortError without the key in the message', async () => {
    const down = httpLedgerPort({ url: 'http://ledger', apiKey: 'bsh_live_secret', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(down.observe('t', obs)).rejects.toMatchObject({ status: 0 });
    const refused = httpLedgerPort({ url: 'http://ledger', apiKey: 'bsh_live_secret', fetch: async () => new Response(JSON.stringify({ error: { code: 'not_observable', message: 'nope' } }), { status: 409 }) });
    const err = await refused.observe('t', obs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerPortError);
    expect(err).toMatchObject({ status: 409, code: 'not_observable' });
    expect(String((err as Error).message)).not.toContain('secret');
  });
});
