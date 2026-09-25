/**
 * Ordinals envelope PARSER — the inverse of `buildInscriptionScript` (see `envelope.ts`).
 *
 * Decodes the `OP_FALSE OP_IF "ord" <tag> <value>… OP_0 <body>… OP_ENDIF` inscription envelope from a
 * taproot script-path leaf (or a raw witness stack) into typed fields and body bytes, following ord's
 * reading rules:
 *   - pushes alternate tag/value until an empty push in tag position starts the body;
 *   - OP_1..OP_16 and OP_1NEGATE inside the envelope count as one-byte numeric pushes (and are
 *     reported as the `pushnum` cursed flag);
 *   - any other opcode inside the `OP_IF … OP_ENDIF` means "not an envelope";
 *   - a single script may carry several inscriptions, decoded in order.
 *
 * This is the canonical implementation that block.space's `@bsh/blockspace-xray` anatomy decoder builds
 * on (ADR-0015); it supersedes xray's private copy. Where xray adds display concerns (base64/text
 * previews, sha256, absolute tx offsets), this returns the raw decoded bytes a library consumer wants.
 */
import { hex } from '@scure/base';
import { concatBytes } from './bytes.js';
import { TAG } from './envelope.js';

/** ord field tags (the tag push is the single byte shown), by number → ord's name. */
export const ENVELOPE_TAGS: Readonly<Record<number, string>> = Object.freeze({
  1: 'content_type',
  2: 'pointer',
  3: 'parent',
  5: 'metadata',
  7: 'metaprotocol',
  9: 'content_encoding',
  11: 'delegate',
  13: 'rune',
  15: 'note',
  17: 'properties',
  19: 'property_encoding',
});

/** ord's cursed / unusual markers. Reported, never judged — the caller decides what to do with them. */
export interface EnvelopeFlags {
  /** An OP_1..OP_16 or OP_1NEGATE numeric push appeared inside the envelope. */
  pushnum: boolean;
  /** A non-repeatable tag (anything but parent, metadata or properties) appeared more than once. */
  duplicateField: boolean;
  /** A tag push had no value push following it before the body / OP_ENDIF. */
  incompleteField: boolean;
  /** A tag not in the known set whose first byte is even was present (ord must not silently ignore it). */
  unrecognizedEvenField: boolean;
}

/** One tag/value field before the body, preserving unknown tags and repeats in on-chain order. */
export interface ParsedField {
  /** Tag number when the tag push is a single byte, else null. */
  tag: number | null;
  /** ord's name for the tag, or 'unknown'. */
  name: string;
  /** The raw value bytes. */
  value: Uint8Array;
  /** Byte offset of the value bytes within the script (or the tx when `base` was given). */
  offset: number;
}

/** A single decoded inscription. The inverse of `InscriptionContent` fed to `buildInscriptionScript`. */
export interface ParsedInscription {
  /** Decoded MIME type (tag 1), when present and valid UTF-8. */
  contentType?: string;
  /** Body bytes: every body chunk concatenated. Empty when the body tag is present but carries no chunks. */
  body: Uint8Array;
  /** Whether a body tag (an empty push in tag position) was present at all. */
  hasBody: boolean;
  /** Individual body chunk pushes with their offsets, for consumers that need chunk boundaries. */
  bodyChunks: { value: Uint8Array; offset: number }[];
  /** Every parent inscription id (tag 3), decoded, in order. */
  parents: string[];
  /** CBOR metadata (all tag-5 chunks concatenated), when present. */
  metadata?: Uint8Array;
  /** Pointer (tag 2) as a little-endian integer, when present and in the safe-integer range. */
  pointer?: number;
  /** Metaprotocol (tag 7), when present and valid UTF-8. */
  metaprotocol?: string;
  /** Content encoding (tag 9), e.g. 'br', when present and valid UTF-8. */
  contentEncoding?: string;
  /** Delegate inscription id (tag 11), when present and decodable. */
  delegate?: string;
  /** Every tag/value field before the body, in order (including unknown and repeated tags). */
  fields: ParsedField[];
  /** ord's cursed / unusual markers. */
  flags: EnvelopeFlags;
  /** Byte offset of the envelope (its OP_FALSE) within the script, or the tx when `base` was given. */
  offset: number;
  /** Byte length of the envelope, from OP_FALSE through OP_ENDIF inclusive. */
  length: number;
}

export interface ParseOptions {
  /** Offset of the script within a larger buffer (e.g. the transaction); added to every reported offset. */
  base?: number;
}

const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_1NEGATE = 0x4f;
const PROTOCOL_ID = [0x6f, 0x72, 0x64]; // "ord"

const KNOWN_TAGS = new Set(Object.keys(ENVELOPE_TAGS).map(Number));
/** Tags ord permits to repeat (arrays / chunked values): parent (3), metadata (5), properties (17). */
const REPEATABLE_TAG_HEX = new Set(['03', '05', '11']);

