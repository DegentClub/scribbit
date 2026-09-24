import { defineConfig } from 'vitest/config';

/** Real-browser conformance run: `pnpm --filter @bsh/wallet-kit conformance`. Not part of `pnpm test`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['conformance/playwright/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
