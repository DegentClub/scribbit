/**
 * How a file's bytes become Counterparty's `description` parameter.
 *
 * Counterparty consensus classifies a MIME type as textual or binary and
 * stores the description accordingly (build reference v3 §5.1): textual
 * content goes across as UTF-8 text, binary as hex. This mirrors Core's
 * `classify_mime_type` for the CURRENT rules — every mint composed here is at
 * a height past the extended-MIME gate (block 952,800), so the pre-gate
 * variant is not reproduced. Ported from counters.fun `lib/inscribe/content.ts`.
 */

import { bytesToHex } from './bytes.js';

const TEXTUAL_APPLICATION_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/json',
  'application/manifest+json',
  'application/x-python-code',
  'application/x-sh',
  'application/x-csh',
  'application/x-tex',
  'application/x-latex',
  'application/postscript',
  'application/yaml',
  'application/x-yaml',
  'application/sql',
]);

/** Drop `; charset=…` and friends before matching. */
function stripParameters(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

export function classifyMimeType(mimeType: string): 'text' | 'binary' {
  const target = stripParameters(mimeType);
  if (target.startsWith('text/') || target.startsWith('message/') || target.endsWith('+xml') || target.endsWith('+json')) {
    return 'text';
  }
  return TEXTUAL_APPLICATION_MIME_TYPES.has(target) ? 'text' : 'binary';
}

const EXTENSION_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
  css: 'text/css', csv: 'text/csv', js: 'application/javascript',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml',
  yml: 'application/yaml', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  webm: 'video/webm', wasm: 'application/wasm', zip: 'application/zip',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};

/**
 * The MIME type to inscribe with, from a file name and the type the host
 * reported (`File.type` is routinely empty and sometimes wrong, so the
 * extension decides whenever it can). Framework-free: takes strings, not a `File`.
 */
export function guessContentType(fileName: string, reportedType = ''): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_TYPES[ext] || reportedType || 'application/octet-stream';
}

export interface EncodedContent {
  /** The `description` compose parameter: UTF-8 text or hex, by MIME class. */
  description: string;
  /** The `mime_type` compose parameter, exactly as given (Core validates it). */
  mime_type: string;
  kind: 'text' | 'binary';
}

/**
 * Encode content for the `description` compose parameter.
 *
 * A textual MIME type whose bytes are not valid UTF-8 is refused rather than
 * coerced: the replacement characters a lossy decode inserts would be
 * committed to the chain permanently.
 */
export function encodeContent(body: Uint8Array, mimeType: string): EncodedContent {
  if (!mimeType || stripParameters(mimeType) === '') throw new Error('a MIME type is required');
  const kind = classifyMimeType(mimeType);
  if (kind === 'binary') return { description: bytesToHex(body), mime_type: mimeType, kind };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error(
      `This file is being inscribed as ${mimeType}, a textual type, but its bytes are not valid UTF-8. ` +
        'Convert it, or give it a binary MIME type.',
    );
  }
  return { description: text, mime_type: mimeType, kind };
}

/** Bytes a description occupies on chain, from the API's string form. */
export function descriptionBytes(description: string | null | undefined, mimeType: string | null | undefined): number {
  if (!description) return 0;
  if (classifyMimeType(mimeType ?? 'text/plain') === 'text') return new TextEncoder().encode(description).length;
  return Math.floor(description.length / 2);
}
