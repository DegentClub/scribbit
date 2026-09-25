// The second factor for people (ours). FlashyOS lets an org OWNER or ADMIN, signed in with
// a member session, set envelopes and resolve decisions. We have API keys, not sessions,
// so a `wallet:delegate` key alone is not enough: the request must also carry
// `X-Approval`, an Ed25519 signature by an approver key the plane's configuration lists
// for the organisation, over the exact request:
//
//   canonical({ v: "plane-approval/1", method, path, bodySha256, apiKeyId, at })
//
//   X-Approval: kid=<sha256 of the approver's SPKI DER, hex>, at=<ISO time>, sig=<base64url>
//
// Bound to the method, path, body and the calling key, valid for 300 s around `at`, and
// single use (the signature is a nonce). A stolen API key cannot change an envelope; a
// stolen approval cannot be replayed or moved to another request.
import { sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { asPrivateKey, canonicalBytes, fromBase64Url, isEd25519PublicKey, keyFingerprint, publicKeyOf, sha256Hex, toBase64Url } from '@bsh/mesh';
import type { NonceStore } from './store/types.ts';

export const APPROVAL_HEADER = 'X-Approval';
export const APPROVAL_VERSION = 'plane-approval/1';
export const APPROVAL_WINDOW_MS = 300_000;

export interface Approver {
  org: string;
  /** A person's name, recorded on what they approve. */
  name: string;
  /** SPKI PEM. */
  publicKey: string;
  kid: string;
}

export interface ApprovalRequest {
  method: string;
  path: string;
  /** The raw request body ('' for none). */
  body: string;
  apiKeyId: string;
  at: string;
}

export function approvalMessage(r: ApprovalRequest): Buffer {
  return canonicalBytes({ v: APPROVAL_VERSION, method: r.method.toUpperCase(), path: r.path, bodySha256: sha256Hex(r.body), apiKeyId: r.apiKeyId, at: r.at });
}

/** The X-Approval header value for a request, signed with the approver's private key. */
export function signApproval(privateKey: string | KeyObject, r: Omit<ApprovalRequest, 'at'> & { at?: string }): string {
  const key = asPrivateKey(privateKey);
  const at = r.at ?? new Date().toISOString();
  const sig = toBase64Url(edSign(null, approvalMessage({ ...r, at }), key));
  return `kid=${keyFingerprint(publicKeyOf(key))}, at=${at}, sig=${sig}`;
}

export function parseApprovalHeader(value: string | undefined): { kid: string; at: string; sig: string } | undefined {
  if (!value || value.length > 512) return undefined;
  const parts = new Map<string, string>();
  for (const piece of value.split(',')) {
    const m = /^\s*(kid|at|sig)=(\S+)\s*$/.exec(piece);
    if (!m) return undefined;
    if (parts.has(m[1]!)) return undefined;
    parts.set(m[1]!, m[2]!);
  }
  const kid = parts.get('kid');
  const at = parts.get('at');
  const sig = parts.get('sig');
  if (!kid || !/^[0-9a-f]{64}$/.test(kid) || !at || Number.isNaN(Date.parse(at)) || !sig) return undefined;
  return { kid, at, sig };
}

export type ApprovalCheck = { ok: true; approver: Approver } | { ok: false; code: 'approval_required' | 'approval_invalid'; detail: string };

export interface VerifyApprovalContext extends Omit<ApprovalRequest, 'at'> {
  org: string;
  approvers: readonly Approver[];
  now: Date;
  nonces: NonceStore;
}

/** Checks an X-Approval header against the request it came with. Consumes it on success. */
export async function verifyApproval(header: string | undefined, ctx: VerifyApprovalContext): Promise<ApprovalCheck> {
  if (!header) return { ok: false, code: 'approval_required', detail: `${APPROVAL_HEADER} is required: a person listed as an approver for ${ctx.org} signs this request` };
  const parsed = parseApprovalHeader(header);
  if (!parsed) return { ok: false, code: 'approval_invalid', detail: `${APPROVAL_HEADER} must be "kid=<hex64>, at=<ISO time>, sig=<base64url>"` };
  const approver = ctx.approvers.find((a) => a.org === ctx.org && a.kid === parsed.kid);
  if (!approver) return { ok: false, code: 'approval_invalid', detail: `key ${parsed.kid.slice(0, 12)}… is not an approver for ${ctx.org}` };
  const skew = Math.abs(ctx.now.getTime() - Date.parse(parsed.at));
  if (skew > APPROVAL_WINDOW_MS) return { ok: false, code: 'approval_invalid', detail: `the approval was signed at ${parsed.at}, outside the ${APPROVAL_WINDOW_MS / 1000} s window` };
  let valid = false;
  try {
    valid = edVerify(null, approvalMessage({ method: ctx.method, path: ctx.path, body: ctx.body, apiKeyId: ctx.apiKeyId, at: parsed.at }), createPublicKey(approver.publicKey), fromBase64Url(parsed.sig));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'approval_invalid', detail: 'the signature does not cover this request (method, path, body and API key) under the approver key' };
  const expires = new Date(Date.parse(parsed.at) + APPROVAL_WINDOW_MS).toISOString();
  if (!(await ctx.nonces.consume(`approval:${parsed.sig}`, expires))) return { ok: false, code: 'approval_invalid', detail: 'this approval was already used' };
  return { ok: true, approver };
}

/** Parses the approvers configuration: `[{ org, name, publicKey }]`. Throws with the entry named. */
export function parseApprovers(raw: unknown): Approver[] {
  if (!Array.isArray(raw)) throw new Error('approvers: expected a JSON array of { org, name, publicKey }');
  const seen = new Set<string>();
  return raw.map((a, i) => {
    const o = a as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.org !== 'string' || !o.org || typeof o.name !== 'string' || !o.name) throw new Error(`approvers[${i}]: needs org and name`);
    if (!isEd25519PublicKey(o.publicKey)) throw new Error(`approvers[${i}] (${o.name}): publicKey must be an Ed25519 SPKI PEM`);
    const kid = keyFingerprint(o.publicKey);
    if (seen.has(`${o.org}|${kid}`)) throw new Error(`approvers[${i}] (${o.name}): key listed twice for ${o.org}`);
    seen.add(`${o.org}|${kid}`);
    return { org: o.org, name: o.name, publicKey: o.publicKey, kid };
  });
}