const utf8Decode = (b: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
};

/** Little-endian integer, or undefined when it overflows 8 bytes / a JS safe integer (ord's `Tag::value`). */
function leInt(value: Uint8Array): number | undefined {
  if (value.length > 8 && value.subarray(8).some((b) => b !== 0)) return undefined;
  let n = 0n;
  for (let k = Math.min(8, value.length) - 1; k >= 0; k--) n = n * 256n + BigInt(value[k]!);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : undefined;
}

/**
 * Inscription id from ord's on-chain encoding: 32-byte txid in internal (reversed) order followed by the
 * little-endian output index with trailing zero bytes trimmed. The inverse of `encodeParentId`. Returns
 * undefined for lengths ord rejects (< 32 or > 36 bytes).
 */
export function decodeInscriptionId(value: Uint8Array): string | undefined {
  if (value.length < 32 || value.length > 36) return undefined;
  const txid = hex.encode(Uint8Array.from(value.subarray(0, 32)).reverse());
  let index = 0;
  for (let k = value.length - 1; k >= 32; k--) index = index * 256 + value[k]!;
  return `${txid}i${index}`;
}

interface Op {
  opcode: number;
  offset: number;
  data?: Uint8Array;
  dataOffset?: number;
}

/** Split a script into opcodes and data pushes with offsets. Stops cleanly at a push that runs past the end. */
function decodeOps(script: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  while (i < script.length) {
    const offset = i;
    const opcode = script[i++]!;
    let len = -1;
    if (opcode <= 0x4b) len = opcode;
    else if (opcode === 0x4c) {
      if (i + 1 > script.length) return ops;
      len = script[i]!;
      i += 1;
    } else if (opcode === 0x4d) {
      if (i + 2 > script.length) return ops;
      len = script[i]! | (script[i + 1]! << 8);
      i += 2;
    } else if (opcode === 0x4e) {
      if (i + 4 > script.length) return ops;
      len = (script[i]! | (script[i + 1]! << 8) | (script[i + 2]! << 16) | (script[i + 3]! << 24)) >>> 0;
      i += 4;
    }
    if (len >= 0) {
      if (i + len > script.length) return ops;
      ops.push({ opcode, offset, data: script.subarray(i, i + len), dataOffset: i });
      i += len;
    } else ops.push({ opcode, offset });
  }
  return ops;
}

interface RawEnvelope {
  offset: number;
  length: number;
  pushes: { bytes: Uint8Array; offset: number }[];
  pushnum: boolean;
}

/** Find every `OP_FALSE OP_IF "ord" … OP_ENDIF` envelope in a script. `base` shifts reported offsets. */
function findRawEnvelopes(script: Uint8Array, base: number): RawEnvelope[] {
  const ops = decodeOps(script);
  const out: RawEnvelope[] = [];
  for (let i = 0; i + 2 < ops.length; i++) {
    const a = ops[i]!;
    if (!(a.data !== undefined && a.data.length === 0)) continue; // OP_FALSE / empty push
    if (ops[i + 1]!.opcode !== OP_IF) continue;
    const p = ops[i + 2]!;
    if (!p.data || p.data.length !== 3 || p.data[0] !== PROTOCOL_ID[0] || p.data[1] !== PROTOCOL_ID[1] || p.data[2] !== PROTOCOL_ID[2]) continue;
    const pushes: RawEnvelope['pushes'] = [];
    let pushnum = false;
    let end = -1;
    let j = i + 3;
    for (; j < ops.length; j++) {
      const op = ops[j]!;
      if (op.data !== undefined) pushes.push({ bytes: op.data, offset: base + op.dataOffset! });
      else if (op.opcode === OP_ENDIF) {
        end = op.offset + 1;
        break;
      } else if (op.opcode === OP_1NEGATE) {
        pushnum = true;
        pushes.push({ bytes: Uint8Array.of(0x81), offset: base + op.offset });
      } else if (op.opcode >= 0x51 && op.opcode <= 0x60) {
        pushnum = true;
        pushes.push({ bytes: Uint8Array.of(op.opcode - 0x50), offset: base + op.offset });
      } else break; // any other opcode: not an envelope
    }
    if (end < 0) continue;
    out.push({ offset: base + a.offset, length: end - a.offset, pushes, pushnum });
    i = j;
  }
  return out;
}

