import { describe, expect, it } from 'vitest';
import { HANDSHAKE_WELL_KNOWN, type HandshakePlaceholder, isHandshakePlaceholder } from '../src/handshake.ts';

describe('handshake placeholder', () => {
  it('carries only the format id and x- extensions, and says where it would live', () => {
    expect(HANDSHAKE_WELL_KNOWN).toBe('/.well-known/flashyos.json');
    const doc: HandshakePlaceholder = { flashyos: '1', 'x-note': 'unspecified upstream' };
    expect(isHandshakePlaceholder(doc)).toBe(true);
    expect(isHandshakePlaceholder({ flashyos: '1', roles: [] })).toBe(false);
    expect(isHandshakePlaceholder({ flashyos: '2' })).toBe(false);
    expect(isHandshakePlaceholder([])).toBe(false);
  });
});
