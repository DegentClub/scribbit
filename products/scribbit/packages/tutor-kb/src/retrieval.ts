/**
 * Dependency-light lexical retrieval over the KB: a BM25 ranker with a light title/tag boost. No embeddings,
 * no model, no network — the ranking is deterministic and inspectable, which is why it can be unit-tested
 * against a fixed query set with expected top-k. Corpus is tiny (hundreds of chunks) so a full scan per query
 * is fine.
 */
import type { Chunk, KbIndex, SearchHit } from './types.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** Extra weight for a query term occurring in the title or tags (fields a searcher usually means). */
const TITLE_BOOST = 2.5;
const TAG_BOOST = 1.6;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'but',
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'i', 'you', 'it', 'this', 'that', 'these', 'those', 'my', 'me', 'we', 'us', 'about', 'with', 'as', 'at', 'by',
  'from', 'into', 'if', 'then', 'so', 'up', 'out', 'not', 'no', 'yes', 'get', 'got', 'tell', 'explain', 'please',
]);

/** Tokenise: lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens, light plural stemming. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * Very light plural stemming, tuned so a singular and its plural map to the SAME token (query "signatures"
 * must match a doc's "signature"): `policies`→`policy`, `witnesses`/`boxes`→`witness`/`box`, else drop a
 * trailing plural `s`. Words ending in `ss`, `us`, `is` are left alone.
 */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

interface Doc {
  chunk: Chunk;
  /** term -> count in body */
  tf: Map<string, number>;
  len: number;
  titleTerms: Set<string>;
  tagTerms: Set<string>;
}

/** A prepared, reusable searcher. Build once at load, query many times. */
export class Retriever {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;
  private readonly n: number;

  constructor(index: KbIndex) {
    this.docs = index.chunks.map((chunk) => {
      const terms = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return {
        chunk,
        tf,
        len: terms.length,
        titleTerms: new Set(tokenize(chunk.title)),
        tagTerms: new Set(chunk.tags.flatMap((tag) => tokenize(tag))),
      };
    });
    this.n = this.docs.length;
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.n) || 1;
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    // BM25 idf, floored at a small positive value so a term in every doc still contributes a little.
    return Math.max(1e-6, Math.log(1 + (this.n - df + 0.5) / (df + 0.5)));
  }

  /** Score every chunk against the query; return the top `k` with score > 0, best first. */
  search(query: string, k = 5): SearchHit[] {
    const qTerms = [...new Set(tokenize(query))];
    if (qTerms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const term of qTerms) {
        const f = d.tf.get(term) ?? 0;
        const idf = this.idf(term);
        if (f > 0) {
          const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / this.avgLen);
          score += idf * ((f * (BM25_K1 + 1)) / denom);
        }
        if (d.titleTerms.has(term)) score += TITLE_BOOST * idf;
        if (d.tagTerms.has(term)) score += TAG_BOOST * idf;
      }
      if (score > 0) hits.push({ chunk: d.chunk, score: round(score) });
    }
    hits.sort((a, b) => (b.score - a.score) || (a.chunk.id < b.chunk.id ? -1 : 1));
    return hits.slice(0, k);
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
