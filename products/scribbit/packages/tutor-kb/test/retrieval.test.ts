import { describe, expect, it } from 'vitest';
import { loadIndex, Retriever, tokenize } from '../src/index.js';

const retriever = new Retriever(loadIndex());

/** Fixed query set with the source the top hit MUST be, and ids that MUST appear in the top-k. */
const QUERY_SET: Array<{ q: string; top?: string; within?: string[]; k?: number }> = [
  { q: 'what is the witness discount', top: 'glossary:witness-discount' },
  { q: 'what is the dust limit for a taproot output', top: 'glossary:dust-limit' },
  { q: 'how does replace by fee work', top: 'glossary:rbf' },
  { q: 'schnorr signatures on secp256k1', top: 'bip:bip340' },
  { q: 'sign in with bitcoin message format', top: 'spec:bss-0006' },
  { q: 'ordinals inscription envelope tapscript', top: 'bip:ordinals-envelope' },
  { q: 'parent child inscription provenance', within: ['glossary:parent-child-provenance', 'academy:parents-and-provenance'], k: 3 },
  { q: 'how is a fee rate calculated', within: ['glossary:fee-rate'], k: 3 },
  { q: 'what is a weight unit', within: ['glossary:weight-unit'], k: 3 },
  { q: 'what is a taproot output', within: ['glossary:taproot', 'bip:bip341'], k: 3 },
  { q: 'explain the commit and reveal flow', within: ['glossary:commit-reveal', 'academy:commit-and-reveal'], k: 3 },
];

describe('retrieval quality (fixed query set)', () => {
  for (const { q, top, within, k } of QUERY_SET) {
    it(`ranks "${q}" as expected`, () => {
      const hits = retriever.search(q, k ?? 5);
      expect(hits.length, `no hits for "${q}"`).toBeGreaterThan(0);
      if (top) expect(hits[0]!.chunk.id, `top hit for "${q}"`).toBe(top);
      if (within) {
        const ids = hits.map((h) => h.chunk.id);
        for (const id of within) expect(ids, `"${q}" top-${k ?? 5}`).toContain(id);
      }
      // scores must be descending
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    });
  }

  it('returns nothing for gibberish (drives weak-retrieval humility)', () => {
    expect(retriever.search('purple monkey dishwasher xyzzy qwerty', 5)).toEqual([]);
  });

  it('is deterministic across calls', () => {
    const a = retriever.search('what is blockspace', 5).map((h) => [h.chunk.id, h.score]);
    const b = retriever.search('what is blockspace', 5).map((h) => [h.chunk.id, h.score]);
    expect(a).toEqual(b);
  });

  it('tokenises with stopword removal and light stemming', () => {
    expect(tokenize('What are the inscriptions?')).toEqual(['inscription']);
    expect(tokenize('signatures and witnesses')).toEqual(['signature', 'witness']);
  });
});
