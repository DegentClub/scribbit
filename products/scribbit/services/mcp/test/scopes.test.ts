import { describe, expect, it } from 'vitest';
import { generateApiKey, InMemoryApiKeyStore } from '@bsh/edge';
import {
  assertScopeSet,
  CALCULATOR_SCOPES,
  createApp,
  hasAnyScope,
  isMcpScope,
  MCP_SCOPES,
  mcpScopesOf,
  parseKeyRecords,
  scopeConflict,
  TOOLS,
  toolScopes,
  type McpScope,
} from '../src/index.js';
import { mintKey } from '../src/mint-key.js';
import { connect, fakeProvider, type ErrBody } from './helpers.js';

const SAMPLE: Record<string, Record<string, unknown>> = {
  explain_lanes: {},
  get_order: { orderId: 'ord_1' },
  get_receipt: { orderId: 'ord_1' },
  create_order: { contentType: 'text/plain', contentSha256: '0'.repeat(64), contentLength: 1, recipientAddress: 'bc1p' + 'q'.repeat(58), commitAddress: 'bc1p' + 'q'.repeat(58), feeRate: 1 },
  report_funding: { orderId: 'ord_1', txid: 'a'.repeat(64), outputs: [{ scriptHex: '5120' + '00'.repeat(32), valueSats: 1 }] },
};

