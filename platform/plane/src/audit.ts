// The audit log: every verdict (refusals too - "refusals are evidence"), authorization,
// settlement, resolution, envelope change and expiry, append-only and hash-chained per
// organisation. The entry shape and hash rule are FlashyOS's `ProvenanceEntry` (Phase 20,
// packages/wallet-wdk/src/provenance.ts): hash = sha256(canonical({seq, at, kind, id, data,
// prev})), prev = the previous entry's hash, 64 zeros first - so their `verifyExport`
// algorithm checks our chain. The kinds are ours.
//
// Like @bsh/mesh's records, the digest is sha256 of the canonical JSON (mesh `digestOf`),
// and the head can be signed with the plane key (mesh's checkpoint `x-signature` idea): a
// reader holding only the plane document can check that a page is what the plane served.
import { sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { asPrivateKey, canonicalBytes, digestOf, fromBase64Url, keyFingerprint, publicKeyOf, toBase64Url } from '@bsh/mesh';

export const GENESIS = '0'.repeat(64);
export const AUDIT_KINDS = ['decision', 'authorization', 'settlement', 'resolution', 'envelope', 'expiry'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditFact {
  at: string;
  kind: AuditKind;
  id: string;
  data: Record<string, unknown>;
}

export interface AuditEntryPayload extends AuditFact {
  seq: number;
  prev: string;
}

export interface AuditEntry extends AuditEntryPayload {
  hash: string;
}

export const auditHash = (e: AuditEntryPayload): string => digestOf({ seq: e.seq, at: e.at, kind: e.kind, id: e.id, data: e.data, prev: e.prev });

/** The next entry after `head` (undefined = the first). */
export function chainEntry(head: { seq: number; hash: string } | undefined, fact: AuditFact): AuditEntry {
  const payload: AuditEntryPayload = { seq: head ? head.seq + 1 : 0, at: fact.at, kind: fact.kind, id: fact.id, data: fact.data, prev: head ? head.hash : GENESIS };
  return { ...payload, hash: auditHash(payload) };
}

export interface AuditHeadPayload {
  version: 1;
  org: string;
  seq: number;
  hash: string;
  at: string;
  /** Fingerprint of the signing key (sha256 of its SPKI DER). */
  kid: string;
}

export interface AuditHead extends AuditHeadPayload {
  sig: string;
}

const HEAD_FIELDS = ['version', 'org', 'seq', 'hash', 'at', 'kid'] as const;
const canonicalHead = (h: AuditHeadPayload): Buffer => canonicalBytes(Object.fromEntries(HEAD_FIELDS.map((k) => [k, h[k]])));

export function signAuditHead(org: string, entry: AuditEntry, privateKey: string | KeyObject): AuditHead {
  const key = asPrivateKey(privateKey);
  const payload: AuditHeadPayload = { version: 1, org, seq: entry.seq, hash: entry.hash, at: entry.at, kid: keyFingerprint(publicKeyOf(key)) };
  return { ...payload, sig: toBase64Url(edSign(null, canonicalHead(payload), key)) };
}

/** The head verifies under one of `trustedKeys`. Never throws. */
export function verifyAuditHead(head: unknown, trustedKeys: readonly string[]): boolean {
  const h = head as AuditHead;
  if (!h || typeof h !== 'object' || h.version !== 1 || typeof h.sig !== 'string' || typeof h.hash !== 'string' || typeof h.seq !== 'number') return false;
  let sig: Buffer;
  try {
    sig = fromBase64Url(h.sig);
  } catch {
    return false;
  }
  return trustedKeys.some((pem) => {
    try {
      return edVerify(null, canonicalHead(h), createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
}

export type AuditCheck =
  | { ok: true; entries: number; head: { seq: number; hash: string } | null }
  | { ok: false; code: 'MALFORMED' | 'HASH_MISMATCH' | 'CHAIN_BROKEN' | 'SEQ_GAP' | 'NOT_ORDERED' | 'HEAD_MISMATCH' | 'BAD_SIGNATURE'; seq?: number; detail: string };

const HEX64 = /^[0-9a-f]{64}$/;

export interface VerifyAuditOptions {
  /** The hash before the first entry given (default GENESIS: the page starts the log). */
  prev?: string;
  /** The seq of the first entry given (default 0). */
  startSeq?: number;
  /** A signed head: the last entry must be it, and it must verify under `trustedKeys`. */
  head?: AuditHead;
  trustedKeys?: readonly string[];
}

/**
 * Every hash recomputes, every prev is the previous hash, seqs are contiguous, times never
 * go backwards; with a head, the page ends at it and its signature verifies. One altered
 * character anywhere is a refusal that names the entry.
 */
export function verifyAuditChain(entries: readonly unknown[], options: VerifyAuditOptions = {}): AuditCheck {
  let prev = options.prev ?? GENESIS;
  let seq = options.startSeq ?? 0;
  let lastAt = '';
  let last: AuditEntry | undefined;
  for (const raw of entries) {
    const e = raw as AuditEntry;
    if (!e || typeof e !== 'object' || typeof e.hash !== 'string' || typeof e.prev !== 'string' || typeof e.at !== 'string' || typeof e.id !== 'string' || typeof e.kind !== 'string' || !e.data || typeof e.data !== 'object')
      return { ok: false, code: 'MALFORMED', seq, detail: `entry ${seq} is not an audit entry` };
    if (e.seq !== seq) return { ok: false, code: 'SEQ_GAP', seq, detail: `expected seq ${seq}, found ${e.seq}` };
    if (e.prev !== prev) return { ok: false, code: 'CHAIN_BROKEN', seq, detail: `entry ${seq} names prev ${e.prev.slice(0, 12)}…, expected ${prev.slice(0, 12)}…` };
    if (!HEX64.test(e.hash) || auditHash(e) !== e.hash) return { ok: false, code: 'HASH_MISMATCH', seq, detail: `entry ${seq} (${e.kind}:${e.id}) does not hash to what it claims` };
    if (e.at < lastAt) return { ok: false, code: 'NOT_ORDERED', seq, detail: `entry ${seq} is dated before entry ${seq - 1}` };
    lastAt = e.at;
    prev = e.hash;
    last = e;
    seq++;
  }
  if (options.head) {
    if (!last || options.head.seq !== last.seq || options.head.hash !== last.hash) return { ok: false, code: 'HEAD_MISMATCH', detail: `the page ends at ${last ? `${last.seq}:${last.hash.slice(0, 12)}` : 'nothing'}, the head names ${options.head.seq}:${options.head.hash.slice(0, 12)}` };
    if (!verifyAuditHead(options.head, options.trustedKeys ?? [])) return { ok: false, code: 'BAD_SIGNATURE', detail: 'the head does not verify under any trusted key' };
  }
  return { ok: true, entries: entries.length, head: last ? { seq: last.seq, hash: last.hash } : null };
}
