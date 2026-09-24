/**
 * Bundle the harness and the fake providers for a real browser with esbuild (IIFE so the page works
 * from `file://` as well as http). `pnpm --filter @bsh/wallet-kit conformance:build`.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const CONFORMANCE_DIR = path.resolve(import.meta.dirname);
export const DIST_DIR = path.join(CONFORMANCE_DIR, 'dist');
export const HARNESS_BUNDLE = path.join(DIST_DIR, 'harness.js');
export const FAKES_BUNDLE = path.join(DIST_DIR, 'fake-providers.js');

export async function buildConformance(opts: { minify?: boolean } = {}): Promise<{ harness: string; fakes: string }> {
  mkdirSync(DIST_DIR, { recursive: true });
  const common = { bundle: true, format: 'iife' as const, target: 'es2022', sourcemap: true, minify: opts.minify ?? false, logLevel: 'error' as const };
  await Promise.all([
    build({ ...common, entryPoints: [path.join(CONFORMANCE_DIR, 'harness.ts')], outfile: HARNESS_BUNDLE }),
    build({ ...common, entryPoints: [path.join(CONFORMANCE_DIR, 'fakes', 'providers.ts')], outfile: FAKES_BUNDLE }),
  ]);
  return { harness: HARNESS_BUNDLE, fakes: FAKES_BUNDLE };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const out = await buildConformance();
  console.log(`built ${path.relative(process.cwd(), out.harness)} and ${path.relative(process.cwd(), out.fakes)}`);
}
