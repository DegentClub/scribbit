/**
 * `pnpm --filter @bsh/blockspace-tutor-kb refresh` — rebuild the committed index from the committed snapshots.
 * `data/index.json` must always equal this output (the freshness test enforces it). Run this after editing any
 * file under `sources/`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndexFromDisk } from '../src/build.js';

const out = fileURLToPath(new URL('../data/index.json', import.meta.url));
const index = buildIndexFromDisk();
writeFileSync(out, JSON.stringify(index, null, 2) + '\n');
console.log(`wrote ${index.chunks.length} chunks to data/index.json`);
