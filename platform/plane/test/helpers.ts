import { generateApiKey, InMemoryApiKeyStore } from '@bsh/edge';
import { generateKeyPair, type Ed25519KeyPair } from '@bsh/mesh';
import { createPlaneApp } from '../src/api.ts';
import { parseApprovers, signApproval } from '../src/approval.ts';
import { parsePlaneKey } from '../src/config.ts';
import type { AgentIdentity } from '../src/decide.ts';
import type { SpendEnvelopeInput } from '../src/envelope.ts';
import type { LedgerPort } from '../src/ledger.ts';
import { PlaneService, type PlaneServiceOptions } from '../src/service.ts';
import { MemoryPlaneStore } from '../src/store/memory.ts';
import type { PlaneStore } from '../src/store/types.ts';

export const T0 = Date.parse('2026-09-24T10:00:00.000Z');

export function fakeClock(start = T0) {
  let t = start;
  return { now: () => new Date(t), tick: (ms: number) => (t += ms), set: (ms: number) => (t = ms), ms: () => t };
}
export type Clock = ReturnType<typeof fakeClock>;

export function seqIds() {
  const n: Record<string, number> = {};
  return (prefix: string) => {
    n[prefix] = (n[prefix] ?? 0) + 1;
    return `${prefix}_${String(n[prefix]).padStart(4, '0')}`;
  };
}

// BIP 173 / BIP 350 vectors.
export const MAIN_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
export const MAIN_P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
export const MAIN_P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
export const TEST_P2WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
export const SIGNET_P2WSH = 'tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy';
export const SIGNET_P2TR = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';

/** One plane key for the whole run (key generation is the slow part of every test). */
export const PLANE_KEY: Ed25519KeyPair = generateKeyPair();
export const RETIRED_KEY: Ed25519KeyPair = generateKeyPair();
export const APPROVER_KEY: Ed25519KeyPair = generateKeyPair();
export const STRANGER_KEY: Ed25519KeyPair = generateKeyPair();

export const ORG = 'scribbit';
export const AGENT = 'settlement';

export const agent = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({ orgId: ORG, agentName: AGENT, scopes: ['wallet:propose'], ...over });

/** perTx 100k, daily 250k, auto-approve up to 50k, mainnet: MAIN_P2WPKH, MAIN_P2TR and any artist payee. */
export const envelopeInput = (over: Partial<SpendEnvelopeInput> = {}): SpendEnvelopeInput => ({
  chain: 'btc:mainnet',
  kinds: ['transfer'],
  assets: ['native'],
  destinations: [MAIN_P2WPKH, MAIN_P2TR, 'payee:artist'],
  perTxMax: '100000',
  dailyMax: '250000',
  autoApproveMax: '50000',
  ...over,
});

export const transfer = (amount: string | number, destination = MAIN_P2WPKH, over: Record<string, unknown> = {}) => ({ kind: 'transfer', chain: 'btc:mainnet', asset: 'native', amount: String(amount), destination, ...over });

export const SETTER = { apiKeyId: 'key-human', approver: 'alice' };

export interface HarnessOptions extends Partial<Omit<PlaneServiceOptions, 'store' | 'signingKey'>> {
  store?: PlaneStore;
  clock?: Clock;
  ledger?: LedgerPort;
}

/** A service on a memory store with a fixed clock and sequential ids; the first-time rule is off unless asked for. */
export function harness(opts: HarnessOptions = {}) {
  const clock = opts.clock ?? fakeClock();
  const store = opts.store ?? new MemoryPlaneStore();
  const { store: _s, clock: _c, ...rest } = opts;
  const service = new PlaneService({ firstTimeEscalateAbove: null, ids: seqIds(), ...rest, store, signingKey: PLANE_KEY.privateKey, now: clock.now, retiredPublicKeys: [RETIRED_KEY.publicKey] });
  const setEnvelope = (over: Partial<SpendEnvelopeInput> = {}, agentName = AGENT, org = ORG) => service.putEnvelope(org, agentName, envelopeInput(over), SETTER);
  return { clock, store, service, setEnvelope, propose: (input: unknown, who: AgentIdentity = agent(), idempotencyKey?: string) => service.propose(ORG, who, input, idempotencyKey ? { idempotencyKey } : {}) };
}

function mintKey(org: string, name: string, scopes: string[], id: string) {
  const k = generateApiKey('test');
  return { key: k.key, record: parsePlaneKey({ id, hash: k.hash, env: 'test', scopes, org, name }, 0) };
}

/** The HTTP app with one key per role. */
export function appHarness(opts: HarnessOptions = {}) {
  const h = harness(opts);
  const apiKeyStore = new InMemoryApiKeyStore();
  const keys = {
    agent: mintKey(ORG, AGENT, ['wallet:propose'], 'key-agent'),
    signer: mintKey(ORG, 'signer', ['wallet:settle'], 'key-signer'),
    human: mintKey(ORG, 'alice', ['wallet:delegate'], 'key-human'),
    reader: mintKey(ORG, 'auditor', ['wallet:read'], 'key-reader'),
    otherOrg: mintKey('degent', AGENT, ['wallet:propose'], 'key-other'),
  };
  for (const k of Object.values(keys)) apiKeyStore.add(k.record);
  const approvers = parseApprovers([{ org: ORG, name: 'alice', publicKey: APPROVER_KEY.publicKey }]);
  const app = createPlaneApp({ service: h.service, apiKeyStore, approvers, environment: 'test', onUnexpected: (err) => console.error(err) });
  const req = (path: string, init: { method?: string; key?: string; json?: unknown; body?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.key) headers.authorization = `Bearer ${init.key}`;
    let body: string | undefined = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers['content-type'] ??= 'application/json';
    }
    return app.request(path, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
  };
  /** A signed approval for exactly this request. */
  const approve = (method: string, path: string, body: string, apiKeyId = 'key-human', key = APPROVER_KEY.privateKey, at = h.clock.now().toISOString()) => signApproval(key, { method, path, body, apiKeyId, at });
  const humanPut = (agentName: string, input: unknown, over: { approval?: string; key?: string } = {}) => {
    const path = `/v1/orgs/${ORG}/wallet/envelopes/${agentName}`;
    const body = JSON.stringify(input);
    return req(path, { method: 'PUT', key: over.key ?? keys.human.key, body, headers: { 'content-type': 'application/json', 'x-approval': over.approval ?? approve('PUT', path, body) } });
  };
  return { ...h, app, req, keys, approve, humanPut, apiKeyStore };
}
