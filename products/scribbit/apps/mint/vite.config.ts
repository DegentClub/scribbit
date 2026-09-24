/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * The static demo build (`VITE_DEMO_DEFAULT=1`, GitHub Pages) makes no third-party requests: drop the Google
 * Fonts links so the page falls back to system fonts and never leaves its own origin.
 */
function offlineDemoFonts(): Plugin {
  return {
    name: 'offline-demo-fonts',
    transformIndexHtml: (html) => (process.env.VITE_DEMO_DEFAULT === '1' ? html.replace(/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g, '') : html),
  };
}

export default defineConfig({
  plugins: [react(), offlineDemoFonts()],
  // One chunk: the page is the wallet flow; the crypto libraries dominate and are needed on first paint.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
