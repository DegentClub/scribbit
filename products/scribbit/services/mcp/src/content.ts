/**
 * Input decoding shared by the tools: base64 with size limits checked BEFORE decoding, content-type and
 * parent-id validation, and the `contentBase64 | contentLength` duality (exact bytes vs. size-only).
 * Everything here is pure and throws `ToolError` only.
 */
import { addressToScript, encodeParentId, sha256Hex, type InscriptionContent, type Network } from '@bsh/inscription';
import { invalid, ToolError } from './errors.js';
import {
  MAX_CONTENT_BASE64_CHARS,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_TYPE_BYTES,
  MAX_METADATA_BASE64_CHARS,
  MAX_METADATA_BYTES,
  MAX_PSBT_BASE64_CHARS,
} from './limits.js';

export const NETWORKS: readonly Network[] = Object.freeze(['mainnet', 'testnet', 'signet', 'regtest']);
export const isNetwork = (s: unknown): s is Network => typeof s === 'string' && (NETWORKS as readonly string[]).includes(s);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode base64 into bytes, refusing anything over `maxBytes` before allocating. */
export function decodeBase64(value: string, field: string, maxBytes: number, maxChars: number): Uint8Array {
  const s = value.replace(/\s+/g, '');
  if (s.length > maxChars)
    throw new ToolError('content_too_large', `${field} decodes to more than ${maxBytes} bytes`, { field, maxBytes, base64Chars: s.length });
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) throw invalid(`${field} is not valid base64`, { field });
  const bytes = new Uint8Array(Buffer.from(s, 'base64'));
  if (bytes.length > maxBytes)
    throw new ToolError('content_too_large', `${field} decodes to ${bytes.length} bytes; the limit is ${maxBytes}`, { field, maxBytes, bytes: bytes.length });
  return bytes;
}

export const decodeContentBase64 = (v: string) => decodeBase64(v, 'contentBase64', MAX_CONTENT_BYTES, MAX_CONTENT_BASE64_CHARS);
export const decodeMetadataBase64 = (v: string) => decodeBase64(v, 'metadataBase64', MAX_METADATA_BYTES, MAX_METADATA_BASE64_CHARS);

export function normalizePsbtBase64(value: string): string {
  const s = value.replace(/\s+/g, '');
  if (!s) throw invalid('halfSignedPsbtBase64 is empty');
  if (s.length > MAX_PSBT_BASE64_CHARS) throw new ToolError('content_too_large', 'halfSignedPsbtBase64 is too large', { maxChars: MAX_PSBT_BASE64_CHARS });
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) throw invalid('halfSignedPsbtBase64 is not valid base64');
  return s;
}

export function validateContentType(contentType: string): string {
  const ct = contentType.trim();
  if (!ct) throw invalid('contentType must not be empty');
  const bytes = new TextEncoder().encode(ct).length;
  if (bytes > MAX_CONTENT_TYPE_BYTES) throw invalid(`contentType is ${bytes} bytes; the envelope allows at most ${MAX_CONTENT_TYPE_BYTES}`, { bytes });
  if (/[^\x20-\x7e]/.test(ct)) throw invalid('contentType must be printable ASCII');
  return ct;
}

export function validateParentId(parentId: string): string {
  const id = parentId.trim();
  try {
    encodeParentId(id);
  } catch (e) {
    throw invalid(`invalid parentId "${id}": ${(e as Error).message}`, { field: 'parentId' });
  }
  return id;
}

export function parseNetwork(v: string | undefined, fallback: Network = 'mainnet'): Network {
  if (v === undefined) return fallback;
  if (!isNetwork(v)) throw new ToolError('unsupported_network', `unknown network "${v}"`, { supported: NETWORKS });
  return v;
}

export function parseXOnlyPubkey(v: string): Uint8Array {
  let h = v.trim().toLowerCase();
  if (/^0[23][0-9a-f]{64}$/.test(h)) h = h.slice(2); // compressed key: use its x coordinate
  if (!/^[0-9a-f]{64}$/.test(h)) throw invalid('revealPubkey must be a 32-byte x-only public key (64 hex chars)', { field: 'revealPubkey' });
  return fromHex(h);
}

