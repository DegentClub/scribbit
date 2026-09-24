/**
 * Content type detection: magic bytes first, then the file's extension, then what the browser said. The
 * type is committed to by the envelope and cannot be corrected later, so the user always sees it and can
 * override it.
 */

const EXTENSION_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', css: 'text/css', csv: 'text/csv',
  js: 'application/javascript', mjs: 'application/javascript', json: 'application/json', xml: 'application/xml',
  yaml: 'application/yaml', yml: 'application/yaml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4',
  webm: 'video/webm', wasm: 'application/wasm', zip: 'application/zip', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', stl: 'model/stl',
};

const MAGIC: Array<{ type: string; at?: number; bytes: number[] }> = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/webp', at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'application/wasm', bytes: [0x00, 0x61, 0x73, 0x6d] },
  { type: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { type: 'audio/flac', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { type: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { type: 'font/woff', bytes: [0x77, 0x4f, 0x46, 0x46] },
  { type: 'font/woff2', bytes: [0x77, 0x4f, 0x46, 0x32] },
  { type: 'model/gltf-binary', bytes: [0x67, 0x6c, 0x54, 0x46] },
];

function matches(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

export function sniffMime(bytes: Uint8Array): string | null {
  for (const m of MAGIC) if (matches(bytes, m.bytes, m.at)) return m.type;
  if (matches(bytes, [0x00, 0x00, 0x00]) && bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    return brand.startsWith('avif') ? 'image/avif' : 'video/mp4';
  }
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}

export function typeFromName(name: string): string | null {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_TYPES[ext] ?? null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function looksLikeText(bytes: Uint8Array): boolean {
  try {
    const s = utf8.decode(bytes.subarray(0, 4096));
    // eslint-disable-next-line no-control-regex
    return !/[\x00-\x08\x0e-\x1f]/.test(s);
  } catch {
    return false;
  }
}

/** Best guess, in priority order: magic bytes > extension > browser type > text sniff > octet-stream. */
export function guessContentType(bytes: Uint8Array, fileName: string, reportedType = ''): string {
  const sniffed = sniffMime(bytes);
  if (sniffed) return sniffed;
  const byName = typeFromName(fileName);
  if (byName) {
    if (byName === 'image/svg+xml' && !looksLikeText(bytes)) return 'application/octet-stream';
    return byName;
  }
  if (reportedType && reportedType !== 'application/octet-stream') return reportedType;
  if (looksLikeText(bytes)) return 'text/plain;charset=utf-8';
  return 'application/octet-stream';
}

export const CONTENT_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(;\s*[a-z0-9-]+=[^;]+)*$/i;
