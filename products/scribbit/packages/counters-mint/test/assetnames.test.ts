import { describe, expect, it } from 'vitest';
import { NUMERIC_MAX, NUMERIC_MIN, assetId, checkAssetName, classifyAssetName, compactSubassetLongname, isNumericAssetName, issuanceBurnXcp, randomNumericAsset } from '../src/assetnames.js';
import { bytesToHex } from '../src/bytes.js';

describe('classifyAssetName', () => {
  const table: [string, ReturnType<typeof classifyAssetName>][] = [
    ['MEMENOME', 'named'],
    ['XDUALS', 'named'],
    ['BBBB', 'named'],
    ['ZZZZZZZZZZZZ', 'named'], // 12 letters
    ['ZZZZZZZZZZZZZ', 'invalid'], // 13
    ['ABCD', 'invalid'], // A-prefix reserved for numerics
    ['abc', 'invalid'],
    ['BTC', 'invalid'],
    ['XCP', 'invalid'],
    ['BB1B', 'invalid'],
    [`A${NUMERIC_MIN}`, 'numeric'],
    [`A${NUMERIC_MAX}`, 'numeric'],
    [`A${NUMERIC_MIN - 1n}`, 'invalid'], // 26^12 itself is out of range
    [`A${NUMERIC_MAX + 1n}`, 'invalid'],
    ['A123', 'invalid'],
    ['A', 'invalid'],
    ['MEMENOME.sub-1', 'subasset'],
    ['MEMENOME.a.b_c@d!', 'subasset'],
    [`A${NUMERIC_MIN}.child`, 'subasset'],
    ['A123.x', 'invalid'],
    ['MEMENOME.bad space', 'invalid'],
    ['MEMENOME.', 'invalid'],
    [`MEMENOME.${'x'.repeat(250)}`, 'invalid'], // longname > 250
  ];
  it.each(table)('%s → %s', (name, expected) => {
    expect(classifyAssetName(name)).toBe(expected);
  });

  it('reports the reason the node would give', () => {
    expect(checkAssetName('XCP')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkAssetName('A123')).toEqual({ ok: false, reason: 'numeric-out-of-range' });
    expect(checkAssetName('ABCD')).toEqual({ ok: false, reason: 'named-shape' });
    expect(checkAssetName('A123.x')).toEqual({ ok: false, reason: 'subasset-parent' });
    expect(checkAssetName('MEMENOME.bad space')).toEqual({ ok: false, reason: 'subasset-child' });
    expect(checkAssetName('MEMENOME.sub')).toEqual({ ok: true, kind: 'subasset', parent: 'MEMENOME' });
  });
});

describe('issuanceBurnXcp', () => {
  it('burns 0.5 XCP for a named asset and nothing otherwise', () => {
    expect(issuanceBurnXcp('MEMENOME')).toBe(50_000_000n);
    expect(issuanceBurnXcp(`A${NUMERIC_MIN}`)).toBe(0n);
    expect(issuanceBurnXcp('MEMENOME.sub')).toBe(0n);
    expect(() => issuanceBurnXcp('ABCD')).toThrow(/not a valid asset name/);
  });
});

describe('randomNumericAsset', () => {
  it('draws inside the consensus range', () => {
    for (let i = 0; i < 300; i++) {
      const name = randomNumericAsset();
      expect(isNumericAssetName(name)).toBe(true);
      const value = BigInt(name.slice(1));
      expect(value >= NUMERIC_MIN && value <= NUMERIC_MAX).toBe(true);
    }
  });
  it('does not repeat', () => {
    const names = new Set(Array.from({ length: 50 }, () => randomNumericAsset()));
    expect(names.size).toBe(50);
  });
});

describe('assetId (Core generate_asset_id)', () => {
  it('matches the id inside a real Core envelope', () => {
    // CORE_ENVELOPE carries CBOR uint32 0x0d95873d for its asset.
    expect(assetId('TESTBH')).toBe(0x0d95873dn);
  });
  it('handles the reserved and numeric forms', () => {
    expect(assetId('BTC')).toBe(0n);
    expect(assetId('XCP')).toBe(1n);
    expect(assetId(`A${NUMERIC_MIN}`)).toBe(NUMERIC_MIN);
  });
});

describe('compactSubassetLongname (Core base-68)', () => {
  it('encodes "a" as 0x01 and round-trips lengths', () => {
    expect(bytesToHex(compactSubassetLongname('a'))).toBe('01');
    expect(bytesToHex(compactSubassetLongname('!'))).toBe('43'); // the 67th digit; Core's base is 68 with digit 0 unused
    expect(compactSubassetLongname('sub-1').length).toBe(4);
  });
});
