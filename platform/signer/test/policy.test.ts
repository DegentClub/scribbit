import { describe, expect, it } from 'vitest';
import {
  allOf,
  allowAll,
  allowedSighashTypes,
  denyAll,
  maxFee,
  maxInputValue,
  outputAllowlist,
  principalAllowlist,
  purposeAllowlist,
  type SchnorrDigestInspection,
  type TaprootKeyPathInspection,
} from '../src/index.js';

const tap = (over: Partial<TaprootKeyPathInspection> = {}): TaprootKeyPathInspection => ({
  kind: 'taproot-keypath',
  keyId: 'k',
  inputIndex: 0,
  sighashType: 0,
  input: { txid: 'a'.repeat(64), vout: 0, amount: 10_000n, script: '5120aa' },
  inputs: [{ txid: 'a'.repeat(64), vout: 0, amount: 10_000n, script: '5120aa' }],
  outputs: [{ amount: 9_000n, script: '5120bb', address: 'tb1pxyz' }],
  version: 2,
  lockTime: 0,
  fee: 1_000n,
  principal: 'svc',
  ...over,
});

const digest = (over: Partial<SchnorrDigestInspection> = {}): SchnorrDigestInspection => ({
  kind: 'schnorr-digest',
  keyId: 'k',
  purpose: 'blockspace.certify',
  digest32: 'c'.repeat(64),
  principal: 'svc',
  ...over,
});

describe('built-in policies', () => {
  it('allowedSighashTypes defaults to DEFAULT + ALL', async () => {
    const p = allowedSighashTypes();
    expect(await p.inspect(tap({ sighashType: 0 }))).toEqual({ allow: true });
    expect(await p.inspect(tap({ sighashType: 1 }))).toEqual({ allow: true });
    expect(await p.inspect(tap({ sighashType: 0x83 }))).toMatchObject({ allow: false, reason: expect.stringContaining('0x83') });
    expect(await allowedSighashTypes([0x83]).inspect(tap({ sighashType: 0x83 }))).toEqual({ allow: true });
  });

  it('maxInputValue / maxFee bound the money at risk', async () => {
    expect(await maxInputValue(10_000n).inspect(tap())).toEqual({ allow: true });
    expect(await maxInputValue(9_999n).inspect(tap())).toMatchObject({ allow: false });
    expect(await maxFee(1_000n).inspect(tap())).toEqual({ allow: true });
    expect(await maxFee(999n).inspect(tap())).toMatchObject({ allow: false, reason: expect.stringContaining('fee 1000') });
    expect(await maxFee(1_000n).inspect(tap({ fee: -1n }))).toMatchObject({ allow: false });
  });

  it('outputAllowlist matches scripts or addresses, case-insensitively, and names the offending output', async () => {
    expect(await outputAllowlist(['TB1PXYZ']).inspect(tap())).toEqual({ allow: true });
    expect(await outputAllowlist(['5120BB']).inspect(tap())).toEqual({ allow: true });
    const d = await outputAllowlist(['tb1pother']).inspect(tap({ outputs: [{ amount: 1n, script: '5120bb', address: 'tb1pxyz' }, { amount: 1n, script: '00' }] }));
    expect(d).toMatchObject({ allow: false, reason: 'output 0 (tb1pxyz) is not in the allowlist' });
  });

  it('purposeAllowlist denies anything not listed, including the empty list', async () => {
    expect(await purposeAllowlist(['blockspace.certify']).inspect(digest())).toEqual({ allow: true });
    expect(await purposeAllowlist(['blockspace.certify']).inspect(digest({ purpose: 'blockspace.certify.v2' }))).toMatchObject({ allow: false });
    expect(await purposeAllowlist([]).inspect(digest())).toMatchObject({ allow: false, reason: expect.stringContaining('blockspace.certify') });
  });

  it('principalAllowlist ties keys to callers', async () => {
    const p = principalAllowlist({ k: ['svc'] });
    expect(await p.inspect(digest())).toEqual({ allow: true });
    expect(await p.inspect(digest({ principal: 'other' }))).toMatchObject({ allow: false });
    expect(await p.inspect(digest({ keyId: 'unlisted' }))).toMatchObject({ allow: false, reason: expect.stringContaining('no principal allowlist') });
  });

  it('allOf: first denial wins, prefixed with the policy name; supports async policies', async () => {
    const slowDeny = { name: 'slow', inspect: async () => ({ allow: false as const, reason: 'nope' }) };
    const combined = allOf([allowAll(), slowDeny, denyAll('never reached')]);
    expect(await combined.inspect(tap())).toEqual({ allow: false, reason: 'slow: nope' });
    expect(await allOf([allowAll(), allowAll()]).inspect(tap())).toEqual({ allow: true });
    expect(await allOf([]).inspect(tap())).toEqual({ allow: true });
  });
});
