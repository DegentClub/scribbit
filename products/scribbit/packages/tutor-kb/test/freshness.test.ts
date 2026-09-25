import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndexFromDisk, loadIndex, type KbIndex } from '../src/index.js';

const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../data/index.json', import.meta.url)), 'utf8')) as KbIndex;

describe('index freshness', () => {
  it('the committed data/index.json equals buildIndexFromDisk() (run `pnpm --filter @bsh/blockspace-tutor-kb refresh`)', () => {
    expect(committed).toEqual(buildIndexFromDisk());
  });

  it('loadIndex() returns the committed index', () => {
    expect(loadIndex()).toEqual(committed);
  });
});

describe('index integrity', () => {
  const index = loadIndex();

  it('covers every source family', () => {
    const types = new Set(index.chunks.map((c) => c.source.type));
    expect([...types].sort()).toEqual(['academy', 'adr', 'bip', 'glossary', 'spec']);
  });

  it('has ~60 glossary terms and the four authored BIP/ordinals summaries', () => {
    expect(index.chunks.filter((c) => c.source.type === 'glossary').length).toBeGreaterThanOrEqual(60);
    const bipIds = index.chunks.filter((c) => c.source.type === 'bip').map((c) => c.id).sort();
    expect(bipIds).toEqual(['bip:bip340', 'bip:bip341', 'bip:bip342', 'bip:ordinals-envelope']);
  });

  it('every chunk has a unique id, non-empty text/title and a public url', () => {
    const ids = new Set<string>();
    for (const c of index.chunks) {
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.text.length).toBeGreaterThan(10);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.source.url).toMatch(/^https?:\/\//);
      expect(c.source.url).not.toMatch(/\.pve\b|\.hs\.skrybit\.dev\b|10\.40\./);
    }
  });

  it('is sorted by id (stable diffs)', () => {
    const ids = index.chunks.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('authored chunks (bip/adr) are flagged, primary excerpts are not', () => {
    for (const c of index.chunks) {
      if (c.source.type === 'bip' || c.source.type === 'adr') expect(c.source.authored).toBe(true);
      if (c.source.type === 'glossary' || c.source.type === 'spec') expect(c.source.authored).toBeUndefined();
    }
  });
});