/** Decode one raw envelope's pushes into fields and body, as ord would read them. */
function decodeRawEnvelope(raw: RawEnvelope): ParsedInscription {
  const pushes = raw.pushes;
  const bodyAt = pushes.findIndex((p, i) => i % 2 === 0 && p.bytes.length === 0);
  const head = bodyAt < 0 ? pushes : pushes.slice(0, bodyAt);

  const fields: ParsedField[] = [];
  const seen = new Map<string, number>();
  let incompleteField = false;
  let unrecognizedEvenField = false;
  for (let i = 0; i < head.length; i += 2) {
    const key = head[i]!;
    const val = head[i + 1];
    if (!val) {
      incompleteField = true;
      break;
    }
    const tag = key.bytes.length === 1 ? key.bytes[0]! : null;
    const name = tag !== null ? (ENVELOPE_TAGS[tag] ?? 'unknown') : 'unknown';
    const keyHex = hex.encode(key.bytes);
    // ord: a field whose tag is unknown and whose first tag byte is even must not be silently ignored.
    if (!(tag !== null && KNOWN_TAGS.has(tag)) && (key.bytes[0] ?? 0) % 2 === 0) unrecognizedEvenField = true;
    seen.set(keyHex, (seen.get(keyHex) ?? 0) + 1);
    fields.push({ tag, name, value: val.bytes, offset: val.offset });
  }
  const duplicateField = [...seen.entries()].some(([k, n]) => n > 1 && !REPEATABLE_TAG_HEX.has(k));

  const first = (tag: number) => fields.find((f) => f.tag === tag)?.value;
  const env: ParsedInscription = {
    body: new Uint8Array(0),
    hasBody: false,
    bodyChunks: [],
    parents: fields
      .filter((f) => f.tag === TAG.PARENT)
      .map((f) => decodeInscriptionId(f.value))
      .filter((id): id is string => id !== undefined),
    fields,
    flags: { pushnum: raw.pushnum, duplicateField, incompleteField, unrecognizedEvenField },
    offset: raw.offset,
    length: raw.length,
  };

  const ct = first(TAG.CONTENT_TYPE);
  if (ct !== undefined) {
    const s = utf8Decode(ct);
    if (s !== undefined) env.contentType = s;
  }
  const ce = first(TAG.CONTENT_ENCODING);
  if (ce !== undefined) {
    const s = utf8Decode(ce);
    if (s !== undefined) env.contentEncoding = s;
  }
  const mp = first(TAG.METAPROTOCOL);
  if (mp !== undefined) {
    const s = utf8Decode(mp);
    if (s !== undefined) env.metaprotocol = s;
  }
  const ptr = first(TAG.POINTER);
  if (ptr !== undefined) {
    const n = leInt(ptr);
    if (n !== undefined) env.pointer = n;
  }
  const dg = first(TAG.DELEGATE);
  if (dg !== undefined) {
    const id = decodeInscriptionId(dg);
    if (id !== undefined) env.delegate = id;
  }

  const metaChunks = fields.filter((f) => f.tag === TAG.METADATA).map((f) => f.value);
  if (metaChunks.length) env.metadata = concatBytes(...metaChunks);

  if (bodyAt >= 0) {
    env.hasBody = true;
    const chunks = pushes.slice(bodyAt + 1);
    env.bodyChunks = chunks.map((c) => ({ value: c.bytes, offset: c.offset }));
    env.body = concatBytes(...chunks.map((c) => c.bytes));
  }
  return env;
}

/** The tapscript leaf ord reads: the second-to-last witness element, with the annex removed. */
function tapscriptFromWitness(stack: Uint8Array[]): Uint8Array | undefined {
  let items = stack;
  const last = items[items.length - 1];
  if (items.length >= 2 && last && last.length > 0 && last[0] === 0x50) items = items.slice(0, -1); // annex
  if (items.length < 2) return undefined; // need at least <script> <control-block>
  return items[items.length - 2];
}

function toScript(input: Uint8Array | Uint8Array[]): Uint8Array | undefined {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) {
    if (!input.every((x) => x instanceof Uint8Array)) throw new TypeError('witness stack must be an array of Uint8Array');
    return tapscriptFromWitness(input);
  }
  throw new TypeError('parseEnvelope expects a script (Uint8Array) or a witness stack (Uint8Array[])');
}

/**
 * Parse every ordinals inscription in a tapscript leaf or witness stack, in on-chain order.
 *
 * @param input a script (`Uint8Array`), or a full taproot witness stack (`Uint8Array[]`) whose tapscript
 *   leaf is selected automatically (annex removed).
 */
export function parseEnvelopes(input: Uint8Array | Uint8Array[], opts: ParseOptions = {}): ParsedInscription[] {
  const script = toScript(input);
  if (!script) return [];
  return findRawEnvelopes(script, opts.base ?? 0).map(decodeRawEnvelope);
}

/**
 * Parse the first ordinals inscription in a tapscript leaf or witness stack, the inverse of
 * `buildInscriptionScript`: `parseEnvelope(buildInscriptionScript(pubkey, content))` recovers `content`.
 * Returns undefined when the input carries no envelope. Use `parseEnvelopes` for multi-inscription reveals.
 */
export function parseEnvelope(input: Uint8Array | Uint8Array[], opts: ParseOptions = {}): ParsedInscription | undefined {
  return parseEnvelopes(input, opts)[0];
}
