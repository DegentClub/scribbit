// Emit the page's machine twins into public/ before `vite dev|build`: playground.json (steps, glossary, quiz,
// wallet statuses: the `?format=json` document) and sitemap.xml (absolute URLs need VITE_SITE_URL). Generated,
// git-ignored. Run by the `dev` and `build` scripts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config';
import { jsonTwinData } from '../src/twin';

export function staticFiles(env: Record<string, string | undefined>): Record<string, string> {
  const config = readConfig(env, '');
  const site = config.siteUrl.endsWith('/') ? config.siteUrl : `${config.siteUrl}/`;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site}</loc><changefreq>monthly</changefreq></url>
  <url><loc>${site}playground.json</loc><changefreq>monthly</changefreq></url>
  <url><loc>${site}llms.txt</loc><changefreq>monthly</changefreq></url>
</urlset>
`;
  return { 'playground.json': `${JSON.stringify(jsonTwinData(config), null, 2)}\n`, 'sitemap.xml': sitemap };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  mkdirSync(pub, { recursive: true });
  for (const [name, text] of Object.entries(staticFiles(process.env))) writeFileSync(join(pub, name), text);
  console.log('emitted public/playground.json, public/sitemap.xml');
}
