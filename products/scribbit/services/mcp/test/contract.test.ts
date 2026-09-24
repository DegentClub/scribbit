import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { generateApiKey, InMemoryApiKeyStore } from '@bsh/edge';
import { AGENT_CARD_PATH, createApp, MCP_MANIFEST_PATH, MCP_SCOPE, toolNames } from '../src/index.js';
import { b64, bytes } from './helpers.js';

const contractPath = fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-mcp.yaml', import.meta.url));
const contract = parse(readFileSync(contractPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'contract');
const validator = (name: string) => ajv.getSchema(`contract#/components/schemas/${name}`)!;

function expectValid(name: string, body: unknown) {
  const v = validator(name);
  const ok = v(body);
  expect(v.errors ?? [], JSON.stringify(v.errors)).toEqual([]);
  expect(ok).toBe(true);
}

function makeApp() {
  const store = new InMemoryApiKeyStore();
  const live = generateApiKey('live');
  store.add({ id: 'key_live', hash: live.hash, env: 'live', scopes: [MCP_SCOPE], ownerId: 'acct_1', quota: { limit: 100, windowMs: 60_000 } });
  return { app: createApp({ keys: store, networks: ['mainnet', 'signet'], publicUrl: 'https://mcp.scribb.it' }), live };
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('HTTP surface (contracts/openapi/scribbit-mcp.yaml)', () => {
  it('declares exactly the routes the app serves', () => {
    expect(Object.keys(contract.paths).sort()).toEqual(['/', AGENT_CARD_PATH, MCP_MANIFEST_PATH, '/healthz', '/mcp', '/v1/keys/me'].sort());
    expect(Object.keys(contract.paths['/mcp']).sort()).toEqual(['delete', 'get', 'post']);
  });

  it('GET / matches Index', async () => {
    const { app } = makeApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('Index', body);
    expect(body.mcp.endpoint).toBe('https://mcp.scribb.it/mcp');
    expect(body.mcp.tools).toEqual(toolNames());
    expect(body.mcp.tools).toEqual(['get_fees', 'quote_inscription', 'build_envelope', 'commit_address', 'explain_lanes', 'rescue_tx', 'create_order', 'get_order', 'report_funding', 'get_receipt']);
    expect(body.networks).toEqual(['mainnet', 'signet']);
    expect(body.mcp.auth.scope).toBe(MCP_SCOPE);
  });

  it('GET /.well-known/agent.json matches AgentCard', async () => {
    const { app } = makeApp();
    const res = await app.request(AGENT_CARD_PATH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('AgentCard', body);
    expect(body.skills.map((s: { id: string }) => s.id)).toEqual(toolNames());
    expect(body['x-flashyos']).toEqual({ charter: '/.well-known/flashyos-charter.json', frontdoor: '/.well-known/frontdoor.json' });
  });

  it('GET /.well-known/mcp.json matches McpManifest', async () => {
    const { app } = makeApp();
    const res = await app.request(MCP_MANIFEST_PATH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('McpManifest', body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(toolNames());
    expect(body.endpoint).toBe('https://mcp.scribb.it/mcp');
  });

  it('the Scope enum in the contract is the scope list the server understands', () => {
    const schema = validator('Scope').schema as { enum: string[] };
    expect(schema.enum).toEqual(['mcp', 'mcp:quote', 'mcp:order', 'mcp:settle']);
  });

  it('GET /healthz matches Health', async () => {
    const { app } = makeApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('Health', body);
    expect(body).toMatchObject({ status: 'ok', service: 'scribbit', networks: ['mainnet', 'signet'] });
  });

  it('GET /v1/keys/me matches KeyPrincipal and carries quota headers', async () => {
    const { app, live } = makeApp();
    const res = await app.request('/v1/keys/me', { headers: { authorization: `Bearer ${live.key}` } });
    expect(res.status).toBe(200);
    expectValid('KeyPrincipal', await res.json());
    expect(res.headers.get('x-quota-limit')).toBe('100');
  });

  it('error bodies match Error with a code from the contract enum', async () => {
    const { app, live } = makeApp();
    const codes = validator('Error').schema as { properties: { error: { properties: { code: { enum: string[] } } } } };
    const allowed = codes.properties.error.properties.code.enum;
    const cases = [
      await app.request('/v1/keys/me'),
      await app.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, authorization: 'Bearer bsh_test_' + '1'.repeat(44) }, body: '{}' }),
      await app.request('/nope'),
      await app.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${live.key}`, 'content-length': String(100 * 1024 * 1024) }, body: '{}' }),
    ];
    for (const res of cases) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.json();
      expectValid('Error', body);
      expect(allowed, `${res.status} ${body.error.code}`).toContain(body.error.code);
    }
  });

  it('POST /mcp responses match JsonRpcResponse, transport errors match JsonRpcError', async () => {
    const { app, live } = makeApp();
    const ok = await app.request('/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${live.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'build_envelope', arguments: { contentType: 'text/plain', contentBase64: b64(bytes(5)) } } }),
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expectValid('JsonRpcResponseOrBatch', okBody);
    expect(okBody.result.structuredContent.scriptBytes).toBeGreaterThan(5);
    const bad = await app.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${live.key}` }, body: '[' });
    expect(bad.status).toBe(400);
    expectValid('JsonRpcError', await bad.json());
    const get = await app.request('/mcp', { headers: { authorization: `Bearer ${live.key}`, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expectValid('JsonRpcError', await get.json());
  });

  it('ToolError enum covers every code the tools emit', () => {
    const schema = validator('ToolError').schema as { properties: { error: { properties: { code: { enum: string[] } } } } };
    expect(schema.properties.error.properties.code.enum.sort()).toEqual(
      ['invalid_input', 'content_too_large', 'content_hash_mismatch', 'too_large', 'invalid_psbt', 'fees_unavailable', 'fee_rate_required', 'unsupported_network', 'forbidden_scope', 'ledger_unavailable', 'ledger_rejected', 'order_not_found', 'internal'].sort(),
    );
  });
});
