/**
 * UPSTREAM SYNC (manual, dev-only) — re-snapshot the portal glossary, Academy lessons and BSS spec abstracts
 * from their source repositories into `sources/*.snapshot.json`, then run `refresh` to rebuild the index.
 *
 * The source repos live outside this workspace, so this is not part of `pnpm check`; point it at local
 * checkouts:
 *
 *   PORTAL_DIR=/path/to/blockspace-holdings/portal SPECS_DIR=/path/to/specs/specs \
 *     pnpm --filter @bsh/blockspace-tutor-kb snapshot && pnpm --filter @bsh/blockspace-tutor-kb refresh
 *
 * The freshness test guards drift WITHIN the committed snapshots; this script is how you pull a new upstream
 * revision in, as a reviewable diff.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const PORTAL = process.env.PORTAL_DIR;
const SPECS = process.env.SPECS_DIR;
if (!PORTAL || !SPECS) {
  console.error('Set PORTAL_DIR and SPECS_DIR to local checkouts of the portal and specs repos.');
  process.exit(2);
}
const OUT = fileURLToPath(new URL('../sources/', import.meta.url));

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function section(md: string, heading: string): string | null {
  const re = new RegExp('^## ' + heading + '\\s*$', 'm');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

// glossary
const g = parseYaml(readFileSync(join(PORTAL, 'content/glossary.yaml'), 'utf8')) as { version: number; terms: Array<Record<string, unknown>> };
writeFileSync(
  join(OUT, 'glossary.snapshot.json'),
  JSON.stringify(
    {
      provenance: { upstream: 'DegentClub/blockspace-holdings portal/content/glossary.yaml', version: g.version, snapshotOf: 'portal glossary' },
      terms: g.terms.map((t) => ({
        id: t.id, term: t.term, aliases: (t.aliases as string[]) ?? [], category: t.category ?? null,
        short: t.short, long: t.long, related: (t.related as string[]) ?? [], sources: (t.sources as string[]) ?? [],
      })),
    },
    null, 2,
  ) + '\n',
);

// academy
const acaDir = join(PORTAL, 'content/academy');
const lessons: unknown[] = [];
for (const d of readdirSync(acaDir).sort()) {
  const y = join(acaDir, d, 'lesson.yaml');
  if (!existsSync(y)) continue;
  const l = parseYaml(readFileSync(y, 'utf8')) as Record<string, unknown>;
  lessons.push({ id: l.id, number: l.number, title: l.title, summary: l.summary, level: l.level, objectives: l.objectives ?? [], glossary: l.glossary ?? [] });
}
writeFileSync(join(OUT, 'academy.snapshot.json'), JSON.stringify({ provenance: { upstream: 'DegentClub/blockspace-holdings portal/content/academy/*/lesson.yaml', snapshotOf: 'portal Academy lessons' }, lessons }, null, 2) + '\n');

// specs
const specs: unknown[] = [];
for (const f of readdirSync(SPECS).filter((x) => /^bss-\d+\.md$/.test(x)).sort()) {
  const md = readFileSync(join(SPECS, f), 'utf8');
  specs.push({
    id: f.replace('.md', ''), file: f,
    title: (/^# (.+)$/m.exec(md) ?? ['', ''])[1],
    abstract: section(md, 'Abstract'),
    sections: [...md.matchAll(/^## (.+)$/gm)].map((m) => ({ name: m[1], anchor: slug(m[1]!) })),
  });
}
writeFileSync(join(OUT, 'specs.snapshot.json'), JSON.stringify({ provenance: { upstream: 'DegentClub/specs specs/bss-*.md', snapshotOf: 'BSS specification abstracts' }, specs }, null, 2) + '\n');

console.log('snapshots refreshed; now run: pnpm --filter @bsh/blockspace-tutor-kb refresh');