describe('scope model', () => {
  it('names four scopes; mcp:order and mcp:settle never share a key', () => {
    expect(MCP_SCOPES).toEqual(['mcp', 'mcp:quote', 'mcp:order', 'mcp:settle']);
    expect(scopeConflict(['mcp', 'mcp:order'])).toBeUndefined();
    expect(scopeConflict(['mcp:order', 'mcp:settle'])).toMatch(/cannot be held by the same key/);
    expect(() => assertScopeSet(['mcp:settle', 'ledger', 'mcp:order'], 'key k1')).toThrow(/^key k1: scopes mcp:order and mcp:settle/);
    expect(() => assertScopeSet(['mcp:settle'], 'k')).not.toThrow();
    expect(isMcpScope('mcp:quote')).toBe(true);
    expect(isMcpScope('ledger')).toBe(false);
    expect(mcpScopesOf(['ledger', 'mcp:order', 'x', 'mcp'])).toEqual(['mcp:order', 'mcp']);
  });

  it('hasAnyScope: undefined = unrestricted local caller; otherwise any accepted scope', () => {
    expect(hasAnyScope(undefined, ['mcp:order'])).toBe(true);
    expect(hasAnyScope([], ['mcp'])).toBe(false);
    expect(hasAnyScope(['mcp'], CALCULATOR_SCOPES)).toBe(true);
    expect(hasAnyScope(['mcp'], ['mcp:quote', 'mcp:order'])).toBe(false);
    expect(hasAnyScope(['other', 'mcp:settle'], ['mcp:order', 'mcp:settle'])).toBe(true);
  });

  it('every tool declares at least one scope; calculators keep working with the original mcp scope', () => {
    for (const t of TOOLS) expect(t.scopes.length, t.name).toBeGreaterThan(0);
    const calculators = ['get_fees', 'quote_inscription', 'build_envelope', 'commit_address', 'explain_lanes', 'rescue_tx'];
    for (const name of calculators) expect(toolScopes()[name], name).toEqual(['mcp', 'mcp:quote', 'mcp:order', 'mcp:settle']);
    expect(toolScopes().create_order).toEqual(['mcp:order']);
    expect(toolScopes().report_funding).toEqual(['mcp:order', 'mcp:settle']);
    expect(toolScopes().get_order).toEqual(['mcp:quote', 'mcp:order', 'mcp:settle']);
    expect(toolScopes().get_receipt).toEqual(['mcp:quote', 'mcp:order', 'mcp:settle']);
    expect(Object.keys(toolScopes()).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });
});

describe('per-tool enforcement over the protocol', () => {
  const matrix: Array<[string, readonly string[] | undefined, Record<string, boolean>]> = [
    ['mcp (read-only)', ['mcp'], { explain_lanes: false, get_order: true, get_receipt: true, create_order: true, report_funding: true }],
    ['mcp:quote', ['mcp:quote'], { explain_lanes: false, get_order: false, get_receipt: false, create_order: true, report_funding: true }],
    ['mcp:order', ['mcp:order'], { explain_lanes: false, get_order: false, get_receipt: false, create_order: false, report_funding: false }],
    ['mcp:settle', ['mcp:settle'], { explain_lanes: false, get_order: false, get_receipt: false, create_order: true, report_funding: false }],
    ['foreign scope only', ['ledger'], { explain_lanes: true, get_order: true, get_receipt: true, create_order: true, report_funding: true }],
    ['unrestricted (stdio)', undefined, { explain_lanes: false, get_order: false, get_receipt: false, create_order: false, report_funding: false }],
  ];

  it.each(matrix)('%s', async (_label, scopes, forbidden) => {
    const h = await connect({ scopes: scopes as McpScope[] | undefined, fees: { mainnet: fakeProvider() } });
    for (const [tool, expectForbidden] of Object.entries(forbidden)) {
      const r = await h.call<ErrBody>(tool, SAMPLE[tool]!);
      const code = r.isError ? r.data.error?.code : 'ok';
      if (expectForbidden) {
        expect(code, tool).toBe('forbidden_scope');
        expect(r.data.error.details).toEqual({ tool, required: toolScopes()[tool] });
        expect((r.result.content[0] as { text: string }).text).toMatch(new RegExp(`^forbidden_scope: ${tool} needs an API key with one of the scopes`));
      } else {
        // the gate passed: either a result or a downstream error (no ledger is configured here)
        expect(code, tool).not.toBe('forbidden_scope');
        if (tool !== 'explain_lanes') expect(code, tool).toBe('ledger_unavailable');
      }
    }
    await h.close();
  });

  it('tools/list still shows every tool whatever the scopes (discovery is not gated; calls are)', async () => {
    const h = await connect({ scopes: ['mcp'] });
    expect((await h.client.listTools()).tools).toHaveLength(TOOLS.length);
    await h.close();
  });
});

describe('key loading refuses the propose/settle combination', () => {
  const rec = (scopes: string[]) => ({ id: 'k', hash: generateApiKey('live').hash, env: 'live', scopes });

  it('parseKeyRecords', () => {
    expect(() => parseKeyRecords(JSON.stringify([rec(['mcp:order', 'mcp:settle'])]), 'MCP_API_KEYS_JSON')).toThrow(/API key k: scopes mcp:order and mcp:settle cannot be held by the same key/);
    expect(parseKeyRecords(JSON.stringify([rec(['mcp:order', 'mcp'])]), 'x')[0]!.scopes).toEqual(['mcp:order', 'mcp']);
    expect(parseKeyRecords(JSON.stringify([rec(['mcp:settle'])]), 'x')[0]!.scopes).toEqual(['mcp:settle']);
  });

  it('mint-key', () => {
    expect(() => mintKey(['--scopes', 'mcp:order,mcp:settle'])).toThrow(/--scopes: scopes mcp:order and mcp:settle/);
    expect(mintKey(['--scopes', 'mcp:quote,mcp:order']).record.scopes).toEqual(['mcp:quote', 'mcp:order']);
    expect(() => mintKey(['--scopes', ' , '])).toThrow(/at least one scope/);
  });
});

describe('HTTP: scopes at the door and per tool', () => {
  const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  function setup(scopes: string[], requireApiKey = true) {
    const store = new InMemoryApiKeyStore();
    const k = generateApiKey('live');
    store.add({ id: 'k', hash: k.hash, env: 'live', scopes });
    return { app: createApp({ keys: store, requireApiKey, ports: { fees: { mainnet: fakeProvider() } } }), key: k.key };
  }
  const call = (app: ReturnType<typeof createApp>, key: string | undefined, name: string, args: Record<string, unknown>) =>
    app.request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });

  it('any MCP scope opens /mcp; the tool then checks its own', async () => {
    const { app, key } = setup(['mcp']);
    const lanes = await call(app, key, 'explain_lanes', {});
    expect(lanes.status).toBe(200);
    expect((await lanes.json()).result.isError).toBeUndefined();
    const order = await call(app, key, 'create_order', SAMPLE.create_order!);
    expect(order.status).toBe(200);
    const body = await order.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe('forbidden_scope');
  });

  it('a key with only mcp:order passes the door and reaches the ledger check', async () => {
    const { app, key } = setup(['mcp:order']);
    const res = await call(app, key, 'create_order', SAMPLE.create_order!);
    expect(res.status).toBe(200);
    expect((await res.json()).result.structuredContent.error.code).toBe('ledger_unavailable');
    const me = await app.request('/v1/keys/me', { headers: { authorization: `Bearer ${key}` } });
    expect(await me.json()).toEqual({ id: 'k', env: 'live', scopes: ['mcp:order'], mcpScopes: ['mcp:order'] });
  });

  it('a key holding mcp:order and mcp:settle is refused with 403 even if a store let it in', async () => {
    const { app, key } = setup(['mcp:order', 'mcp:settle']);
    const res = await call(app, key, 'explain_lanes', {});
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('insufficient_scope');
    expect(body.error.message).toMatch(/cannot be held by the same key/);
  });

  it('no MCP scope at all is 403 insufficient_scope naming every accepted scope', async () => {
    const { app, key } = setup(['ledger']);
    const res = await call(app, key, 'explain_lanes', {});
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('scope="mcp mcp:quote mcp:order mcp:settle"');
  });

  it('anonymous local callers (MCP_REQUIRE_API_KEY=false) are unrestricted', async () => {
    const { app } = setup(['mcp'], false);
    const res = await call(app, undefined, 'create_order', SAMPLE.create_order!);
    expect(res.status).toBe(200);
    expect((await res.json()).result.structuredContent.error.code).toBe('ledger_unavailable');
  });
});
