/** A citation-bearing source location. Every chunk carries one; every citation the tutor returns is one. */
export interface ChunkSource {
  /** What kind of primary source this is. */
  type: 'glossary' | 'spec' | 'adr' | 'bip' | 'academy';
  /** Stable source id: a glossary term id, a BSS number, a BIP number, an ADR id, a lesson id. */
  id: string;
  /** Public, non-internal URL a human can open. Never an internal hostname. */
  url: string;
  /** Optional in-document anchor (e.g. a spec section slug). */
  anchor?: string;
  /** Human-readable section / document name. */
  section?: string;
  /** True when the text is OUR summary of a primary document rather than a verbatim excerpt. */
  authored?: boolean;
}

/** One retrievable, citable unit of knowledge. */
export interface Chunk {
  /** Globally unique, stable, deterministic id (e.g. `glossary:taproot`, `bip:bip341`). */
  id: string;
  title: string;
  /** The searchable + quotable body. Plain text (no markup the widget would have to render). */
  text: string;
  source: ChunkSource;
  /** Lowercase keyword tags used for filtering and light ranking boosts. */
  tags: string[];
}

/** The committed, searchable index: a pure function of the sources under `sources/`. */
export interface KbIndex {
  /** Schema version of the index shape. Bump when the chunk shape changes. */
  version: number;
  /** Provenance of each source family, so a reader can see where the text came from. */
  builtFrom: { glossary: string; academy: string; specs: string; bips: string; adrs: string };
  /** Deterministically ordered chunks (sorted by id) so the freshness diff is stable. */
  chunks: Chunk[];
}

/** A ranked search hit. */
export interface SearchHit {
  chunk: Chunk;
  /** BM25 score; higher is better. Not normalised to any range. */
  score: number;
}
