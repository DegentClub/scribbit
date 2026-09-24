/**
 * Launch a real Chromium through playwright-core WITHOUT `playwright install`: the browser comes from
 * `WALLET_KIT_CHROMIUM`, a Playwright browser directory (`/opt/pw-browsers`, `PLAYWRIGHT_BROWSERS_PATH`,
 * `~/.cache/ms-playwright`) or playwright-core's own default path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { FakeWalletConfig } from '../fakes/providers.js';

export function findChromium(): string | undefined {
  const explicit = process.env.WALLET_KIT_CHROMIUM;
  if (explicit && existsSync(explicit)) return explicit;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(homedir(), '.cache', 'ms-playwright')].filter((r): r is string => !!r);
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Prefer full chromium over headless_shell (extensions and some DOM APIs need it); newest build last.
    for (const dir of entries.filter((e) => /^chromium-\d+$/.test(e)).sort().reverse()) {
      for (const candidate of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(root, dir, candidate);
        if (existsSync(p)) return p;
      }
    }
    for (const dir of entries.filter((e) => /^chromium_headless_shell-\d+$/.test(e)).sort().reverse()) {
      const p = path.join(root, dir, 'chrome-linux', 'headless_shell');
      if (existsSync(p)) return p;
    }
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* no default install */
  }
  return undefined;
}

export async function launchChromium(): Promise<Browser> {
  const executablePath = findChromium();
  if (!executablePath) throw new Error('no Chromium found: set WALLET_KIT_CHROMIUM=/path/to/chrome (do not run `playwright install` here)');
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return chromium.launch({ executablePath, headless: true, args: asRoot ? ['--no-sandbox', '--disable-gpu'] : ['--disable-gpu'] });
}

/** A fresh context whose pages get the fake providers installed before any page script runs. */
export async function contextWithFakes(browser: Browser, fakesBundle: string, cfg: FakeWalletConfig): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: `window.__fakeWalletConfig = ${JSON.stringify(cfg)};` });
  await ctx.addInitScript({ path: fakesBundle });
  return ctx;
}

export async function openHarness(ctx: BrowserContext, baseUrl: string, network: string): Promise<Page> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${baseUrl}/harness.html?network=${network}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__walletKitHarness === 'object');
  if (errors.length) throw new Error(`harness page errors: ${errors.join(' | ')}`);
  return page;
}
