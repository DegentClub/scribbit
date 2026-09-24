// checkpoint/1 - a Merkle tree head over what a repository already seals.
//
// A port of FlashyLabs' vendor-checkpoint.mjs: RFC 6962 (leaf = SHA256(0x00 || digest
// bytes), node = SHA256(0x01 || left || right), split at the largest power of two
// less than n, empty root = SHA256("")), the claims gathered from fragments sorted by
// id so the root is a pure function of them, inclusion proofs and their verification.
//
// FlashyOS's own head is UNSIGNED, deliberately: the publisher holds the data and the
// root, so a self-issued signature would imply a guarantee it cannot give. This package
// adds an OPTIONAL extension - `signCheckpointHead` puts an Ed25519 signature under
// `x-signature` - for the one thing a signature does prove: that a specific key
// (ours) issued this head at this size and root, so a counterparty can tell our head
// from a forged one. It still does not stop us re-publishing; that needs consistency
// proofs and an outside witness, which neither format has.
import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes, fromBase64Url, sha256Hex, toBase64Url } from './canonical.ts';
import { HEX64_RE, isRecord } from './common.ts';
import { asPrivateKey, keyFingerprint, normalizePem } from './keys.ts';

export const CHECKPOINT_VERSION = '1';
export const CHECKPOINT_WELL_KNOWN = '/.well-known/checkpoint.json';

// ── RFC 6962 ────────────────────────────────────────────────────────────────

const hashOf = (...parts: Uint8Array[]): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

export const EMPTY_ROOT: string = sha256Hex('');

const hx = (s: string): Buffer => {
  if (!HEX64_RE.test(s)) throw new TypeError(`not a sha256 hex digest: ${JSON.stringify(s)}`);
  return Buffer.from(s, 'hex');
};

/** SHA256(0x00 || digest). The prefix is domain separation, not decoration. */
export const leafHash = (digest: string): string => hashOf(Buffer.from([0x00]), hx(digest));
/** SHA256(0x01 || left || right). */
export const nodeHash = (left: string, right: string): string => hashOf(Buffer.from([0x01]), hx(left), hx(right));

/** The largest power of two strictly less than n (n ≥ 2). */
export function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(leaves: string[]): string {
  if (leaves.length === 0) return EMPTY_ROOT;
  if (leaves.length === 1) return leaves[0]!;
  const k = splitPoint(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/** The Merkle tree hash over leaf digests, in the order given. */
export const merkleRoot = (digests: readonly string[]): string => mth(digests.map(leafHash));

/** The audit path for the leaf at `index`: sibling hashes from the leaf upward. */
export function inclusionPath(digests: readonly string[], index: number): string[] {
  if (index < 0 || index >= digests.length) throw new RangeError(`index ${index} is outside 0..${digests.length - 1}`);
  const path = (leaves: string[], m: number): string[] => {
    if (leaves.length === 1) return [];
    const k = splitPoint(leaves.length);
    return m < k ? [...path(leaves.slice(0, k), m), mth(leaves.slice(k))] : [...path(leaves.slice(k), m - k), mth(leaves.slice(0, k))];
  };
  return path(digests.map(leafHash), index);
}

/** Does `digest` at `index` of a tree of `size` leaves hash up through `path` to `root`? Never throws. */
export function verifyInclusion(digest: string, index: number, size: number, path: readonly string[], root: string): boolean {
  try {
    if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
    const goRight: boolean[] = [];
    let i = index;
    let n = size;
    while (n > 1) {
      const k = splitPoint(n);
      if (i < k) {
        goRight.push(false);
        n = k;
      } else {
        goRight.push(true);
        i -= k;
        n -= k;
      }
    }
    if (path.length !== goRight.length) return false;
    let hash = leafHash(digest);
    for (let s = 0; s < path.length; s++) {
      const sibling = path[s]!;
      hash = goRight[goRight.length - 1 - s] ? nodeHash(sibling, hash) : nodeHash(hash, sibling);
    }
    return hash === root;
  } catch {
    return false;
  }
}

// ── Claims ──────────────────────────────────────────────────────────────────

/** A sealed record the tree commits to. */
export interface Claim {
  id: string;
  /** sha256 hex - the record's own seal. */
  digest: string;
  /** Which format it came from (`shipped`, `directory`). */
  kind?: string;
}

/** Where claims are read from in a fragment: [list key, kind]. backlog/1 is absent by design - an item decays and is never sealed. */
export const CLAIM_SOURCES: readonly (readonly [key: string, kind: string])[] = [
  ['entries', 'shipped'],
  ['assertions', 'directory'],
  ['nodes', 'directory'],
  ['edges', 'directory'],
];

const byId = (a: Claim, b: Claim): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Sorted by id, first occurrence wins, unsealed records skipped (never hashed as a blank). */
export function claimsOf(fragments: readonly unknown[]): Claim[] {
  const found = new Map<string, Claim>();
  for (const fragment of fragments) {
    if (!isRecord(fragment)) continue;
    for (const [key, kind] of CLAIM_SOURCES) {
      const list = fragment[key];
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!isRecord(r) || typeof r.id !== 'string' || !r.id || typeof r.digest !== 'string' || !r.digest) continue;
        if (!found.has(r.id)) found.set(r.id, { id: r.id, digest: r.digest, kind });
      }
    }
  }
  return [...found.values()].sort(byId);
}

