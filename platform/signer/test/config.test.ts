import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, taprootPoliciesFrom } from '../src/config.js';

function baseEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SIGNER_KEY_PROVIDER: 'env',
    SIGNER_KEY_IDS: 'degent-parent',
    SIGNER_API_KEY_ENV: 'test',
    SIGNER_API_KEYS_JSON: JSON.stringify([{ id: 'svc', hash: 'a'.repeat(64), env: 'test', scopes: ['sign:degent-parent'] }]),
    ...over,
  };
}

describe('loadConfig: SIGNER_POLICY', () => {
  it('defaults to "default" with no parentReturn config', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.policy).toBe('default');
    expect(cfg.parentReturn).toBeUndefined();
  });

  it('rejects an unknown policy name', () => {
    expect(() => loadConfig(baseEnv({ SIGNER_POLICY: 'bogus' }))).toThrow(ConfigError);
  });

  it('parent-return requires SIGNER_PARENT_RETURN_KEY_ID', () => {
    expect(() => loadConfig(baseEnv({ SIGNER_POLICY: 'parent-return', SIGNER_MAX_FEE_SATS: '9000' }))).toThrow(/SIGNER_PARENT_RETURN_KEY_ID/);
  });

  it('parent-return requires SIGNER_MAX_FEE_SATS', () => {
    expect(() => loadConfig(baseEnv({ SIGNER_POLICY: 'parent-return', SIGNER_PARENT_RETURN_KEY_ID: 'degent-parent' }))).toThrow(/SIGNER_MAX_FEE_SATS/);
  });

  it('parent-return is incompatible with SIGNER_OUTPUT_ALLOWLIST', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          SIGNER_POLICY: 'parent-return',
          SIGNER_PARENT_RETURN_KEY_ID: 'degent-parent',
          SIGNER_MAX_FEE_SATS: '9000',
          SIGNER_OUTPUT_ALLOWLIST: 'bc1pxyz',
        }),
      ),
    ).toThrow(/SIGNER_OUTPUT_ALLOWLIST/);
  });

  it('builds a parentReturn config from env with defaults', () => {
    const cfg = loadConfig(baseEnv({ SIGNER_POLICY: 'parent-return', SIGNER_PARENT_RETURN_KEY_ID: 'degent-parent', SIGNER_MAX_FEE_SATS: '9000' }));
    expect(cfg.policy).toBe('parent-return');
    expect(cfg.parentReturn).toEqual({ kind: 'parentReturn', keyId: 'degent-parent', inputIndex: 0, maxInputs: 2, maxOutputs: 2, minPostageSats: 330n, maxFeeSats: 9000n });
  });

  it('honours the SIGNER_PARENT_RETURN_* overrides', () => {
    const cfg = loadConfig(
      baseEnv({
        SIGNER_POLICY: 'parent-return',
        SIGNER_PARENT_RETURN_KEY_ID: 'degent-parent',
        SIGNER_MAX_FEE_SATS: '9000',
        SIGNER_PARENT_RETURN_INPUT_INDEX: '1',
        SIGNER_PARENT_RETURN_MAX_INPUTS: '3',
        SIGNER_PARENT_RETURN_MAX_OUTPUTS: '4',
        SIGNER_PARENT_RETURN_MIN_POSTAGE_SATS: '546',
        SIGNER_PARENT_RETURN_RETURN_SCRIPT: '5120' + 'aa'.repeat(32),
        SIGNER_PARENT_RETURN_ALLOWED_SIGHASH: '0x00,0x81',
      }),
    );
    expect(cfg.parentReturn).toEqual({
      kind: 'parentReturn',
      keyId: 'degent-parent',
      inputIndex: 1,
      maxInputs: 3,
      maxOutputs: 4,
      minPostageSats: 546n,
      maxFeeSats: 9000n,
      returnScript: '5120' + 'aa'.repeat(32),
      allowedSighash: [0x00, 0x81],
    });
  });

  it('taprootPoliciesFrom builds exactly one shape policy for parent-return, plus maxInputValue when configured', () => {
    const cfg = loadConfig(
      baseEnv({
        SIGNER_POLICY: 'parent-return',
        SIGNER_PARENT_RETURN_KEY_ID: 'degent-parent',
        SIGNER_MAX_FEE_SATS: '9000',
        SIGNER_MAX_INPUT_SATS: '10000',
      }),
    );
    const policies = taprootPoliciesFrom(cfg);
    expect(policies.map((p) => p.name)).toEqual(['max-input-value', 'parent-return']);
  });

  it('the default policy keeps the generic maxFee policy instead', () => {
    const cfg = loadConfig(baseEnv({ SIGNER_MAX_FEE_SATS: '5000' }));
    const policies = taprootPoliciesFrom(cfg);
    expect(policies.map((p) => p.name)).toEqual(['max-fee']);
  });
});
