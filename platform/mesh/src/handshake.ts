// flashyos/1 (the handshake at /.well-known/flashyos.json) and countersign/1.
//
// NOT SPECIFIED in the material this package was built from. The FlashyLabs
// repositories we read name the handshake (directory.mjs lists `flashyos/1` as a
// surface served at /.well-known/flashyos.json; frontdoor rung 2 says "A handshake at
// /.well-known/flashyos.json and a directory fragment") but no checker, emitter,
// schema or example of its contents was published there, and countersign/1 is only
// ever named. We do NOT invent either. What is here is a typed placeholder that
// carries the one field that is certain - the format id - plus explicit `x-`
// extensions, so a product repo can compile against the name today and swap in the
// real shape when FlashyOS publishes it. See README "Open questions".

export const HANDSHAKE_WELL_KNOWN = '/.well-known/flashyos.json';

/** Placeholder. Only `flashyos: '1'` is known; everything else must be an x- extension until the format is published. */
export interface HandshakePlaceholder {
  flashyos: '1';
  [extension: `x-${string}`]: unknown;
}

/** Placeholder for countersign/1: named in the FlashyOS material, never specified. */
export interface CountersignPlaceholder {
  countersign: '1';
  [extension: `x-${string}`]: unknown;
}

/** True only for the placeholder shape: a JSON object declaring `flashyos: "1"` with no bare (non x-) keys beside it. */
export function isHandshakePlaceholder(doc: unknown): doc is HandshakePlaceholder {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const d = doc as Record<string, unknown>;
  return d.flashyos === '1' && Object.keys(d).every((k) => k === 'flashyos' || k.startsWith('x-'));
}