export function parseSha256(v: string): string {
  const h = v.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw invalid('contentSha256 must be 64 hex chars', { field: 'contentSha256' });
  return h;
}

export interface ContentInput {
  contentType: string;
  contentBase64?: string | undefined;
  contentLength?: number | undefined;
  contentSha256?: string | undefined;
  parentId?: string | undefined;
  metadataBase64?: string | undefined;
}

export interface ResolvedContent {
  content: InscriptionContent;
  /** True when the caller supplied the exact bytes; false when only a length was given (size-only maths). */
  exact: boolean;
  contentSha256: string | null;
}

/**
 * Build an `InscriptionContent` from tool input. Exactly one of `contentBase64` / `contentLength` is required
 * unless `requireExact`; when both (or a `contentSha256`) are present they must agree, so a transcription
 * error between an agent's steps is caught here rather than on chain.
 */
export function resolveContent(input: ContentInput, opts: { requireExact?: boolean } = {}): ResolvedContent {
  const contentType = validateContentType(input.contentType);
  const hasBytes = input.contentBase64 !== undefined;
  const hasLength = input.contentLength !== undefined;
  if (!hasBytes && !hasLength) throw invalid('provide contentBase64 (exact bytes) or contentLength (size-only)');
  if (opts.requireExact && !hasBytes) throw invalid('contentBase64 is required: this result commits to the exact bytes, not just their length');

  let body: Uint8Array;
  if (hasBytes) {
    body = decodeContentBase64(input.contentBase64!);
    if (hasLength && input.contentLength !== body.length)
      throw new ToolError('content_hash_mismatch', `contentLength ${input.contentLength} does not match the ${body.length} decoded bytes`, {
        contentLength: input.contentLength,
        decodedBytes: body.length,
      });
  } else {
    const n = input.contentLength!;
    if (!Number.isInteger(n) || n < 0) throw invalid('contentLength must be a non-negative integer');
    if (n > MAX_CONTENT_BYTES) throw new ToolError('content_too_large', `contentLength ${n} exceeds the ${MAX_CONTENT_BYTES}-byte limit`, { maxBytes: MAX_CONTENT_BYTES });
    body = new Uint8Array(n);
  }

  let contentSha256: string | null = null;
  if (hasBytes) {
    contentSha256 = sha256Hex(body);
    if (input.contentSha256 !== undefined) {
      const expected = parseSha256(input.contentSha256);
      if (expected !== contentSha256)
        throw new ToolError('content_hash_mismatch', 'contentSha256 does not match the decoded contentBase64', { expected, actual: contentSha256 });
    }
  } else if (input.contentSha256 !== undefined) {
    parseSha256(input.contentSha256); // syntactically valid, but nothing to compare against
  }

  const content: InscriptionContent = { contentType, body };
  if (input.parentId !== undefined) content.parentId = validateParentId(input.parentId);
  if (input.metadataBase64 !== undefined) content.metadata = decodeMetadataBase64(input.metadataBase64);
  return { content, exact: hasBytes, contentSha256 };
}

/** P2TR scriptPubKey with a zero key: the reveal weight depends only on the script length. */
export const PLACEHOLDER_P2TR = Uint8Array.from([0x51, 0x20, ...new Uint8Array(32)]);

export function recipientScriptFor(address: string | undefined, network: Network): { script: Uint8Array; kind: string } {
  if (address === undefined) return { script: PLACEHOLDER_P2TR, kind: 'p2tr (assumed)' };
  try {
    const script = addressToScript(address.trim(), network);
    return { script, kind: scriptKind(script) };
  } catch (e) {
    throw invalid(`invalid recipientAddress for ${network}: ${(e as Error).message}`, { field: 'recipientAddress' });
  }
}

export function scriptKind(s: Uint8Array): string {
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return 'p2tr';
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return 'p2wpkh';
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) return 'p2wsh';
  if (s.length === 23 && s[0] === 0xa9) return 'p2sh';
  if (s.length === 25 && s[0] === 0x76) return 'p2pkh';
  return 'other';
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw invalid('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
