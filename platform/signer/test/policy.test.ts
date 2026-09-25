import { describe, expect, it } from 'vitest';
import {
  allOf,
  allowAll,
  allowedSighashTypes,
  denyAll,
  forKeys,
  maxFee,
  maxInputValue,
  outputAllowlist,
  P2TR_DUST_SATS,
  parentReturn,
  PARENT_RETURN_DENIAL_CODES,
  principalAllowlist,
  purposeAllowlist,
  type ParentReturnPolicyConfig,
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

  it('allOf carries the denying policy\'s machine code through', async () => {
    const codedDeny = { name: 'coded', inspect: () => ({ allow: false as const, reason: 'nope', code: 'my_code' }) };
    expect(await allOf([codedDeny]).inspect(tap())).toEqual({ allow: false, reason: 'coded: nope', code: 'my_code' });
  });

  it('forKeys routes to the policy for the request\'s key id and denies uncovered keys', async () => {
    const p = forKeys({ a: outputAllowlist(['5120bb']), b: denyAll('b is locked') });
    expect(await p.inspect(tap({ keyId: 'a' }))).toEqual({ allow: true });
    expect(await p.inspect(tap({ keyId: 'b' }))).toMatchObject({ allow: false, reason: 'b is locked' });
    expect(await p.inspect(tap({ keyId: 'c' }))).toMatchObject({ allow: false, code: 'key_not_covered', reason: expect.stringContaining('key "c"') });
  });
});

// ---------------------------------------------------------------------------------------------------
// parentReturn: the degent collection-parent co-signing shape.

const PARENT_SCRIPT = '5120' + 'aa'.repeat(32);
const CHILD_SCRIPT = '5120' + 'bb'.repeat(32);
const COMMIT_TXID = 'c'.repeat(64);

/** A valid parent-return shape: 2 inputs (parent + commit), 2 outputs (parent return + child postage). */
const parentTap = (over: Partial<TaprootKeyPathInspection> = {}): TaprootKeyPathInspection =>
  tap({
    keyId: 'degent-parent',
    inputIndex: 0,
    sighashType: 0x00,
    input: { txid: 'a'.repeat(64), vout: 0, amount: 10_000n, script: PARENT_SCRIPT },
    inputs: [
      { txid: 'a'.repeat(64), vout: 0, amount: 10_000n, script: PARENT_SCRIPT },
      { txid: COMMIT_TXID, vout: 1, amount: 10_000n, script: CHILD_SCRIPT },
    ],
    outputs: [
      { amount: 10_000n, script: PARENT_SCRIPT, address: 'bc1pparent' },
      { amount: 1_000n, script: CHILD_SCRIPT, address: 'bc1pchild' },
    ],
    fee: 9_000n,
    ...over,
  });

const defaultCfg: ParentReturnPolicyConfig = { keyId: 'degent-parent', maxFeeSats: 9_000n };

