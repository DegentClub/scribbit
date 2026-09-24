// The plane document a FlashyOS plane publishes at /.well-known/flashyos-plane.json
// (flashyos-wdk interop.ts, Phase 23): its keys - the active authorization key and
// every retired one, each with kid = sha256 of its SPKI DER - the chains its signer
// reaches, the $id of every schema it enforces, and when it was generated.
// `verifyPlaneDocument` is the port; `validatePlaneDocument` is the same shape as
// Findings, one per problem.
import { asArray, asString, Collector, type Finding, isRecord } from './common.ts';
import { keyFingerprint } from './keys.ts';
import { CHAIN_RE } from './money.ts';

export const PLANE_WELL_KNOWN = '/.well-known/flashyos-plane.json';

export interface PlaneKey {
  kid: string;
  /** SPKI PEM. */
  publicKey: string;
  /** active: signs today. retired: signed once; still verifies, never signs again. */
  status: 'active' | 'retired';
}

export interface PlaneDocument {
  version: 1;
  plane: { name: string; url: string | null };
  keys: PlaneKey[];
  /** `<family>:<chainId>` the plane's signer can reach. */
  chains: string[];
  /** The $id of every schema the plane enforces. */
  schemas: string[];
  generatedAt: string;
}

export type PlaneDocumentCheck = { ok: true; keys: PlaneKey[] } | { ok: false; code: 'MALFORMED' | 'BAD_KID'; detail: string };

/** Shape, and every kid is the fingerprint of the key beside it - a document cannot name a key it does not carry. */
export function verifyPlaneDocument(doc: unknown): PlaneDocumentCheck {
  const d = doc as PlaneDocument;
  if (!d || typeof d !== 'object' || d.version !== 1 || !d.plane || typeof d.plane.name !== 'string' || !Array.isArray(d.keys) || d.keys.length === 0) {
    return { ok: false, code: 'MALFORMED', detail: 'a plane document needs version 1, a plane name and at least one key' };
  }
  for (const k of d.keys) {
    if (!k || typeof k.kid !== 'string' || typeof k.publicKey !== 'string' || (k.status !== 'active' && k.status !== 'retired')) {
      return { ok: false, code: 'MALFORMED', detail: 'each key needs kid, publicKey and status' };
    }
    let kid: string;
    try {
      kid = keyFingerprint(k.publicKey);
    } catch (err) {
      return { ok: false, code: 'MALFORMED', detail: `key ${k.kid}: ${(err as Error).message}` };
    }
    if (kid !== k.kid) return { ok: false, code: 'BAD_KID', detail: `key ${k.kid} is not the fingerprint of the key it carries (${kid})` };
  }
  if (!d.keys.some((k) => k.status === 'active')) return { ok: false, code: 'MALFORMED', detail: 'a plane document needs an active key' };
  return { ok: true, keys: d.keys };
}

/** Every problem in a plane document, one finding each (the port above stops at the first). */
export function validatePlaneDocument(doc: unknown): Finding[] {
  const out = new Collector();
  const bad = (code: string, at: string, message: string): void => out.bad(code, at, message);
  if (!isRecord(doc)) {
    bad('not-an-object', '', 'a plane document is a JSON object');
    return out.findings;
  }
  if (doc.version !== 1) bad('bad-version', 'version', `version must be 1, got ${JSON.stringify(doc.version)}`);
  const plane = isRecord(doc.plane) ? doc.plane : undefined;
  if (!plane) bad('no-plane', 'plane', 'a plane document names its plane');
  else {
    if (!asString(plane.name).trim()) bad('no-plane-name', 'plane.name', 'a plane has a name');
    if (plane.url !== null && plane.url !== undefined && typeof plane.url !== 'string') bad('bad-plane-url', 'plane.url', 'url is a string or null');
  }
  if (!Array.isArray(doc.keys) || !doc.keys.length) bad('no-keys', 'keys', 'a plane document needs at least one key');
  const seen = new Set<string>();
  let active = 0;
  asArray(doc.keys).forEach((raw, i) => {
    const at = `keys[${i}]`;
    const k = isRecord(raw) ? raw : {};
    if (typeof k.kid !== 'string' || typeof k.publicKey !== 'string') {
      bad('bad-key', at, 'each key needs kid and publicKey');
      return;
    }
    if (k.status !== 'active' && k.status !== 'retired') bad('bad-key-status', `${at}.status`, 'status is active or retired');
    if (k.status === 'active') active++;
    if (seen.has(k.kid)) bad('duplicate-kid', at, `kid ${k.kid} listed twice`);
    seen.add(k.kid);
    try {
      const kid = keyFingerprint(k.publicKey);
      if (kid !== k.kid) bad('bad-kid', at, `kid ${k.kid} is not the fingerprint of the key it carries (${kid})`);
    } catch (err) {
      bad('bad-public-key', `${at}.publicKey`, (err as Error).message);
    }
  });
  if (asArray(doc.keys).length && !active) bad('no-active-key', 'keys', 'a plane document needs an active key');
  if (!Array.isArray(doc.chains)) bad('no-chains', 'chains', 'chains is a list');
  else doc.chains.forEach((c, i) => {
    if (typeof c !== 'string' || !CHAIN_RE.test(c)) bad('bad-chain', `chains[${i}]`, `"${String(c)}" is not <family>:<chainId>`);
  });
  if (!Array.isArray(doc.schemas)) bad('no-schemas', 'schemas', 'schemas is a list');
  else doc.schemas.forEach((s, i) => {
    if (typeof s !== 'string' || !s) bad('bad-schema', `schemas[${i}]`, 'a schema is its $id');
  });
  if (typeof doc.generatedAt !== 'string' || !doc.generatedAt) bad('no-generated-at', 'generatedAt', 'a plane document says when it was generated');
  return out.findings;
}

/** Every key in the document, active and retired - what `verifyReceipt({ trustedKeys })` takes so a receipt outlives a rotation. */
export const trustedKeysOf = (doc: PlaneDocument): string[] => doc.keys.map((k) => k.publicKey);
export const activeKeysOf = (doc: PlaneDocument): string[] => doc.keys.filter((k) => k.status === 'active').map((k) => k.publicKey);

/** Builds a document, computing every kid from its key. */
export function planeDocument(input: { name: string; url?: string | null; keys: { publicKey: string; status: 'active' | 'retired' }[]; chains?: string[]; schemas?: string[]; generatedAt?: string }): PlaneDocument {
  return {
    version: 1,
    plane: { name: input.name, url: input.url ?? null },
    keys: input.keys.map((k) => ({ kid: keyFingerprint(k.publicKey), publicKey: k.publicKey, status: k.status })),
    chains: input.chains ?? [],
    schemas: input.schemas ?? [],
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}
