import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATH, PLATFORM_TOPICS, platformRegistry, validate, type JsonSchema } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
type Any = any;
const doc: Any = parse(readFileSync(`${repoRoot}${CONTRACT_PATH}`, 'utf8'));

const deref = (ref: string): Any =>
  ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node: Any, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
const resolve = (node: Any): Any => (node && typeof node.$ref === 'string' ? resolve(deref(node.$ref)) : node);

const channels = Object.entries<Any>(doc.channels);
const byAddress = new Map(channels.map(([id, c]) => [c.address as string, { id, channel: c }]));

describe(`${CONTRACT_PATH} ↔ code registry`, () => {
  it('is an AsyncAPI 3 document', () => {
    expect(doc.asyncapi).toMatch(/^3\.\d+\.\d+$/);
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares exactly the registered topics as channels', () => {
    expect([...byAddress.keys()].sort()).toEqual(platformRegistry().list().map((t) => t.name).sort());
  });

  it.each(PLATFORM_TOPICS.map((t) => [t.name, t] as const))('%s: parameters, version, producer, payload agree', (_name, topic) => {
    const { id, channel } = byAddress.get(topic.name)!;
    expect(channel.description).toBe(topic.description);

    // parameters: same names and enums
    const params = Object.fromEntries(Object.entries<Any>(channel.parameters ?? {}).map(([k, p]) => [k, resolve(p)]));
    expect(Object.keys(params).sort()).toEqual([...topic.paramNames].sort());
    for (const p of topic.paramNames) expect(params[p].enum ?? null).toEqual(topic.params[p]!.enum ? [...topic.params[p]!.enum!] : null);

    // one message; version, producer, data schema
    const messages = Object.values<Any>(channel.messages).map(resolve);
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg['x-topic-version']).toBe(topic.version);
    expect(msg['x-producer']).toBe(topic.producer);
    expect(msg.contentType ?? doc.defaultContentType).toBe('application/cloudevents+json');
    const [envelope, dataPart] = msg.payload.allOf;
    expect(envelope.$ref).toBe('#/components/schemas/CloudEvent');
    const dataRef: string = dataPart.properties.data.$ref;
    expect(resolve({ $ref: dataRef })).toEqual(JSON.parse(JSON.stringify(topic.schema)));
    expect(topic.dataschema).toBe(`https://blockspace.holdings/${CONTRACT_PATH}${dataRef}`);

    // a send operation by the producer on this channel
    const ops = Object.values<Any>(doc.operations).filter((o) => o.channel.$ref === `#/channels/${id}`);
    expect(ops.map((o) => o.action)).toEqual(['send']);
  });

  it('every $ref in the document resolves', () => {
    const refs: string[] = [];
    const walk = (n: Any) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) k === '$ref' ? refs.push(v as string) : walk(v);
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) expect(deref(r), r).toBeDefined();
  });

  it('the CloudEvent schema in the contract accepts envelopes built by createEvent', () => {
    const topic = PLATFORM_TOPICS[0];
    const e = topic.create({
      source: 'urn:bsh:bitcoin-indexer',
      params: { network: 'mainnet' },
      data: { network: 'mainnet', height: 1, hash: 'a'.repeat(64), previousHash: 'b'.repeat(64), time: '2026-09-23T12:00:00Z' },
    });
    expect(validate(doc.components.schemas.CloudEvent as JsonSchema, JSON.parse(JSON.stringify(e)))).toEqual({ valid: true, errors: [] });
  });
});
