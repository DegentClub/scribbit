/**
 * server.json (the MCP registry listing) against the registry schema and against this package: name/mcpName,
 * version and the tool/resource/prompt lists must match package.json and what the server actually registers.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { SERVER_VERSION } from '../src/index.js';
import { connect, type Harness } from './helpers.js';

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const server = read('../server.json');
const pkg = read('../package.json');
/** Vendored from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (modelcontextprotocol/registry). */
const registrySchema = read('./fixtures/mcp-registry-server.schema.2025-12-11.json');
const meta = server._meta['io.modelcontextprotocol.registry/publisher-provided']['it.scribb/server'];

describe('server.json (MCP registry listing)', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('validates against the registry schema it declares', () => {
    expect(server.$schema).toBe(registrySchema.$id);
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    const validate = ajv.compile(registrySchema);
    expect(validate(server), JSON.stringify(validate.errors, null, 1)).toBe(true);
    // The vendored schema really constrains: a malformed name or a missing version is refused.
    expect(validate({ ...server, name: 'no slash here' })).toBe(false);
    const { version: _v, ...noVersion } = server;
    expect(validate(noVersion)).toBe(false);
  });

  it('name matches package.json mcpName (npm ownership check) and the npm identifier is this package', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].registryType).toBe('npm');
  });

  it('version agrees with package.json, the npm package entry and the running server', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(h.client.getServerVersion()?.version).toBe(server.version);
  });

  it('tools, resources and prompts listed in _meta are exactly what the server registers', async () => {
    expect([...meta.tools].sort()).toEqual((await h.client.listTools()).tools.map((t) => t.name).sort());
    expect([...meta.resources].sort()).toEqual((await h.client.listResources()).resources.map((r) => r.uri).sort());
    expect([...meta.prompts].sort()).toEqual((await h.client.listPrompts()).prompts.map((p) => p.name).sort());
    expect(meta.readOnly).toBe(true);
    for (const t of (await h.client.listTools()).tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it('respects the official registry limits (description <= 100 chars, publisher metadata <= 4 KiB, only that _meta key)', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(Object.keys(server._meta)).toEqual(['io.modelcontextprotocol.registry/publisher-provided']);
    expect(Buffer.byteLength(JSON.stringify(server._meta['io.modelcontextprotocol.registry/publisher-provided']))).toBeLessThanOrEqual(4096);
    expect(server.packages[0].registryBaseUrl).toBe('https://registry.npmjs.org');
  });

  it('documents every stdio environment variable it lists in env.schema.json, and none are secrets', () => {
    const env = read('../env.schema.json');
    for (const v of server.packages[0].environmentVariables) {
      expect(Object.keys(env.properties), v.name).toContain(v.name);
      expect(v.isSecret).toBe(false);
    }
  });
});
