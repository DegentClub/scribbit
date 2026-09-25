/**
 * `buildIndex()` turns the committed snapshots + authored source modules under `sources/` into the searchable
 * `KbIndex`. It is a PURE function of its inputs, and `data/index.json` is exactly `buildIndexFromDisk()` —
 * the freshness test asserts they are equal, and `scripts/refresh.ts` writes it. Nothing here touches the
 * network; the snapshots were captured from the source repos by `scripts/snapshot.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Chunk, KbIndex } from './types.js';
import { BIP_SOURCES } from '../sources/bips.js';
import { ADR_SOURCES } from '../sources/adrs.js';

export const INDEX_VERSION = 1;

const GLOSSARY_URL = 'https://block.space/glossary';
const ACADEMY_URL = 'https://block.space/learn';
const SPEC_URL = 'https://github.com/DegentClub/specs/blob/main/specs';

interface GlossarySnapshot {
  provenance: { upstream: string };
  terms: Array<{ id: string; term: string; aliases: string[]; category: string | null; short: string; long: string; related: string[]; sources: string[] }>;
}
interface AcademySnapshot {
  provenance: { upstream: string };
  lessons: Array<{ id: string; number: number; title: string; summary: string; level: string; objectives: string[]; glossary: string[] }>;
}
interface SpecsSnapshot {
  provenance: { upstream: string };
  specs: Array<{ id: string; file: string; title: string; abstract: string | null; sections: Array<{ name: string; anchor: string }> }>;
}

export interface Sources {
  glossary: GlossarySnapshot;
  academy: AcademySnapshot;
  specs: SpecsSnapshot;
}

function readJson<T>(rel: string): T {
  const p = fileURLToPath(new URL(`../sources/${rel}`, import.meta.url));
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

/** Read the committed snapshots from disk. */
export function loadSources(): Sources {
  return {
    glossary: readJson<GlossarySnapshot>('glossary.snapshot.json'),
    academy: readJson<AcademySnapshot>('academy.snapshot.json'),
    specs: readJson<SpecsSnapshot>('specs.snapshot.json'),
  };
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Build the index from explicit sources (pure; used by tests and by `buildIndexFromDisk`). */
export function buildIndex(sources: Sources): KbIndex {
  const chunks: Chunk[] = [];

  // Glossary: one chunk per term.
  for (const t of sources.glossary.terms) {
    const url = `${GLOSSARY_URL}#${t.id}`;
    const aliasLine = t.aliases.length ? ` (also: ${t.aliases.join(', ')})` : '';
    chunks.push({
      id: `glossary:${t.id}`,
      title: t.term,
      text: clean(`${t.term}${aliasLine}. ${t.short} ${t.long}`),
      source: { type: 'glossary', id: t.id, url, section: 'Glossary' },
      tags: dedupe(['glossary', ...(t.category ? [t.category] : []), ...t.related, ...t.aliases.map((a) => a.toLowerCase())]),
    });
  }

  // BSS specs: one chunk per spec abstract.
  for (const s of sources.specs.specs) {
    if (!s.abstract) continue;
    chunks.push({
      id: `spec:${s.id}`,
      title: s.title,
      text: clean(`${s.title}. ${s.abstract}`),
      source: { type: 'spec', id: s.id, url: `${SPEC_URL}/${s.file}#abstract`, anchor: 'abstract', section: 'Abstract' },
      tags: dedupe(['spec', 'bss', s.id.replace('bss-', 'bss'), ...specTags(s.title)]),
    });
  }

  // Academy lessons: one chunk per lesson (summary + objectives).
  for (const l of sources.academy.lessons) {
    chunks.push({
      id: `academy:${l.id}`,
      title: `Academy — ${l.title}`,
      text: clean(`${l.title}. ${l.summary} ${l.objectives.join(' ')}`),
      source: { type: 'academy', id: l.id, url: `${ACADEMY_URL}/${l.id}`, section: `Lesson ${l.number}` },
      tags: dedupe(['academy', 'lesson', l.level, ...l.glossary]),
    });
  }

  // Authored BIP / ordinals summaries.
  for (const b of BIP_SOURCES) {
    chunks.push({
      id: `bip:${b.id}`,
      title: b.title,
      text: clean(b.text),
      source: { type: 'bip', id: b.bip ?? b.id, url: b.url, section: b.bip ?? 'Ordinals docs', authored: true },
      tags: dedupe(['bip', ...(b.bip ? [b.bip.toLowerCase()] : []), ...b.tags]),
    });
  }

  // Authored ADR summaries.
  for (const a of ADR_SOURCES) {
    chunks.push({
      id: `adr:${a.id}`,
      title: a.title,
      text: clean(a.text),
      source: { type: 'adr', id: a.id, url: a.url, section: 'ADR', authored: true },
      tags: dedupe(['adr', ...a.tags]),
    });
  }

  chunks.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    version: INDEX_VERSION,
    builtFrom: {
      glossary: sources.glossary.provenance.upstream,
      academy: sources.academy.provenance.upstream,
      specs: sources.specs.provenance.upstream,
      bips: 'authored summaries of BIP340/341/342 and the ordinals inscription envelope',
      adrs: 'authored summaries of estate ADRs (docs/adr/*.md)',
    },
    chunks,
  };
}

/** Build from the committed snapshots on disk. `data/index.json` must equal this. */
export function buildIndexFromDisk(): KbIndex {
  return buildIndex(loadSources());
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.toLowerCase()))];
}

/** A few coarse tags from a spec title so a topical query ("attestation", "psbt") can reach the right spec. */
function specTags(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/bss-\d+:?/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}