export const sortClaims = (claims: readonly Claim[]): Claim[] => [...claims].sort(byId);

export interface CheckpointHead {
  checkpoint: '1';
  /** `repo/<name>` (or a URL): who published the head. */
  origin: string;
  size: number;
  root: string;
  /** ISO timestamp. */
  at: string;
  counts?: Record<string, number>;
}

/** The head over `records` (sorted by id here, so the order given does not matter). */
export function checkpointHead(records: readonly Claim[], origin: string, at: string = new Date().toISOString()): CheckpointHead {
  const claims = sortClaims(records);
  const digests = claims.map((c) => c.digest);
  const counts: Record<string, number> = {};
  for (const c of claims) {
    const kind = c.kind ?? 'unknown';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const head: CheckpointHead = { checkpoint: '1', origin, size: digests.length, root: digests.length ? merkleRoot(digests) : EMPTY_ROOT, at };
  if (claims.length) head.counts = counts;
  return head;
}

export interface InclusionProof {
  checkpoint: '1';
  origin?: string;
  id: string;
  digest: string;
  index: number;
  size: number;
  root: string;
  path: string[];
}

/** An inclusion proof for the claim `id`, or null when the tree does not contain it. */
export function inclusionProof(records: readonly Claim[], id: string, origin?: string): InclusionProof | null {
  const claims = sortClaims(records);
  const index = claims.findIndex((c) => c.id === id);
  if (index < 0) return null;
  const digests = claims.map((c) => c.digest);
  const proof: InclusionProof = { checkpoint: '1', id, digest: digests[index]!, index, size: digests.length, root: merkleRoot(digests), path: inclusionPath(digests, index) };
  if (origin !== undefined) proof.origin = origin;
  return proof;
}

/** Proves against the root the proof itself names; pass `root` to prove against a head you hold instead. */
export const verifyInclusionProof = (proof: InclusionProof, root: string = proof.root): boolean =>
  verifyInclusion(proof.digest, proof.index, proof.size, proof.path, root);

export type CheckpointRecompute = { ok: true; size: number; root: string } | { ok: false; code: 'MALFORMED' | 'MISMATCH' | 'LEAF_FAILED'; detail: string };

/** Does the head describe these records? Root and size recomputed, then every leaf proved (not a sample). */
export function recomputeCheckpoint(head: unknown, records: readonly Claim[]): CheckpointRecompute {
  if (!isRecord(head) || head.checkpoint !== CHECKPOINT_VERSION || typeof head.root !== 'string' || typeof head.size !== 'number')
    return { ok: false, code: 'MALFORMED', detail: 'a head carries checkpoint "1", a root and a size' };
  const claims = sortClaims(records);
  const digests = claims.map((c) => c.digest);
  const root = digests.length ? merkleRoot(digests) : EMPTY_ROOT;
  if (root !== head.root || digests.length !== head.size)
    return { ok: false, code: 'MISMATCH', detail: `published size ${head.size} root ${head.root}; recomputed size ${digests.length} root ${root}` };
  for (let i = 0; i < digests.length; i++)
    if (!verifyInclusion(digests[i]!, i, digests.length, inclusionPath(digests, i), root))
      return { ok: false, code: 'LEAF_FAILED', detail: `leaf ${i} (${claims[i]!.id}) does not prove against the root` };
  return { ok: true, size: digests.length, root };
}

// ── The optional signature (scribbit extension) ─────────────────────────────

export interface CheckpointSignature {
  alg: 'ed25519';
  /** sha256 of the SPKI DER of `publicKey`, hex. */
  kid: string;
  /** SPKI PEM. */
  publicKey: string;
  /** base64url(ed25519(canonical head without `x-signature`)). */
  sig: string;
}

export interface SignedCheckpointHead extends CheckpointHead {
  'x-signature': CheckpointSignature;
}

/** The bytes a signature covers: the head with `x-signature` removed, canonical. */
export function canonicalHead(head: Record<string, unknown>): Buffer {
  const { 'x-signature': _ignored, ...rest } = head;
  return canonicalBytes(rest);
}

/** OUR extension: an Ed25519 signature under `x-signature`. FlashyOS's own head carries none. */
export function signCheckpointHead(head: CheckpointHead, privateKey: string | KeyObject): SignedCheckpointHead {
  const key = asPrivateKey(privateKey);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const sig = toBase64Url(edSign(null, canonicalHead(head as unknown as Record<string, unknown>), key));
  return { ...head, 'x-signature': { alg: 'ed25519', kid: keyFingerprint(publicKey), publicKey, sig } };
}

export type CheckpointSignatureCheck = { ok: true; kid: string } | { ok: false; code: 'UNSIGNED' | 'MALFORMED' | 'BAD_KID' | 'WRONG_KEY' | 'BAD_SIGNATURE'; detail: string };

/**
 * Verifies the `x-signature` of a head. As with receipts, a document cannot vouch for
 * itself: pass `trustedKeys` (SPKI PEMs) and the embedded key must be one of them.
 */
export function verifyCheckpointHead(head: unknown, options: { trustedKeys?: string[] } = {}): CheckpointSignatureCheck {
  if (!isRecord(head)) return { ok: false, code: 'MALFORMED', detail: 'a head is a JSON object' };
  const s = head['x-signature'];
  if (s === undefined) return { ok: false, code: 'UNSIGNED', detail: 'this head carries no x-signature (FlashyOS heads are unsigned by design)' };
  if (!isRecord(s) || s.alg !== 'ed25519' || typeof s.kid !== 'string' || typeof s.publicKey !== 'string' || typeof s.sig !== 'string')
    return { ok: false, code: 'MALFORMED', detail: 'x-signature carries alg "ed25519", kid, publicKey and sig' };
  let kid: string;
  try {
    kid = keyFingerprint(s.publicKey);
  } catch (err) {
    return { ok: false, code: 'MALFORMED', detail: (err as Error).message };
  }
  if (kid !== s.kid) return { ok: false, code: 'BAD_KID', detail: `kid ${s.kid} is not the fingerprint of the key it carries (${kid})` };
  if (options.trustedKeys !== undefined && !options.trustedKeys.some((k) => normalizePem(k) === normalizePem(s.publicKey as string)))
    return { ok: false, code: 'WRONG_KEY', detail: 'the signing key is not one the verifier trusts' };
  try {
    const ok = edVerify(null, canonicalHead(head), createPublicKey(s.publicKey), fromBase64Url(s.sig));
    return ok ? { ok: true, kid } : { ok: false, code: 'BAD_SIGNATURE', detail: 'the signature does not verify under the carried key' };
  } catch (err) {
    return { ok: false, code: 'BAD_SIGNATURE', detail: (err as Error).message };
  }
}
