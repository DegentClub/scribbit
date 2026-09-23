import { describe, expect, it } from 'vitest';
import {
  assertCompatibleEvolution,
  blockIndexed,
  createEvent,
  defineTopic,
  degentMintOrder,
  detectBreakingChanges,
  MINT_ORDER_STATUSES,
  platformRegistry,
  TopicError,
  TopicRegistry,
  validate,
  type JsonSchema,
} from '../src/index.js';

const HASH = 'a'.repeat(64);
const goodBlock = { network: 'mainnet' as const, height: 900_000, hash: HASH, previousHash: 'b'.repeat(64), time: '2026-09-23T12:00:00Z' };

describe('platform registry validation', () => {
  const reg = platformRegistry();
  const ev = (type: string, data: unknown) => createEvent({ source: 'urn:bsh:test', type, data });

  it('accepts good payloads', () => {
    expect(reg.validate(ev('block.indexed.mainnet', goodBlock))).toEqual({ valid: true, errors: [] });
    expect(
      reg.validate(
        ev('degent.mint.order.paid', {
          type: 'degent.mint.order.paid',
          eventId: 'o1:5',
          orderId: 'o1',
          network: 'signet',
          status: 'paid',
          previousStatus: 'awaiting_payment',
          at: '2026-09-23T12:00:00.000Z',
          lane: 'standard',
          txid: HASH,
        }),
      ).valid,
    ).toBe(true);
    expect(
      reg.validate(ev('batch.created', { batchId: 'b1', network: 'mainnet', status: 'created', previousStatus: null, at: '2026-09-23T12:00:00Z', orderCount: 3 })).valid,
    ).toBe(true);
    expect(reg.validate(ev('block.indexed.mainnet', { ...goodBlock, extraField: 'consumers ignore unknowns' })).valid).toBe(true);
  });

  it.each([
    ['missing required', { ...goodBlock, hash: undefined }, /\/data .*missing required property "hash"|\/data\/hash/],
    ['wrong type', { ...goodBlock, height: '1' }, /\/data\/height expected integer/],
    ['negative height', { ...goodBlock, height: -1 }, /below minimum/],
    ['non-integer', { ...goodBlock, height: 1.5 }, /expected integer/],
    ['bad hash', { ...goodBlock, hash: 'XYZ' }, /does not match/],
    ['bad enum', { ...goodBlock, network: 'litecoin' }, /must be one of/],
    ['bad date', { ...goodBlock, time: 'tomorrow' }, /date-time/],
  ])('rejects %s', (_n, data, msg) => {
    const clean = JSON.parse(JSON.stringify(data));
    const r = reg.validate(ev('block.indexed.mainnet', clean));
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => `${e.path} ${e.message}`).join('\n')).toMatch(msg);
  });

  it('rejects unknown topics and out-of-range params', () => {
    expect(reg.validate(ev('block.indexed.dogecoin', goodBlock)).errors[0]!.message).toMatch(/unknown topic/);
    expect(reg.validate(ev('nope', {})).valid).toBe(false);
    expect(() => reg.assertValid(ev('degent.mint.order.teleported', {}))).toThrow(TopicError);
  });

  it('accepts the member-approval statuses (confirming, member_review, declined) after paid', () => {
    const order = (status: string, previousStatus: string) =>
      ev(`degent.mint.order.${status}`, {
        type: `degent.mint.order.${status}`,
        eventId: 'o2:6',
        orderId: 'o2',
        network: 'mainnet',
        status,
        previousStatus,
        at: '2026-09-23T12:00:00.000Z',
        lane: 'block',
        txid: HASH,
      });
    expect(reg.validate(order('confirming', 'paid'))).toEqual({ valid: true, errors: [] });
    expect(reg.validate(order('member_review', 'confirming'))).toEqual({ valid: true, errors: [] });
    expect(reg.validate(order('declined', 'member_review'))).toEqual({ valid: true, errors: [] });
    expect(reg.validate(order('rescue_available', 'declined'))).toEqual({ valid: true, errors: [] });
    const paid = MINT_ORDER_STATUSES.indexOf('paid');
    expect(MINT_ORDER_STATUSES.slice(paid, paid + 5)).toEqual(['paid', 'confirming', 'member_review', 'declined', 'queued']);
  });

  it('resolves concrete names to templates and params', () => {
    expect(reg.resolve('degent.mint.order.rescue_available')).toMatchObject({ topic: degentMintOrder, params: { status: 'rescue_available' } });
    expect(reg.resolve('degent.mint.order.member_review')).toMatchObject({ topic: degentMintOrder, params: { status: 'member_review' } });
    expect(reg.resolve('collection.certified')?.params).toEqual({});
    expect(reg.list().map((t) => t.name)).toEqual([
      'batch.{status}',
      'block.indexed.{network}',
      'collection.certified',
      'collection.minted',
      'degent.mint.order.{status}',
    ]);
  });

  it('topic.create binds params, validates and sets dataschema', () => {
    const e = blockIndexed.create({ source: 'urn:bsh:bitcoin-indexer', params: { network: 'signet' }, data: { ...goodBlock, network: 'signet' }, subject: HASH });
    expect(e.type).toBe('block.indexed.signet');
    expect(e.dataschema).toMatch(/platform-events\.yaml#\/components\/schemas\/BlockIndexed$/);
    expect(() => blockIndexed.create({ source: 's', params: { network: 'signet' }, data: { ...goodBlock, height: -5 } })).toThrow(/invalid payload/);
    expect(() => blockIndexed.create({ source: 's', params: { network: 'moon' }, data: goodBlock as never })).toThrow(/not in/);
    expect(() => blockIndexed.typeFor({})).toThrow(/missing/);
  });
});

