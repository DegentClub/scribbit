import { describe, expect, it } from 'vitest';
import { bytesToHex, canonicalStringify, digestOf, fromBase64Url, hexToBytes, isBase64Url, sha256Hex, sortKeysDeep, toBase64Url } from '../src/canonical.ts';

describe('canonicalStringify', () => {
  it('sorts keys at every depth, keeps arrays in order, emits no whitespace', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });
  it('is the same document whatever the key order', () => {
    const a = { id: 'x', at: '2026-01-01', by: ['p'], kind: 'fix' };
    const b = { kind: 'fix', by: ['p'], at: '2026-01-01', id: 'x' };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(digestOf(a)).toBe(digestOf(b));
  });
  it('drops undefined members (JSON.stringify rule) and writes Dates as ISO strings', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalStringify({ at: new Date('2026-09-24T00:00:00Z') })).toBe('{"at":"2026-09-24T00:00:00.000Z"}');
    expect(sortKeysDeep([{ z: 1, y: null }])).toEqual([{ y: null, z: 1 }]);
  });
  it('throws for a value with no JSON representation', () => {
    expect(() => canonicalStringify(undefined)).toThrow(TypeError);
  });
});

describe('sha256', () => {
  it('matches the standard vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('base64url and hex', () => {
  it('round-trips bytes and refuses padding and the standard alphabet', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(new Uint8Array(fromBase64Url(text))).toEqual(bytes);
    expect(isBase64Url('abc-_')).toBe(true);
    expect(isBase64Url('abc+')).toBe(false);
    expect(() => fromBase64Url('a=')).toThrow(TypeError);
    expect(() => fromBase64Url('a/b')).toThrow(TypeError);
  });
  it('hex round-trips and refuses odd or non-hex input', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
    expect(() => hexToBytes('abc')).toThrow(TypeError);
    expect(() => hexToBytes('zz')).toThrow(TypeError);
  });
});
