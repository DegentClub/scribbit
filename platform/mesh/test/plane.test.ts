import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../src/keys.ts';
import { invoiceHash, signInvoice, signReceipt, verifyReceipt } from '../src/money.ts';
import { activeKeysOf, planeDocument, PLANE_WELL_KNOWN, trustedKeysOf, validatePlaneDocument, verifyPlaneDocument } from '../src/plane.ts';

const active = generateKeyPair();
const retired = generateKeyPair();
const doc = () => planeDocument({ name: 'acme-plane', keys: [{ publicKey: active.publicKey, status: 'active' }, { publicKey: retired.publicKey, status: 'retired' }], chains: ['evm:84532', 'btc:signet'], schemas: ['https://flashyos.com/schema/wallet/signed-receipt.json'], generatedAt: '2026-09-24T00:00:00.000Z' });

describe('plane document', () => {
  it('builds with kids computed from the keys and a null url by default', () => {
    expect(PLANE_WELL_KNOWN).toBe('/.well-known/flashyos-plane.json');
    const d = doc();
    expect(d).toMatchObject({ version: 1, plane: { name: 'acme-plane', url: null }, keys: [{ kid: active.kid, status: 'active' }, { kid: retired.kid, status: 'retired' }] });
    expect(verifyPlaneDocument(d)).toEqual({ ok: true, keys: d.keys });
    expect(validatePlaneDocument(d)).toEqual([]);
    expect(trustedKeysOf(d)).toEqual([active.publicKey, retired.publicKey]);
    expect(activeKeysOf(d)).toEqual([active.publicKey]);
  });
  it('verifyPlaneDocument refuses a bad kid, no active key and junk (the flashyos-wdk semantics)', () => {
    const d = doc();
    expect(verifyPlaneDocument({ ...d, keys: [{ ...d.keys[0], kid: 'ab'.repeat(32) }] })).toMatchObject({ ok: false, code: 'BAD_KID' });
    expect(verifyPlaneDocument({ ...d, keys: [d.keys[1]] })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyPlaneDocument({ ...d, keys: [] })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyPlaneDocument({ ...d, keys: [{ kid: 'x', publicKey: 'nope', status: 'active' }] })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyPlaneDocument(null)).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
  it('validatePlaneDocument reports every problem', () => {
    const d = doc();
    const bad = { ...d, version: 2, plane: { name: '', url: 5 }, keys: [{ ...d.keys[0], kid: 'x' }, d.keys[1], d.keys[1]], chains: ['nope'], schemas: [''], generatedAt: '' };
    expect(validatePlaneDocument(bad).map((f) => `${f.code}@${f.path}`)).toEqual([
      'bad-version@version', 'no-plane-name@plane.name', 'bad-plane-url@plane.url', 'bad-kid@keys[0]', 'duplicate-kid@keys[2]', 'bad-chain@chains[0]', 'bad-schema@schemas[0]', 'no-generated-at@generatedAt',
    ]);
    expect(validatePlaneDocument({ ...d, keys: [d.keys[1]] }).map((f) => f.code)).toEqual(['no-active-key']);
    expect(validatePlaneDocument({ ...d, keys: [{ kid: 1 }] }).map((f) => f.code)).toEqual(['bad-key', 'no-active-key']);
    expect(validatePlaneDocument(7).map((f) => f.code)).toEqual(['not-an-object']);
    expect(validatePlaneDocument({}).map((f) => f.code)).toEqual(['bad-version', 'no-plane', 'no-keys', 'no-chains', 'no-schemas', 'no-generated-at']);
  });
  it('a receipt signed under a retired key still verifies against the document\'s keys', () => {
    const payee = generateKeyPair();
    const invoice = signInvoice({ version: 1, id: 'i', payee: { name: 'p', publicKey: payee.publicKey }, chain: 'evm:1', asset: 'native', amount: '1', destination: '0x1', memo: '', issuedAt: '2026-09-20T00:00:00Z', expiresAt: '2026-09-30T00:00:00Z' }, payee.privateKey);
    const receipt = signReceipt({ version: 1, invoiceId: 'i', invoiceHash: invoiceHash(invoice), payer: { org: 'acme', agentName: 'ops', publicKey: retired.publicKey }, payee: invoice.payee, chain: 'evm:1', asset: 'native', amount: '1', destination: '0x1', txHash: '0x1', outcome: 'CONFIRMED', authorizationId: 'a', settledAt: '2026-09-21T00:00:00Z' }, retired.privateKey);
    expect(verifyReceipt(receipt, { trustedKeys: trustedKeysOf(doc()), invoice })).toEqual({ ok: true });
    expect(verifyReceipt(receipt, { trustedKeys: activeKeysOf(doc()) })).toEqual({ ok: false, code: 'WRONG_KEY' });
  });
});
