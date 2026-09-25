// @vitest-environment node
// Real Chromium render of the demo page at 390/1280 px, light and dark: no horizontal overflow, no console
// errors, the widget upgrades and answers a fixture question. Uses the preinstalled Chromium (never
// `playwright install`). Screenshots land in docs/screenshots for eyeballing.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'docs', 'screenshots');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.txt': 'text/plain', '.json': 'application/json' };

/** Minimal static file server rooted at the package dir — ES modules need http (file:// is CORS-blocked). */
function staticServer() {
  return createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    const path = join(root, rel);
    if (!path.startsWith(root) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
}

const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));

const MATRIX = [
  { width: 390, scheme: 'light' },
  { width: 390, scheme: 'dark' },
  { width: 1280, scheme: 'light' },
  { width: 1280, scheme: 'dark' },
];

describe.skipIf(!executablePath)('demo page renders in Chromium', () => {
  /** @type {import('playwright-core').Browser} */
  let browser;
  /** @type {import('node:http').Server} */
  let server;
  let demo = '';
  beforeAll(async () => {
    mkdirSync(out, { recursive: true });
    server = staticServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const addr = server.address();
    demo = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/demo/index.html`;
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((r) => server.close(() => r(undefined)));
  });

  for (const { width, scheme } of MATRIX) {
    it(`${width}px ${scheme}: no overflow, no console errors, answers a question`, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' });
      const problems = [];
      const page = await ctx.newPage();
      page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

      await page.goto(demo, { waitUntil: 'load' });
      // The custom element upgraded and rendered its shell.
      const input = page.locator('ask-blockspace').locator('input#q');
      await input.waitFor({ state: 'visible', timeout: 10_000 });

      // Ask a fixture question and assert a grounded answer with a citation appears.
      await input.fill('what is the witness discount?');
      await page.locator('ask-blockspace').getByRole('button', { name: 'Ask' }).click();
      const answer = page.locator('ask-blockspace .answer');
      await answer.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await answer.textContent()).toMatch(/weight unit/i);
      expect(await page.locator('ask-blockspace .cites a').count()).toBeGreaterThan(0);

      await page.screenshot({ path: join(out, `demo-${width}-${scheme}.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow ${overflow}px`).toBeLessThanOrEqual(1);
      expect(problems, problems.join('\n')).toEqual([]);
      await ctx.close();
    }, 45_000);
  }
});
