import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { InMemoryAuditLog, InMemoryKeyProvider, Signer, deny, type AuditRecord, type Policy, type TaprootKeyPathInspection } from '../src/index.js';
import { PRIV_A, RECIPIENT, XONLY_A, keyPathPsbt } from './helpers.js';

const DIGEST = hex.encode(sha256(new TextEncoder().encode('block 900000 certified')));

function setup(opts: { taprootPolicies?: Policy<TaprootKeyPathInspection>[]; purposes?: string[]; keys?: InMemoryKeyProvider } = {}) {
  const audit = new InMemoryAuditLog();
  let t = 1_000;
  let n = 0;
  const signer = new Signer({
    keys: opts.keys ?? new InMemoryKeyProvider([['a', PRIV_A]]),
    audit,
    allowedPurposes: opts.purposes ?? ['blockspace.certify'],
    taprootPolicies: opts.taprootPolicies ?? [],
    network: 'signet',
    now: () => (t += 5),
    idGenerator: () => `audit-${++n}`,
  });
  return { signer, audit };
}

const noSecrets = (r: AuditRecord) => {
  const s = JSON.stringify(r);
  expect(s).not.toContain(hex.encode(PRIV_A));
  expect(s).not.toMatch(/psbt/i);
  expect(s).not.toMatch(/"signature"/);
};

describe('Signer audit trail', () => {
  it('records an allow with the facts a reviewer needs and nothing secret', async () => {
    const { signer, audit } = setup();
    const { psbtBase64 } = keyPathPsbt({ amount: 50_000n, outputs: [{ address: RECIPIENT, amount: 48_000n }] });
    const res = await signer.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a', finalize: true }, { principal: 'svc-1', requestId: 'req-1' });
    const [rec] = audit.list();
    expect(rec).toMatchObject({
      id: 'audit-1',
      kind: 'taproot-keypath',
      keyId: 'a',
      principal: 'svc-1',
      decision: 'allow',
      requestId: 'req-1',
      details: {
        inputIndex: 0,
        sighashType: 0,
        digest: res.digest,
        fee: '2000',
        outputs: [{ amount: '48000', address: RECIPIENT }],
        finalize: true,
        txid: res.txid,
      },
    });
    expect(rec!.durationMs).toBeGreaterThan(0);
    expect(Date.parse(rec!.at)).toBeGreaterThanOrEqual(1_005);
    noSecrets(rec!);
  });

  it('records a deny with the policy name and reason, and never calls the key provider', async () => {
    const keys = new InMemoryKeyProvider([['a', PRIV_A]]);
    let signs = 0;
    const raw = keys.sign.bind(keys);
    keys.sign = (...args) => {
      signs++;
      return raw(...args);
    };
    const { signer, audit } = setup({ keys, taprootPolicies: [{ name: 'treasury-only', inspect: () => deny('not the treasury') }] });
    const { psbtBase64 } = keyPathPsbt();
    await expect(signer.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' }, { principal: 'p' })).rejects.toMatchObject({
      code: 'policy_denied',
      status: 403,
      message: 'treasury-only: not the treasury',
    });
    expect(signs).toBe(0);
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]).toMatchObject({ decision: 'deny', reason: 'treasury-only: not the treasury', principal: 'p' });
    noSecrets(audit.list()[0]!);
  });

  it('records errors (unknown key, bad PSBT) as error with the code', async () => {
    const { signer, audit } = setup();
    await expect(signer.signTaprootKeyPath({ psbtBase64: 'AAAA', inputIndex: 0, keyId: 'a' })).rejects.toMatchObject({ code: 'psbt_invalid' });
    await expect(signer.signSchnorrDigest({ keyId: 'ghost', digest32: DIGEST, purpose: 'blockspace.certify' })).rejects.toMatchObject({ code: 'unknown_key' });
    expect(audit.list().map((r) => [r.kind, r.decision, r.reason?.split(':')[0]])).toEqual([
      ['schnorr-digest', 'error', 'unknown_key'],
      ['taproot-keypath', 'error', 'psbt_invalid'],
    ]);
    expect(audit.list({ decision: 'error', keyId: 'ghost' })).toHaveLength(1);
    expect(audit.list({ limit: 1 })).toHaveLength(1);
  });
});

describe('signSchnorrDigest (attestations)', () => {
  it('signs an allowed purpose with the untweaked key and audits it', async () => {
    const { signer, audit } = setup();
    const res = await signer.signSchnorrDigest({ keyId: 'a', digest32: DIGEST.toUpperCase(), purpose: 'blockspace.certify' }, { principal: 'certify' });
    expect(res.publicKey).toBe(hex.encode(XONLY_A));
    expect(res.digest32).toBe(DIGEST);
    expect(schnorr.verify(hex.decode(res.signature), hex.decode(DIGEST), XONLY_A)).toBe(true);
    expect(audit.list()[0]).toMatchObject({ kind: 'schnorr-digest', decision: 'allow', principal: 'certify', details: { purpose: 'blockspace.certify', digest: DIGEST.toUpperCase() } });
  });

  it('denies purposes outside the allowlist and malformed requests', async () => {
    const { signer, audit } = setup();
    await expect(signer.signSchnorrDigest({ keyId: 'a', digest32: DIGEST, purpose: 'blockspace.anything' })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(signer.signSchnorrDigest({ keyId: 'a', digest32: DIGEST, purpose: 'Blockspace.Certify' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(signer.signSchnorrDigest({ keyId: 'a', digest32: 'abcd', purpose: 'blockspace.certify' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(signer.signSchnorrDigest({ keyId: 'a', digest32: DIGEST, purpose: 'blockspace.certify' })).resolves.toBeTruthy();
    expect(audit.list().map((r) => r.decision)).toEqual(['allow', 'error', 'error', 'deny']);
  });

  it('an empty purpose allowlist disables digest signing entirely', async () => {
    const { signer } = setup({ purposes: [] });
    await expect(signer.signSchnorrDigest({ keyId: 'a', digest32: DIGEST, purpose: 'blockspace.certify' })).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('publicKey reports x-only and tweaked keys', async () => {
    const { signer } = setup();
    const pk = await signer.publicKey('a');
    expect(pk.xOnlyPublicKey).toBe(hex.encode(XONLY_A));
    expect(pk.tweakedPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(pk.tweakedPublicKey).not.toBe(pk.xOnlyPublicKey);
    await expect(signer.publicKey('ghost')).rejects.toMatchObject({ code: 'unknown_key' });
  });
});
