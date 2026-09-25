import { assertBytes, utf8 } from './bytes.js';
import { LIMITS } from './constants.js';

export interface InscriptionContent {
  /** MIME type, e.g. "image/webp" (tag 1). */
  contentType: string;
  /** Exact bytes inscribed. */
  body: Uint8Array;
  /** "<txid>i<index>" parent inscription id (tag 3). */
  parentId?: string;
  /** Optional CBOR metadata (tag 5, split into 520-byte chunks, one tag per chunk as ord does). */
  metadata?: Uint8Array;
}

// Opcodes
const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_CHECKSIG = 0xac;

/**
 * ord envelope tags (single-byte data pushes). The builder emits BODY, CONTENT_TYPE, PARENT and METADATA;
 * the rest are here so the parser (`parse.ts`) shares one source of tag numbers with the builder.
 */
export const TAG = Object.freeze({
  BODY: 0,
  CONTENT_TYPE: 1,
  POINTER: 2,
  PARENT: 3,
  METADATA: 5,
  METAPROTOCOL: 7,
  CONTENT_ENCODING: 9,
  DELEGATE: 11,
});

const CHUNK = LIMITS.MAX_SCRIPT_ELEMENT_SIZE;
const PROTOCOL_ID = utf8('ord');

/** Serialized size of a minimal data push of `n` bytes (OP_0 / direct / PUSHDATA1 / PUSHDATA2). */
export function pushSize(n: number): number {
  if (n === 0) return 1;
  if (n <= 75) return 1 + n;
  if (n <= 0xff) return 2 + n;
  if (n <= LIMITS.MAX_SCRIPT_ELEMENT_SIZE) return 3 + n;
  throw new Error(`push of ${n} bytes exceeds MAX_SCRIPT_ELEMENT_SIZE`);
}

function writePush(out: Uint8Array, o: number, data: Uint8Array): number {
  const n = data.length;
  if (n === 0) {
    out[o++] = OP_0;
    return o;
  }
  if (n <= 75) out[o++] = n;
  else if (n <= 0xff) {
    out[o++] = OP_PUSHDATA1;
    out[o++] = n;
  } else if (n <= LIMITS.MAX_SCRIPT_ELEMENT_SIZE) {
    out[o++] = OP_PUSHDATA2;
    out[o++] = n & 0xff;
    out[o++] = n >>> 8;
  } else throw new Error(`push of ${n} bytes exceeds MAX_SCRIPT_ELEMENT_SIZE`);
  out.set(data, o);
  return o + n;
}

function chunkSizes(len: number): number[] {
  const sizes: number[] = [];
  for (let off = 0; off < len; off += CHUNK) sizes.push(Math.min(CHUNK, len - off));
  return sizes;
}

/**
 * Parent inscription id in ord's on-chain encoding: 32-byte txid in internal (reversed) byte
 * order followed by the little-endian index with trailing zero bytes trimmed.
 */
export function encodeParentId(id: string): Uint8Array {
  const m = /^([0-9a-fA-F]{64})i(0|[1-9][0-9]*)$/.exec(id);
  if (!m) throw new Error(`invalid inscription id: ${id}`);
  const index = Number(m[2]);
  if (!Number.isSafeInteger(index) || index > 0xffffffff) throw new Error(`inscription index out of range: ${id}`);
  const bytes = new Uint8Array(36);
  const txid = m[1]!.toLowerCase();
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(txid.slice(62 - 2 * i, 64 - 2 * i), 16);
  bytes[32] = index & 0xff;
  bytes[33] = (index >>> 8) & 0xff;
  bytes[34] = (index >>> 16) & 0xff;
  bytes[35] = (index >>> 24) & 0xff;
  let end = 36;
  while (end > 32 && bytes[end - 1] === 0) end--;
  return bytes.slice(0, end);
}

