// Real-browser run of the whole demo flow (playwright-core + the preinstalled Chromium; never `playwright install`).
// Builds nothing: run `pnpm --filter @bsh/scribbit-playground build` first.
// Usage: pnpm --filter @bsh/scribbit-playground e2e        (CHROMIUM_PATH overrides the browser binary)
//
// For each of 390 px and 1280 px, light and dark: the five steps in demo mode (offline fakes, real PoW in a Web
// Worker, real transaction maths and signatures), a screenshot per step, and assertions: no horizontal overflow,
// no console errors, the TEST NETWORK banner on every screen, the PoW worker loaded, and the scripted path
// finishing inside the five-minute goal.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });
const GOAL_SECONDS = 300;

const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error(`no chromium found (tried ${candidates.join(', ')})`);

const PORT = 4187;
const server = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite preview did not start')), 20_000);
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && (clearTimeout(t), resolve()));
  server.on('exit', (c) => reject(new Error(`vite preview exited ${c}`)));
});

const base = `http://localhost:${PORT}`;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const report = [];
const problems = [];
const timings = [];

async function run(width, scheme) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: scheme === 'dark' ? 'reduce' : 'no-preference' });
  // Offline: anything that is not the preview server is refused (fonts fall back to the local stack).
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.abort());
  const page = await ctx.newPage();
  const tag = `[${width} ${scheme}]`;
  let workerLoaded = false;
  page.on('worker', () => (workerLoaded = true));
  page.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|fonts\.g/.test(m.text()) && problems.push(`${tag} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
  const shot = async (name) => {
    const file = `${name}-${width}${scheme === 'dark' ? '-dark' : ''}.png`;
    await page.screenshot({ path: join(out, file), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${tag} ${file}: horizontal overflow ${overflow}px`);
    if (!(await page.getByRole('note', { name: 'Test network warning' }).isVisible())) problems.push(`${tag} ${file}: TEST NETWORK banner missing`);
    report.push(file);
  };

  await page.goto(`${base}/?demo=1`);
  await page.getByRole('heading', { level: 1, name: 'Get a test wallet' }).waitFor();
  // Keyboard: the skip link is the first tab stop.
  await page.keyboard.press('Tab');
  const skip = await page.evaluate(() => document.activeElement?.textContent);
  if (skip !== 'Skip to content') problems.push(`${tag} first tab stop is "${skip}", not the skip link`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await shot('1-wallet');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Make a throwaway test key' }).click();
  await page.getByRole('heading', { level: 1, name: 'Get free test coins' }).waitFor();
  await shot('2-coins');
  await page.getByRole('button', { name: 'Get free test coins' }).click();
  await page.getByRole('heading', { level: 1, name: 'Pick a small file' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'A tiny SVG badge' }).click();
  await page.getByTestId('quote').waitFor();
  await shot('3-file-quote');
  await page.getByRole('button', { name: 'Continue: commit and reveal' }).click();
  await page.getByRole('heading', { level: 1, name: 'Commit and reveal' }).waitFor();
  await page.getByRole('button', { name: /Sign the commit/ }).click();
  await page.getByText(/Commit broadcast/).waitFor();
  await shot('4-inscribe');
  await page.getByRole('button', { name: /Sign the reveal/ }).click();
  await page.getByTestId('certificate').waitFor();
  const seconds = (Date.now() - t0) / 1000;
  timings.push({ width, scheme, seconds });
  if (seconds >= GOAL_SECONDS) problems.push(`${tag} scripted path took ${seconds}s (goal ${GOAL_SECONDS}s)`);
  if (!workerLoaded) problems.push(`${tag} the proof of work did not run in a Web Worker`);
  const clock = await page.getByTestId('elapsed').textContent();
  const [m, s] = clock.split(':').map(Number);
  if (m * 60 + s >= GOAL_SECONDS) problems.push(`${tag} app clock shows ${clock}`);
  // Answer the quiz correctly (the options are the kit's; the first question's right answer is option 1 of 3, etc.).
  for (const [q, i] of [['Why were your test coins free?', 0], ['Where do the bytes of your file live now?', 1], ['Why did it take two transactions?', 1]]) {
    await page.getByRole('group', { name: new RegExp(q.replace('?', '\\?')) }).getByRole('radio').nth(i).check();
  }
  await page.getByRole('button', { name: 'Check my answers' }).click();
  await page.getByText('3 of 3: you can explain what you did.').waitFor();
  await shot('5-certificate');

  // The JSON twin.
  await page.goto(`${base}/?format=json`);
  const twin = JSON.parse(await page.getByTestId('json-twin').textContent());
  if (twin.steps?.length !== 5) problems.push(`${tag} ?format=json twin has ${twin.steps?.length} steps`);
  const res = await page.goto(`${base}/playground.json`);
  if (!res.ok()) problems.push(`${tag} playground.json: HTTP ${res.status()}`);
  await ctx.close();
}

try {
  await run(1280, 'light');
  await run(390, 'light');
  await run(1280, 'dark');
  await run(390, 'dark');
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(
  join(out, 'README.md'),
  `# Screenshots\n\nGenerated by \`pnpm --filter @bsh/scribbit-playground e2e\` (demo mode, headless Chromium, 1280 and 390 px, light and dark; dark runs with reduced motion). Offline: every request off the preview server is refused.\n\nScripted path timings (first click to certificate): ${timings.map((t) => `${t.width} ${t.scheme} ${t.seconds.toFixed(1)} s`).join(', ')}.\n\n${report.map((f) => `- \`${f}\``).join('\n')}\n`,
);
console.log(JSON.stringify({ screenshots: report.length, timings, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
