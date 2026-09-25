/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const DEFAULT_SITE_URL = 'https://degentclub.github.io/scribbit/playground/';

/**
 * index.html carries __SITE_URL__ (canonical, OpenGraph, JSON-LD); the static demo build
 * (`VITE_DEMO_DEFAULT=1`, GitHub Pages) also drops the Google Fonts links so it makes no third-party requests.
 */
function htmlEnv(): Plugin {
  return {
    name: 'playground-html-env',
    enforce: 'pre',
    transformIndexHtml: (html) => {
      let out = html.replaceAll('__SITE_URL__', process.env.VITE_SITE_URL || DEFAULT_SITE_URL);
      if (process.env.VITE_DEMO_DEFAULT === '1') out = out.replace(/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g, '');
      return out;
    },
  };
}

export default defineConfig({
  plugins: [react(), htmlEnv()],
  // Relative asset URLs: the same build works at /, /playground/ or /scribbit/playground/.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
