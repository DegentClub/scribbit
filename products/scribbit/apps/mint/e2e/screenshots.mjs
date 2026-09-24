// Real-browser run of both pages in demo mode (playwright-core + the preinstalled chromium; never
// `playwright install`). Builds nothing: run `pnpm --filter @bsh/scribbit-mint build` first.
// Usage: pnpm --filter @bsh/scribbit-mint screenshots   (CHROMIUM_PATH overrides the browser binary)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });

const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error(`no chromium found (tried ${candidates.join(', ')})`);

const PORT = 4179;
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

async function run(width, scheme) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  // Fonts come from Google Fonts in production; offline runs fall back to the local stack.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g/.test(m.text()) && !/ERR_FAILED/.test(m.text()) && problems.push(`[${width} ${scheme}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${width} ${scheme}] pageerror: ${e.message}`));
  const shot = async (name) => {
    const file = `${name}-${width}${scheme === 'dark' ? '-dark' : ''}.png`;
    await page.screenshot({ path: join(out, file), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`[${file}] horizontal overflow ${overflow}px`);
    report.push(file);
  };

  // --- home
  await page.goto(`${base}/?demo=1`);
  await page.getByRole('heading', { name: 'Write to Bitcoin.' }).waitFor();
  await shot('home');

  // --- ordinals
  await page.goto(`${base}/ordinals?demo=1`);
  await page.getByRole('button', { name: 'Connect UniSat' }).click();
  await page.getByText('Connected: UniSat').waitFor();
  await page.getByLabel('…or paste text').fill('scribb.it: hello, Bitcoin. Every byte of this line is on chain.');
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.setInputFiles('#file-input', { name: 'stamp.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#F7931A"/></svg>') });
  await page.getByRole('button', { name: /normal · 5/ }).click();
  await shot('ordinals-content');
  await page.getByRole('button', { name: 'Quote #1 of 2' }).click();
  await page.getByRole('heading', { name: 'The bill, to the sat' }).waitFor();
  await shot('ordinals-quote');
  await page.getByRole('button', { name: 'Sign commit with UniSat' }).click();
  await page.getByRole('heading', { name: 'Reveal the inscription' }).waitFor();
  await page.getByRole('button', { name: 'Sign reveal with UniSat' }).click();
  await page.getByRole('heading', { name: 'Written to Bitcoin' }).waitFor();
  await page.getByRole('button', { name: 'Verify bytes' }).click();
  await page.getByText('✓ On-chain bytes match the SHA-256 above').waitFor();
  await shot('ordinals-done');

  // --- counters
  await page.goto(`${base}/counters?demo=1`);
  await page.getByRole('button', { name: 'Connect XCP Wallet' }).click();
  await page.getByText('Connected: XCP Wallet').waitFor();
  await page.setInputFiles('#c-file', { name: 'counter.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1d1a16"/></svg>') });
  await page.getByLabel('Asset name').fill('PRINTSHOP');
  await page.getByText('PRINTSHOP is free.').waitFor();
  await shot('counters-preflight');
  await page.getByRole('button', { name: 'Mint counter' }).click();
  await page.getByRole('heading', { level: 1, name: 'PRINTSHOP' }).waitFor();
  await shot('counters-receipt');
  await page.goto(`${base}/counters?demo=1`);
  await page.getByRole('button', { name: 'Connect Horizon Wallet' }).click();
  await page.getByRole('button', { name: 'Fairminter' }).click();
  await page.getByText(/Starts at block/).waitFor();
  await shot('counters-fairminter');
  await ctx.close();
}

try {
  await run(1280, 'light');
  await run(400, 'light');
  await run(1280, 'dark');
  await run(400, 'dark');
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(join(out, 'README.md'), `# Screenshots\n\nGenerated by \`pnpm --filter @bsh/scribbit-mint screenshots\` (demo mode, headless Chromium, light + dark, 1280 and 400 px).\n\n${report.map((f) => `- \`${f}\``).join('\n')}\n`);
console.log(JSON.stringify({ screenshots: report.length, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