describe('defineTopic rules', () => {
  const base = { version: '1.0.0', schema: {}, producer: 'p', description: 'd' };
  it('enforces the .vN suffix for breaking majors', () => {
    expect(() => defineTopic({ ...base, name: 'collection.minted', version: '2.0.0' })).toThrow(/collection\.minted\.v2/);
    expect(() => defineTopic({ ...base, name: 'collection.minted.v2', version: '1.3.0' })).toThrow(/must not carry/);
    expect(() => defineTopic({ ...base, name: 'collection.minted.v3', version: '2.0.0' })).toThrow(/v2/);
    expect(defineTopic({ ...base, name: 'collection.minted.v2', version: '2.1.0' }).family).toBe('collection.minted');
  });
  it('requires declared params and valid names/versions', () => {
    expect(() => defineTopic({ ...base, name: 'a.{x}' })).toThrow(/does not declare parameter "x"/);
    expect(() => defineTopic({ ...base, name: 'a.b', params: { x: { description: '' } } })).toThrow(/unused/);
    expect(() => defineTopic({ ...base, name: 'A.B' })).toThrow(/invalid topic name/);
    expect(() => defineTopic({ ...base, name: 'a.b', version: '1.0' })).toThrow(/SemVer/);
  });
  it('registry rejects duplicates and overlapping templates', () => {
    const reg = new TopicRegistry([defineTopic({ ...base, name: 'collection.minted' })]);
    expect(() => reg.register(defineTopic({ ...base, name: 'collection.minted' }))).toThrow(/already/);
    expect(() => reg.register(defineTopic({ ...base, name: 'collection.{event}', params: { event: { description: 'e' } } }))).toThrow(/overlaps/);
    expect(() => reg.register(defineTopic({ ...base, name: 'collection.minted.v2', version: '2.0.0' }))).not.toThrow();
  });
});

describe('versioning: breaking change ⇒ new .vN topic', () => {
  const v1 = defineTopic({
    name: 'collection.minted',
    version: '1.0.0',
    producer: 'p',
    description: 'd',
    schema: {
      type: 'object',
      required: ['id', 'kind'],
      properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer' } },
    },
  });
  const rev = (name: string, version: string, schema: JsonSchema) => defineTopic({ ...v1, name, version, schema });

  it('allows additive minor changes', () => {
    const s = structuredClone(v1.schema);
    s.properties!.extra = { type: 'string' };
    s.properties!.kind!.enum = ['a', 'b', 'c'];
    expect(() => assertCompatibleEvolution(v1, rev('collection.minted', '1.1.0', s))).not.toThrow();
  });

  it.each<[string, (s: JsonSchema) => void, RegExp]>([
    ['removed property', (s) => delete s.properties!.n, /property removed/],
    ['required → optional', (s) => (s.required = ['id']), /no longer required/],
    ['type change', (s) => (s.properties!.n = { type: 'string' }), /type integer → string/],
    ['enum value removed', (s) => (s.properties!.kind!.enum = ['a']), /enum values removed "b"/],
  ])('flags %s and demands .v2', (_n, mutate, why) => {
    const s = structuredClone(v1.schema);
    mutate(s);
    expect(detectBreakingChanges(v1.schema, s).join()).toMatch(why);
    expect(() => assertCompatibleEvolution(v1, rev('collection.minted', '1.1.0', s))).toThrow(/publish it as collection\.minted\.v2/);
    expect(() => assertCompatibleEvolution(v1, rev('collection.minted.v2', '2.0.0', s))).not.toThrow();
  });

  it('rejects version regressions and misnamed majors', () => {
    expect(() => assertCompatibleEvolution(v1, rev('collection.minted', '1.0.0', v1.schema))).toThrow(/greater/);
    expect(() => assertCompatibleEvolution(v1, rev('collection.burned.v2', '2.0.0', v1.schema))).toThrow(/family/);
  });
});

describe('JSON Schema subset validator', () => {
  it('handles $ref, oneOf, anyOf, allOf, const, additionalProperties', () => {
    const s: JsonSchema = {
      $defs: { pos: { type: 'integer', minimum: 1 } },
      type: 'object',
      additionalProperties: false,
      properties: {
        n: { $ref: '#/$defs/pos' },
        k: { const: 'x' },
        u: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        a: { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'string' }, maxItems: 2 }] },
        s: { allOf: [{ type: 'string', minLength: 2 }, { maxLength: 3 }] },
      },
    };
    expect(validate(s, { n: 1, k: 'x', u: 'a', a: null, s: 'ab' }).valid).toBe(true);
    const bad = validate(s, { n: 0, k: 'y', u: true, a: ['a', 'b', 'c'], s: 'abcd', zz: 1 });
    expect(bad.errors.map((e) => e.path).sort()).toEqual(['/a', '/k', '/n', '/s', '/u', '/zz']);
  });
  it('number accepts integers; unicode lengths count code points', () => {
    expect(validate({ type: 'number' }, 3).valid).toBe(true);
    expect(validate({ type: 'string', maxLength: 1 }, '🙂').valid).toBe(true);
  });
});