describe('parentReturn', () => {
  it('allows the exact shape the degent mint sends', async () => {
    expect(await parentReturn(defaultCfg).inspect(parentTap())).toEqual({ allow: true });
  });

  it('denies a key it does not govern', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ keyId: 'someone-else' }));
    expect(d).toMatchObject({ allow: false, code: 'key_not_covered' });
    expect((d as { reason: string }).reason).toMatch(/^key_not_covered: /);
  });

  it('denies signing anything but the parent input', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ inputIndex: 1 }));
    expect(d).toMatchObject({ allow: false, code: 'input_index_not_allowed' });
  });

  it('denies a disallowed sighash type (default SIGHASH_DEFAULT only)', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ sighashType: 0x01 }));
    expect(d).toMatchObject({ allow: false, code: 'sighash_not_allowed' });
  });

  it('allows an additionally configured sighash type', async () => {
    const cfg = { ...defaultCfg, allowedSighash: [0x00, 0x01] };
    expect(await parentReturn(cfg).inspect(parentTap({ sighashType: 0x01 }))).toEqual({ allow: true });
  });

  it('denies too few inputs (no commit input)', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ inputs: [{ txid: 'a'.repeat(64), vout: 0, amount: 10_000n, script: PARENT_SCRIPT }] }));
    expect(d).toMatchObject({ allow: false, code: 'too_few_inputs' });
  });

  it('denies too many inputs beyond the configured maximum', async () => {
    const inputs = [...parentTap().inputs, { txid: 'd'.repeat(64), vout: 0, amount: 1_000n, script: CHILD_SCRIPT }];
    const d = await parentReturn(defaultCfg).inspect(parentTap({ inputs }));
    expect(d).toMatchObject({ allow: false, code: 'too_many_inputs' });
  });

  it('allows more inputs when maxInputs is raised', async () => {
    const inputs = [...parentTap().inputs, { txid: 'd'.repeat(64), vout: 0, amount: 1_000n, script: CHILD_SCRIPT }];
    expect(await parentReturn({ ...defaultCfg, maxInputs: 3 }).inspect(parentTap({ inputs }))).toEqual({ allow: true });
  });

  it('denies too few outputs (no child output)', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ outputs: [{ amount: 10_000n, script: PARENT_SCRIPT, address: 'bc1pparent' }] }));
    expect(d).toMatchObject({ allow: false, code: 'too_few_outputs' });
  });

  it('denies a third output (too_many_outputs)', async () => {
    const outputs = [...parentTap().outputs, { amount: 1_000n, script: CHILD_SCRIPT }];
    const d = await parentReturn(defaultCfg).inspect(parentTap({ outputs, fee: 9_000n }));
    expect(d).toMatchObject({ allow: false, code: 'too_many_outputs' });
  });

  it('allows more outputs when maxOutputs is raised', async () => {
    const outputs = [...parentTap().outputs, { amount: 1_000n, script: CHILD_SCRIPT }];
    expect(await parentReturn({ ...defaultCfg, maxOutputs: 3 }).inspect(parentTap({ outputs, fee: 9_000n }))).toEqual({ allow: true });
  });

  it('denies output 0 paying the wrong script (parent_return_script_mismatch)', async () => {
    const outputs = [{ amount: 10_000n, script: CHILD_SCRIPT, address: 'bc1pwrong' }, parentTap().outputs[1]!];
    const d = await parentReturn(defaultCfg).inspect(parentTap({ outputs }));
    expect(d).toMatchObject({ allow: false, code: 'parent_return_script_mismatch' });
  });

  it('denies output 0 worth more than the parent input (parent_return_value_mismatch)', async () => {
    const outputs = [{ amount: 10_001n, script: PARENT_SCRIPT, address: 'bc1pparent' }, parentTap().outputs[1]!];
    const d = await parentReturn(defaultCfg).inspect(parentTap({ outputs, fee: 9_000n }));
    expect(d).toMatchObject({ allow: false, code: 'parent_return_value_mismatch' });
  });

  it('denies output 0 worth less than the parent input (parent_return_value_mismatch)', async () => {
    const outputs = [{ amount: 9_999n, script: PARENT_SCRIPT, address: 'bc1pparent' }, parentTap().outputs[1]!];
    const d = await parentReturn(defaultCfg).inspect(parentTap({ outputs, fee: 9_000n }));
    expect(d).toMatchObject({ allow: false, code: 'parent_return_value_mismatch' });
  });

  it('denies postage below dust on the child output', async () => {
    const outputs = [parentTap().outputs[0]!, { amount: 329n, script: CHILD_SCRIPT, address: 'bc1pchild' }];
    const d = await parentReturn(defaultCfg).inspect(parentTap({ outputs, fee: 9_000n }));
    expect(d).toMatchObject({ allow: false, code: 'postage_below_dust' });
  });

  it('allows postage exactly at the 330-sat dust threshold', async () => {
    const outputs = [parentTap().outputs[0]!, { amount: P2TR_DUST_SATS, script: CHILD_SCRIPT, address: 'bc1pchild' }];
    expect(await parentReturn(defaultCfg).inspect(parentTap({ outputs, fee: 9_000n }))).toEqual({ allow: true });
  });

  it('honours a raised minPostageSats', async () => {
    const outputs = [parentTap().outputs[0]!, { amount: 500n, script: CHILD_SCRIPT, address: 'bc1pchild' }];
    const d = await parentReturn({ ...defaultCfg, minPostageSats: 546n }).inspect(parentTap({ outputs, fee: 9_000n }));
    expect(d).toMatchObject({ allow: false, code: 'postage_below_dust' });
    expect(await parentReturn({ ...defaultCfg, minPostageSats: 500n }).inspect(parentTap({ outputs, fee: 9_000n }))).toEqual({ allow: true });
  });

  it('denies a fee above the cap', async () => {
    const d = await parentReturn({ ...defaultCfg, maxFeeSats: 8_999n }).inspect(parentTap());
    expect(d).toMatchObject({ allow: false, code: 'fee_above_cap' });
  });

  it('allows a fee exactly at the cap', async () => {
    expect(await parentReturn({ ...defaultCfg, maxFeeSats: 9_000n }).inspect(parentTap())).toEqual({ allow: true });
  });

  it('denies a negative fee (outputs exceed inputs)', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ fee: -1n }));
    expect(d).toMatchObject({ allow: false, code: 'fee_negative' });
  });

  it('honours a configured returnScript instead of the parent input\'s own script', async () => {
    const treasury = '5120' + 'ee'.repeat(32);
    const cfg = { ...defaultCfg, returnScript: treasury };
    const outputs = [{ amount: 10_000n, script: treasury, address: 'bc1ptreasury' }, parentTap().outputs[1]!];
    expect(await parentReturn(cfg).inspect(parentTap({ outputs }))).toEqual({ allow: true });
    // paying the parent's OWN script is now the wrong script, since returnScript overrides the default.
    const d = await parentReturn(cfg).inspect(parentTap());
    expect(d).toMatchObject({ allow: false, code: 'parent_return_script_mismatch' });
  });

  it('honours a configured inputIndex (the parent need not be input 0)', async () => {
    const cfg = { ...defaultCfg, inputIndex: 1 };
    const shifted = parentTap({
      inputIndex: 1,
      inputs: [parentTap().inputs[1]!, parentTap().inputs[0]!],
    });
    expect(await parentReturn(cfg).inspect(shifted)).toEqual({ allow: true });
    expect(await parentReturn(cfg).inspect(parentTap({ inputIndex: 0 }))).toMatchObject({ allow: false, code: 'input_index_not_allowed' });
  });

  it('reasons are prefixed with the machine code, matching PARENT_RETURN_DENIAL_CODES', async () => {
    const d = await parentReturn(defaultCfg).inspect(parentTap({ inputIndex: 1 }));
    expect(d.allow).toBe(false);
    const code = (d as { code: string }).code;
    expect(PARENT_RETURN_DENIAL_CODES).toContain(code);
    expect((d as { reason: string }).reason.startsWith(`${code}: `)).toBe(true);
  });

  describe('config validation', () => {
    it('requires keyId', () => {
      expect(() => parentReturn({ maxFeeSats: 1n } as unknown as ParentReturnPolicyConfig)).toThrow(/keyId is required/);
    });

    it('requires maxFeeSats', () => {
      expect(() => parentReturn({ keyId: 'a' } as unknown as ParentReturnPolicyConfig)).toThrow(/maxFeeSats is required/);
    });

    it('rejects a mismatched kind discriminator', () => {
      expect(() => parentReturn({ ...defaultCfg, kind: 'other' as unknown as 'parentReturn' })).toThrow(/unexpected kind/);
    });

    it('rejects inputIndex >= maxInputs', () => {
      expect(() => parentReturn({ ...defaultCfg, inputIndex: 2, maxInputs: 2 })).toThrow(/inputIndex must be < maxInputs/);
    });

    it('rejects maxInputs/maxOutputs below 2', () => {
      expect(() => parentReturn({ ...defaultCfg, maxInputs: 1 })).toThrow(/>= 2/);
      expect(() => parentReturn({ ...defaultCfg, maxOutputs: 1 })).toThrow(/>= 2/);
    });

    it('rejects a non-scriptPubKey-hex returnScript', () => {
      expect(() => parentReturn({ ...defaultCfg, returnScript: 'not-hex' })).toThrow(/returnScript must be scriptPubKey hex/);
    });

    it('rejects a negative maxFeeSats', () => {
      expect(() => parentReturn({ ...defaultCfg, maxFeeSats: -1n })).toThrow(/non-negative/);
    });

    it('rejects an empty allowedSighash', () => {
      expect(() => parentReturn({ ...defaultCfg, allowedSighash: [] })).toThrow(/allowedSighash must not be empty/);
    });
  });
});
