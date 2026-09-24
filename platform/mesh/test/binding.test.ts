import { describe, expect, it } from 'vitest';
import { bindingDigest, canonicalBinding, createBindingUnsigned, nobleBip340, signBinding, signBindingBip340, signBindingEd25519, verifyBinding, verifyBindingBip340, verifyBindingEd25519 } from '../src/binding.ts';
import { bytesToHex, sha256Bytes } from '../src/canonical.ts';
import { generateKeyPair } from '../src/keys.ts';

const ed = generateKeyPair();
const other = generateKeyPair();
const secret = nobleBip340.randomSecretKey();
const xonly = bytesToHex(nobleBip340.getPublicKey(secret));
const unsigned = () => createBindingUnsigned({ org: 'example', ed25519PublicKey: ed.publicKey, xonlyPubkeyHex: xonly, issuedAt: '2026-09-24T00:00:00.000Z' });

describe('key binding (scribbit extension)', () => {
  it('creates the unsigned document with the kid derived from the Ed25519 key', () => {
    const doc = unsigned();
    expect(doc).toEqual({ version: 1, org: 'example', ed25519: { kid: ed.kid, publicKey: ed.publicKey }, bip340: { xonlyPubkeyHex: xonly }, issuedAt: '2026-09-24T00:00:00.000Z' });
    expect(() => createBindingUnsigned({ org: '', ed25519PublicKey: ed.publicKey, xonlyPubkeyHex: xonly })).toThrow(TypeError);
    expect(() => createBindingUnsigned({ org: 'x', ed25519PublicKey: ed.publicKey, xonlyPubkeyHex: 'abc' })).toThrow(TypeError);
    expect(() => createBindingUnsigned({ org: 'x', ed25519PublicKey: 'nope', xonlyPubkeyHex: xonly })).toThrow();
    expect(createBindingUnsigned({ org: 'x', ed25519PublicKey: ed.publicKey, xonlyPubkeyHex: xonly }).issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('both signatures cover the same canonical bytes; BIP340 signs their sha256', () => {
    const doc = unsigned();
    expect(canonicalBinding(doc).toString()).toBe(`{"bip340":{"xonlyPubkeyHex":"${xonly}"},"ed25519":{"kid":"${ed.kid}","publicKey":${JSON.stringify(ed.publicKey)}},"issuedAt":"2026-09-24T00:00:00.000Z","org":"example","version":1}`);
    expect(Buffer.from(bindingDigest(doc)).equals(sha256Bytes(canonicalBinding(doc)))).toBe(true);
    expect(canonicalBinding({ ...doc, sigEd25519: 'x', sigBip340: 'y' }).toString()).toBe(canonicalBinding(doc).toString());
  });
  it('signs with both keys and verifies each and both', () => {
    const doc = signBinding(unsigned(), { ed25519PrivateKey: ed.privateKey, bip340SecretKey: secret });
    expect(doc.sigEd25519).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(doc.sigBip340).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyBindingEd25519(doc)).toEqual({ ok: true });
    expect(verifyBindingBip340(doc)).toEqual({ ok: true });
    expect(verifyBinding(doc)).toEqual({ ok: true });
  });
  it('refuses a tampered document under either key', () => {
    const doc = signBinding(unsigned(), { ed25519PrivateKey: ed.privateKey, bip340SecretKey: secret });
    expect(verifyBindingEd25519({ ...doc, org: 'evil' })).toMatchObject({ ok: false, code: 'BAD_ED25519_SIGNATURE' });
    expect(verifyBindingBip340({ ...doc, org: 'evil' })).toMatchObject({ ok: false, code: 'BAD_BIP340_SIGNATURE' });
    expect(verifyBinding({ ...doc, issuedAt: '2027-01-01T00:00:00.000Z' })).toMatchObject({ ok: false });
    expect(verifyBindingBip340({ ...doc, sigBip340: 'ab' })).toMatchObject({ ok: false, code: 'BAD_BIP340_SIGNATURE' });
    expect(verifyBindingBip340({ ...doc, sigBip340: 'zz'.repeat(64) })).toMatchObject({ ok: false, code: 'BAD_BIP340_SIGNATURE' });
    const otherX = bytesToHex(nobleBip340.getPublicKey(nobleBip340.randomSecretKey()));
    const swapped = signBindingEd25519({ ...unsigned(), bip340: { xonlyPubkeyHex: otherX }, sigBip340: doc.sigBip340 }, ed.privateKey);
    expect(verifyBindingEd25519(swapped)).toEqual({ ok: true });
    expect(verifyBindingBip340(swapped)).toMatchObject({ ok: false, code: 'BAD_BIP340_SIGNATURE' });
  });
  it('refuses the wrong private key, a bad kid, an unsigned document and a malformed one', () => {
    expect(() => signBindingEd25519(unsigned(), other.privateKey)).toThrow(/kid/);
    expect(verifyBindingEd25519(unsigned())).toMatchObject({ ok: false, code: 'UNSIGNED' });
    expect(verifyBindingBip340(unsigned())).toMatchObject({ ok: false, code: 'UNSIGNED' });
    const badKid = { ...signBinding(unsigned(), { ed25519PrivateKey: ed.privateKey, bip340SecretKey: secret }), ed25519: { kid: other.kid, publicKey: ed.publicKey } };
    expect(verifyBinding(badKid)).toMatchObject({ ok: false, code: 'BAD_KID' });
    expect(verifyBinding(null)).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyBinding({ ...unsigned(), version: 2 })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyBinding({ ...unsigned(), bip340: { xonlyPubkeyHex: 'XYZ' } })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyBinding({ ...unsigned(), ed25519: { kid: 'x', publicKey: 'not a key' } })).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
  it('accepts a caller-provided BIP340 sign/verify', () => {
    const calls: string[] = [];
    const fakeSign = (m: Uint8Array, k: Uint8Array) => {
      calls.push(`sign:${m.length}:${k.length}`);
      return new Uint8Array(64).fill(7);
    };
    const fakeVerify = (s: Uint8Array, m: Uint8Array, p: Uint8Array) => {
      calls.push(`verify:${s.length}:${m.length}:${p.length}`);
      return s.every((b) => b === 7);
    };
    const doc = signBindingBip340(unsigned(), new Uint8Array(32), fakeSign);
    expect(doc.sigBip340).toBe('07'.repeat(64));
    expect(verifyBindingBip340(doc, fakeVerify)).toEqual({ ok: true });
    expect(verifyBindingBip340(doc)).toMatchObject({ ok: false, code: 'BAD_BIP340_SIGNATURE' });
    expect(calls).toEqual(['sign:32:32', 'verify:64:32:32']);
  });
});
