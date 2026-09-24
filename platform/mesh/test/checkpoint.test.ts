import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/canonical.ts';
import {
  canonicalHead, checkpointHead, claimsOf, EMPTY_ROOT, inclusionPath, inclusionProof, leafHash, merkleRoot, nodeHash, recomputeCheckpoint, signCheckpointHead, splitPoint, verifyCheckpointHead, verifyInclusion, verifyInclusionProof,
} from '../src/checkpoint.ts';
import { generateKeyPair } from '../src/keys.ts';

const d = (i: number): string => sha256Hex(`leaf-${i}`);
const digests = (n: number): string[] => Array.from({ length: n }, (_, i) => d(i));

/** An independent, naive RFC 6962 MTH for cross-checking. */
const naive = (leaves: string[]): string => {
  if (leaves.length === 0) return createHash('sha256').digest('hex');
  if (leaves.length === 1) return createHash('sha256').update(Buffer.from([0])).update(Buffer.from(leaves[0]!, 'hex')).digest('hex');
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return createHash('sha256').update(Buffer.from([1])).update(Buffer.from(naive(leaves.slice(0, k)), 'hex')).update(Buffer.from(naive(leaves.slice(k)), 'hex')).digest('hex');
};

describe('RFC 6962 hashing', () => {
  it('uses the domain-separated leaf and node hashes and the empty root', () => {
    expect(EMPTY_ROOT).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(leafHash(d(0))).toBe(createHash('sha256').update(Buffer.from([0x00])).update(Buffer.from(d(0), 'hex')).digest('hex'));
    expect(nodeHash(d(0), d(1))).toBe(createHash('sha256').update(Buffer.from([0x01])).update(Buffer.from(d(0), 'hex')).update(Buffer.from(d(1), 'hex')).digest('hex'));
    expect(leafHash(d(0))).not.toBe(sha256Hex(Buffer.from(d(0), 'hex')));
    expect(() => leafHash('not-hex')).toThrow(TypeError);
  });
  it('splits at the largest power of two less than n', () => {
    expect([2, 3, 4, 5, 7, 8, 9, 16, 17].map(splitPoint)).toEqual([1, 2, 2, 4, 4, 4, 8, 8, 16]);
  });
  it('computes the same root as a naive implementation for every size up to 20', () => {
    expect(merkleRoot([])).toBe(EMPTY_ROOT);
    expect(merkleRoot([d(0)])).toBe(leafHash(d(0)));
    expect(merkleRoot([d(0), d(1)])).toBe(nodeHash(leafHash(d(0)), leafHash(d(1))));
    expect(merkleRoot(digests(3))).toBe(nodeHash(nodeHash(leafHash(d(0)), leafHash(d(1))), leafHash(d(2))));
    for (let n = 0; n <= 20; n++) expect(merkleRoot(digests(n))).toBe(naive(digests(n)));
  });
});

describe('inclusion proofs', () => {
  it('prove every leaf of every tree up to size 12, and nothing else', () => {
    for (let n = 1; n <= 12; n++) {
      const leaves = digests(n);
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const path = inclusionPath(leaves, i);
        expect(verifyInclusion(leaves[i]!, i, n, path, root)).toBe(true);
        expect(verifyInclusion(d(99), i, n, path, root)).toBe(false);
        expect(verifyInclusion(leaves[i]!, (i + 1) % n, n, path, root)).toBe(n === 1 ? true : false);
        expect(verifyInclusion(leaves[i]!, i, n, [...path, d(5)], root)).toBe(false);
      }
    }
    expect(verifyInclusion(d(0), 3, 3, [], merkleRoot(digests(3)))).toBe(false);
    expect(verifyInclusion('junk', 0, 1, [], 'junk')).toBe(false);
    expect(() => inclusionPath(digests(2), 2)).toThrow(RangeError);
  });
  it('an interior node presented as a leaf does not prove (the prefixes are not decoration)', () => {
    const leaves = digests(2);
    const interior = merkleRoot(leaves);
    expect(verifyInclusion(interior, 0, 1, [], interior)).toBe(false);
  });
});