interface Prepared {
  contentType: Uint8Array;
  parent: Uint8Array | undefined;
  metadata: Uint8Array | undefined;
  body: Uint8Array;
}

function prepare(content: InscriptionContent): Prepared {
  if (!content || typeof content !== 'object') throw new TypeError('content is required');
  if (typeof content.contentType !== 'string' || content.contentType.length === 0)
    throw new Error('content.contentType must be a non-empty string');
  const contentType = utf8(content.contentType);
  if (contentType.length > LIMITS.MAX_SCRIPT_ELEMENT_SIZE) throw new Error('content.contentType exceeds 520 bytes');
  assertBytes(content.body, undefined, 'content.body');
  let metadata: Uint8Array | undefined;
  if (content.metadata !== undefined) {
    assertBytes(content.metadata, undefined, 'content.metadata');
    if (content.metadata.length > 0) metadata = content.metadata;
  }
  const parent = content.parentId !== undefined ? encodeParentId(content.parentId) : undefined;
  return { contentType, parent, metadata, body: content.body };
}

function scriptLength(p: Prepared): number {
  let len = 33 /* push32 + key */ + 1 /* CHECKSIG */ + 1 /* OP_FALSE */ + 1 /* OP_IF */;
  len += pushSize(3); // "ord"
  len += pushSize(1) + pushSize(p.contentType.length);
  if (p.parent) len += pushSize(1) + pushSize(p.parent.length);
  if (p.metadata) for (const n of chunkSizes(p.metadata.length)) len += pushSize(1) + pushSize(n);
  len += 1; // OP_0 body tag
  for (const n of chunkSizes(p.body.length)) len += pushSize(n);
  len += 1; // OP_ENDIF
  return len;
}

/** Byte length of `buildInscriptionScript(pubkey, content)` without materialising it. */
export function inscriptionScriptLength(content: InscriptionContent): number {
  return scriptLength(prepare(content));
}

/**
 * Tapscript: `<xonly> OP_CHECKSIG OP_FALSE OP_IF "ord" 0x01 <ct> [0x03 <parent>] [0x05 <meta>]…
 * OP_0 <body ≤520>… OP_ENDIF`, byte-for-byte as ord emits it.
 */
export function buildInscriptionScript(revealPubkey: Uint8Array, content: InscriptionContent): Uint8Array {
  assertBytes(revealPubkey, 32, 'revealPubkey');
  const p = prepare(content);
  const out = new Uint8Array(scriptLength(p));
  let o = 0;
  o = writePush(out, o, revealPubkey);
  out[o++] = OP_CHECKSIG;
  out[o++] = OP_0; // OP_FALSE
  out[o++] = OP_IF;
  o = writePush(out, o, PROTOCOL_ID);
  o = writePush(out, o, Uint8Array.of(TAG.CONTENT_TYPE));
  o = writePush(out, o, p.contentType);
  if (p.parent) {
    o = writePush(out, o, Uint8Array.of(TAG.PARENT));
    o = writePush(out, o, p.parent);
  }
  if (p.metadata) {
    for (let off = 0; off < p.metadata.length; off += CHUNK) {
      o = writePush(out, o, Uint8Array.of(TAG.METADATA));
      o = writePush(out, o, p.metadata.subarray(off, off + CHUNK));
    }
  }
  out[o++] = OP_0; // body tag
  for (let off = 0; off < p.body.length; off += CHUNK) o = writePush(out, o, p.body.subarray(off, off + CHUNK));
  out[o++] = OP_ENDIF;
  if (o !== out.length) throw new Error('internal: script length mismatch');
  return out;
}

/** "<txid>i<index>" */
export function inscriptionIdFromReveal(revealTxid: string, index = 0): string {
  if (!/^[0-9a-fA-F]{64}$/.test(revealTxid)) throw new Error(`invalid txid: ${revealTxid}`);
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new Error(`invalid index: ${index}`);
  return `${revealTxid.toLowerCase()}i${index}`;
}
