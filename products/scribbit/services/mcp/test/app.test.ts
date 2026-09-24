import { describe, expect, it } from 'vitest';
import { generateApiKey, InMemoryApiKeyStore, InMemoryRateLimitStore } from '@bsh/edge';
import * as ins from '@bsh/inscription';
import { AGENT_CARD_PATH, createApp, MCP_MANIFEST_PATH, MCP_SCOPE, TOOLS, WELL_KNOWN_CACHE_CONTROL, type AppOptions } from '../src/index.js';
import { b64, bytes, fakeProvider, PARENT_ID, PUB_HEX } from './helpers.js';

function setup(opts: Partial<AppOptions> = {}) {
  const store = new InMemoryApiKeyStore();
  const live = generateApiKey('live');
  const test = generateApiKey('test');
  const noScope = generateApiKey('live');
  const quota = generateApiKey('live');
  store.add({ id: 'key_live', hash: live.hash, env: 'live', scopes: [MCP_SCOPE], ownerId: 'acct_1' });
  store.add({ id: 'key_test', hash: test.hash, env: 'test', scopes: [MCP_SCOPE] });
  store.add({ id: 'key_noscope', hash: noScope.hash, env: 'live', scopes: ['other'] });
  store.add({ id: 'key_quota', hash: quota.hash, env: 'live', scopes: [MCP_SCOPE], quota: { limit: 2, windowMs: 60_000 } });
  const unexpected: unknown[] = [];
  const app = createApp({ keys: store, ports: { fees: { mainnet: fakeProvider('mainnet') } }, onUnexpected: (e) => unexpected.push(e), ...opts });
  return { app, store, live, test, noScope, quota, unexpected };
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function rpc(app: ReturnType<typeof setup>['app'], key: string | undefined, body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...MCP_HEADERS, ...extra };
  if (key) headers.authorization = `Bearer ${key}`;
  return app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const callTool = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('auth on /mcp and /v1/*', () => {
  it('401 missing_api_key without a key (uniform JSON error, WWW-Authenticate)', async () => {
    const { app } = setup();
    const res = await rpc(app, undefined, initialize);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm="api"/);
    const body = await res.json();
    expect(body.error.code).toBe('missing_api_key');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    const me = await app.request('/v1/keys/me');
    expect(me.status).toBe(401);
  });

  it('200 with a seeded live key (Authorization: Bearer and X-API-Key)', async () => {
    const { app, live } = setup();
    const res = await rpc(app, live.key, initialize);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.result.serverInfo).toMatchObject({ name: 'scribbit', version: expect.any(String) });
    expect(body.result.capabilities).toMatchObject({ tools: expect.any(Object), resources: expect.any(Object), prompts: expect.any(Object) });
    expect(body.result.instructions).toMatch(/quote_inscription/);
    const viaHeader = await app.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, 'x-api-key': live.key }, body: JSON.stringify(initialize) });
    expect(viaHeader.status).toBe(200);
  });

  it('401 invalid_api_key for unknown, revoked and wrong-environment keys (indistinguishable)', async () => {
    const { app, store, test, noScope } = setup();
    const unknown = await rpc(app, generateApiKey('live').key, initialize);
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error.code).toBe('invalid_api_key');
    const wrongEnv = await rpc(app, test.key, initialize);
    expect(wrongEnv.status).toBe(401);
    expect((await wrongEnv.json()).error.code).toBe('invalid_api_key');
    store.revoke('key_noscope');
    const revoked = await rpc(app, noScope.key, initialize);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe('invalid_api_key');
  });

  it('403 insufficient_scope without the mcp scope', async () => {
    const { app, noScope } = setup();
    const res = await rpc(app, noScope.key, initialize);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('insufficient_scope');
    expect(res.headers.get('www-authenticate')).toContain(`scope="${MCP_SCOPE} mcp:quote mcp:order mcp:settle"`);
  });

  it('test keys work when the server runs in the test environment', async () => {
    const { app, test, live } = setup({ keyEnv: 'test' });
    expect((await rpc(app, test.key, initialize)).status).toBe(200);
    expect((await rpc(app, live.key, initialize)).status).toBe(401);
  });

  it('per-key quota: 429 quota_exceeded with X-Quota-* headers', async () => {
    const { app, quota } = setup();
    expect((await rpc(app, quota.key, initialize)).status).toBe(200);
    const second = await rpc(app, quota.key, initialize);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-quota-remaining')).toBe('0');
    const third = await rpc(app, quota.key, initialize);
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe('quota_exceeded');
    expect(third.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('requireApiKey: false allows anonymous MCP calls (local dev) but a bad key still fails', async () => {
    const { app } = setup({ requireApiKey: false });
    expect((await rpc(app, undefined, initialize)).status).toBe(200);
    expect((await rpc(app, 'bsh_live_' + '1'.repeat(44), initialize)).status).toBe(401);
  });

  it('GET /v1/keys/me introspects the principal and never leaks the key or hash', async () => {
    const { app, live } = setup();
    const res = await app.request('/v1/keys/me', { headers: { authorization: `Bearer ${live.key}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 'key_live', env: 'live', scopes: [MCP_SCOPE], mcpScopes: [MCP_SCOPE], ownerId: 'acct_1' });
    expect(JSON.stringify(body)).not.toContain(live.key.slice(9));
    expect(JSON.stringify(body)).not.toContain(live.hash);
  });
});

describe('MCP over Streamable HTTP (stateless, JSON responses)', () => {
  it('tools/call returns the same numbers as @bsh/inscription; no session id is issued', async () => {
    const { app, live } = setup();
    const body = bytes(2000);
    const res = await rpc(app, live.key, callTool(7, 'quote_inscription', { contentType: 'image/webp', contentBase64: b64(body), parentId: PARENT_ID, feeRate: 3 }));
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const json = await res.json();
    expect(json.id).toBe(7);
    const w = ins.estimateRevealWeight({ content: { contentType: 'image/webp', body, parentId: PARENT_ID }, withParent: true, recipientScript: ins.addressToScript(ins.commitAddress(new Uint8Array(32).fill(1), { contentType: 'x', body: new Uint8Array(1) }, 'mainnet').address, 'mainnet') });
    expect(json.result.structuredContent.reveal).toEqual({ layout: 'parent', weight: w, vsize: Math.ceil(w / 4), lane: 'standard' });
    expect(json.result.structuredContent.fees.revealFee).toBe(Number(ins.quoteReveal({ revealWeight: w, feeRate: 3, postage: 546n }).revealFee));
    expect(json.result.isError).toBeUndefined();
  });

  it('each request is self-contained: tools/list and commit_address work without initialize', async () => {
    const { app, live } = setup();
    const list = await rpc(app, live.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.map((t: { name: string }) => t.name)).toHaveLength(TOOLS.length);
    const commit = await rpc(app, live.key, callTool(3, 'commit_address', { network: 'signet', revealPubkey: PUB_HEX, contentType: 'text/plain', contentBase64: b64(bytes(9)) }));
    const c = (await commit.json()).result.structuredContent;
    expect(c.address).toBe(ins.commitAddress(Buffer.from(PUB_HEX, 'hex'), { contentType: 'text/plain', body: bytes(9) }, 'signet').address);
  });

  it('tool errors are results, transport errors are JSON-RPC errors', async () => {
    const { app, live, unexpected } = setup();
    const tool = await rpc(app, live.key, callTool(4, 'rescue_tx', { halfSignedPsbtBase64: b64(bytes(20)) }));
    expect(tool.status).toBe(200);
    const tj = await tool.json();
    expect(tj.result.isError).toBe(true);
    expect(tj.result.structuredContent.error.code).toBe('invalid_psbt');
    const unknownTool = await rpc(app, live.key, callTool(5, 'nope', {}));
    const uj = await unknownTool.json();
    // The SDK reports an unknown tool as an error result (the JSON-RPC envelope itself is fine).
    expect(uj.result.isError).toBe(true);
    expect(uj.result.content[0].text).toMatch(/nope/);
    const badJson = await app.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${live.key}` }, body: '{not json' });
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error.code).toBe(-32700);
    expect(unexpected).toEqual([]);
  });

  it('notifications get 202; GET and DELETE are 405 (no sessions); wrong Accept is 406', async () => {
    const { app, live } = setup();
    const notif = await rpc(app, live.key, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notif.status).toBe(202);
    const get = await app.request('/mcp', { headers: { authorization: `Bearer ${live.key}`, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    const del = await app.request('/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${live.key}` } });
    expect(del.status).toBe(405);
    const accept = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${live.key}` }, body: JSON.stringify(initialize) });
    expect(accept.status).toBe(406);
  });

  it('413 above the body limit (declared Content-Length), before the transport parses anything', async () => {
    const { app, live } = setup({ maxBodyBytes: 4096 });
    const big = JSON.stringify(callTool(6, 'quote_inscription', { contentType: 'text/plain', contentBase64: 'A'.repeat(8000), feeRate: 1 }));
    const res = await rpc(app, live.key, big);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
  });

  it('a 4 MiB body goes through the default limit', async () => {
    const { app, live } = setup();
    const res = await rpc(app, live.key, callTool(8, 'build_envelope', { contentType: 'application/octet-stream', contentBase64: b64(new Uint8Array(4 * 1024 * 1024)) }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.result.structuredContent.bodyBytes).toBe(4 * 1024 * 1024);
  });
});

describe('discovery derived from the tool registry', () => {
  it('GET / lists exactly what tools/list answers, with scopes per tool', async () => {
    const { app, live } = setup({ publicUrl: 'https://mcp.scribb.it' });
    const index = await (await app.request('/')).json();
    const list = await (await rpc(app, live.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const listed = list.result.tools.map((t: { name: string }) => t.name);
    expect(index.mcp.tools).toEqual(listed);
    expect(index.mcp.tools).toEqual(TOOLS.map((t) => t.name));
    expect(Object.keys(index.mcp.toolScopes)).toEqual(listed);
    expect(index.mcp.auth.scopes).toEqual(['mcp', 'mcp:quote', 'mcp:order', 'mcp:settle']);
    expect(index.wellKnown).toEqual({ agentCard: `https://mcp.scribb.it${AGENT_CARD_PATH}`, mcp: `https://mcp.scribb.it${MCP_MANIFEST_PATH}`, charter: '/.well-known/flashyos-charter.json', frontdoor: '/.well-known/frontdoor.json' });
    expect(index.orders).toBe(false);
    const prompts = await (await rpc(app, live.key, { jsonrpc: '2.0', id: 3, method: 'prompts/list' })).json();
    expect(index.mcp.prompts).toEqual(prompts.result.prompts.map((p: { name: string }) => p.name));
    const resources = await (await rpc(app, live.key, { jsonrpc: '2.0', id: 4, method: 'resources/list' })).json();
    expect(index.mcp.resources).toEqual(resources.result.resources.map((r: { uri: string }) => r.uri));
  });

  it('the agent card and mcp.json are unauthenticated, cacheable, and list the same tools with scopes', async () => {
    const { app, live } = setup({ publicUrl: 'https://mcp.scribb.it', networks: ['mainnet', 'signet'] });
    const card = await app.request(AGENT_CARD_PATH);
    expect(card.status).toBe(200);
    expect(card.headers.get('cache-control')).toBe(WELL_KNOWN_CACHE_CONTROL);
    expect(card.headers.get('content-type')).toMatch(/application\/json/);
    const c = await card.json();
    expect(c.url).toBe('https://mcp.scribb.it/mcp');
    expect(c.provider).toEqual({ organization: 'Blockspace Holdings', url: 'https://blockspace.holdings' });
    expect(c.capabilities.streaming).toBe(false);
    expect(c.skills.map((s: { id: string }) => s.id)).toEqual(TOOLS.map((t) => t.name));
    expect(c.skills.find((s: { id: string }) => s.id === 'create_order').scopes).toEqual(['mcp:order']);
    expect(c.skills.find((s: { id: string }) => s.id === 'create_order').tags).toContain('scope:mcp:order');
    expect(c['x-flashyos']).toEqual({ charter: '/.well-known/flashyos-charter.json', frontdoor: '/.well-known/frontdoor.json' });
    expect(c['x-mcp'].manifest).toBe(`https://mcp.scribb.it${MCP_MANIFEST_PATH}`);
    expect(c['x-scribbit'].networks).toEqual(['mainnet', 'signet']);
    const manifest = await app.request(MCP_MANIFEST_PATH);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('cache-control')).toBe(WELL_KNOWN_CACHE_CONTROL);
    const m = await manifest.json();
    expect(m).toMatchObject({ transport: 'streamable-http', endpoint: 'https://mcp.scribb.it/mcp', stateless: true, auth: { scheme: 'bearer', header: 'Authorization', keyPrefix: 'bsh_live_' } });
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const list = await (await rpc(app, live.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(list.result.tools.map((t: { name: string }) => t.name));
    expect(m.agentCard).toBe(`https://mcp.scribb.it${AGENT_CARD_PATH}`);
    // relative when no public URL is configured
    const bare = setup();
    expect((await (await bare.app.request(AGENT_CARD_PATH)).json()).url).toBe('/mcp');
    expect((await (await bare.app.request(MCP_MANIFEST_PATH)).json()).endpoint).toBe('/mcp');
  });

  it('well-known documents still sit behind the per-IP bucket', async () => {
    const { app } = setup({ rateLimit: { ipPerMinute: 2 } });
    expect((await app.request(AGENT_CARD_PATH)).status).toBe(200);
    expect((await app.request(MCP_MANIFEST_PATH)).status).toBe(200);
    expect((await app.request(AGENT_CARD_PATH)).status).toBe(429);
  });
});

describe('rate limits and headers', () => {
  it('per-key bucket on /mcp: 429 rate_limited with RateLimit headers', async () => {
    const { app, live } = setup({ rateLimit: { keyPerMinute: 2, ipPerMinute: 1000, store: new InMemoryRateLimitStore() } });
    expect((await rpc(app, live.key, initialize)).status).toBe(200);
    expect((await rpc(app, live.key, initialize)).status).toBe(200);
    const res = await rpc(app, live.key, initialize);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.get('ratelimit-limit')).toBe('2');
  });

  it('per-IP bucket covers unauthenticated routes too', async () => {
    const { app } = setup({ rateLimit: { ipPerMinute: 2 } });
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/healthz')).status).toBe(429);
  });

  it('security headers, request id and no-store on every response', async () => {
    const { app } = setup();
    const res = await app.request('/');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('unknown routes are uniform JSON 404s', async () => {
    const { app } = setup();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