describe('claims and heads', () => {
  const shipped = { shipped: '1', entries: [{ id: 'ship/x/b', digest: d(1) }, { id: 'ship/x/a', digest: d(0) }, { id: 'ship/x/unsealed' }] };
  const directory = { directory: '0.1', nodes: [{ id: 'org/x', digest: d(2) }, { id: 'org/x', digest: d(9) }], edges: [{ id: 'e/1' }] };
  it('gathers sealed records from every source, sorted by id, first occurrence winning, unsealed skipped', () => {
    expect(claimsOf([shipped, directory, null, 'x'])).toEqual([
      { id: 'org/x', digest: d(2), kind: 'directory' },
      { id: 'ship/x/a', digest: d(0), kind: 'shipped' },
      { id: 'ship/x/b', digest: d(1), kind: 'shipped' },
    ]);
  });
  it('builds a head that is a pure function of the claims, with counts, and an empty head over nothing', () => {
    const claims = claimsOf([shipped, directory]);
    const head = checkpointHead(claims, 'repo/x', '2026-09-24T00:00:00.000Z');
    expect(head).toEqual({ checkpoint: '1', origin: 'repo/x', size: 3, root: merkleRoot([d(2), d(0), d(1)]), at: '2026-09-24T00:00:00.000Z', counts: { directory: 1, shipped: 2 } });
    expect(checkpointHead([...claims].reverse(), 'repo/x', head.at)).toEqual(head);
    expect(checkpointHead([], 'repo/x', head.at)).toEqual({ checkpoint: '1', origin: 'repo/x', size: 0, root: EMPTY_ROOT, at: head.at });
    expect(recomputeCheckpoint(head, claims)).toEqual({ ok: true, size: 3, root: head.root });
    expect(recomputeCheckpoint(head, claims.slice(1))).toMatchObject({ ok: false, code: 'MISMATCH' });
    expect(recomputeCheckpoint({ root: 'x' }, claims)).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
  it('proves a claim by id against the head, and null for a claim not in the tree', () => {
    const claims = claimsOf([shipped, directory]);
    const head = checkpointHead(claims, 'repo/x');
    const proof = inclusionProof(claims, 'ship/x/a', 'repo/x')!;
    expect(proof).toMatchObject({ checkpoint: '1', origin: 'repo/x', id: 'ship/x/a', digest: d(0), index: 1, size: 3, root: head.root });
    expect(proof.path).toHaveLength(2);
    expect(verifyInclusionProof(proof)).toBe(true);
    expect(verifyInclusionProof(proof, head.root)).toBe(true);
    expect(verifyInclusionProof({ ...proof, digest: d(7) })).toBe(false);
    expect(inclusionProof(claims, 'ship/x/nope')).toBeNull();
  });
});

describe('signed heads (scribbit extension)', () => {
  const claims = claimsOf([{ entries: [{ id: 'ship/x/a', digest: d(0) }] }]);
  const head = checkpointHead(claims, 'repo/x', '2026-09-24T00:00:00.000Z');
  const ours = generateKeyPair();
  const theirs = generateKeyPair();
  it('signs the canonical head under x-signature and verifies, with kid and trusted keys', () => {
    const signed = signCheckpointHead(head, ours.privateKey);
    expect(signed['x-signature']).toMatchObject({ alg: 'ed25519', kid: ours.kid, publicKey: ours.publicKey });
    expect(canonicalHead(signed as unknown as Record<string, unknown>).toString()).toBe(canonicalHead(head as unknown as Record<string, unknown>).toString());
    expect(verifyCheckpointHead(signed)).toEqual({ ok: true, kid: ours.kid });
    expect(verifyCheckpointHead(signed, { trustedKeys: [ours.publicKey] })).toEqual({ ok: true, kid: ours.kid });
    expect(verifyCheckpointHead(signed, { trustedKeys: [theirs.publicKey] })).toMatchObject({ ok: false, code: 'WRONG_KEY' });
    expect(recomputeCheckpoint(signed, claims).ok).toBe(true);
  });
  it('refuses a tampered head, a bad kid, an unsigned head and junk', () => {
    const signed = signCheckpointHead(head, ours.privateKey);
    expect(verifyCheckpointHead({ ...signed, size: 2 })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyCheckpointHead({ ...signed, 'x-signature': { ...signed['x-signature'], kid: 'ab'.repeat(32) } })).toMatchObject({ ok: false, code: 'BAD_KID' });
    expect(verifyCheckpointHead({ ...signed, 'x-signature': { ...signed['x-signature'], publicKey: theirs.publicKey, kid: theirs.kid } })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyCheckpointHead(head)).toMatchObject({ ok: false, code: 'UNSIGNED' });
    expect(verifyCheckpointHead({ ...head, 'x-signature': { alg: 'rsa' } })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyCheckpointHead({ ...signed, 'x-signature': { ...signed['x-signature'], publicKey: 'nope' } })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyCheckpointHead(null)).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
});
