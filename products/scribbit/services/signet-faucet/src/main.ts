/** HTTP entry point: `pnpm --filter @bsh/scribbit-signet-faucet dev | start`. Configuration: env.schema.json. */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';
import { createBitcoindWallet, createFakeWallet, disabledWallet, type FaucetWallet } from './wallet.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadServerConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  let wallet: FaucetWallet = disabledWallet;
  if (cfg.wallet === 'fake') wallet = createFakeWallet({ balanceSats: cfg.fakeBalanceSats });
  if (cfg.wallet === 'bitcoind' && cfg.bitcoind) {
    const w = createBitcoindWallet(cfg.bitcoind);
    // Refuse to start against anything but signet: a misconfigured URL must never pay out real coins.
    try {
      await w.assertSignet();
    } catch (e) {
      console.error(JSON.stringify({ msg: 'refusing to start', reason: (e as Error).message }));
      process.exit(3);
    }
    wallet = w;
  }
  const app = createApp({
    ...cfg.app,
    wallet,
    onUnexpected: ({ requestId, error }) => console.error(JSON.stringify({ msg: 'unexpected error', requestId: requestId ?? null, error: String((error as Error)?.message ?? error) })),
  });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(JSON.stringify({ msg: 'scribbit signet faucet listening', port: info.port, wallet: wallet.kind, dripSats: cfg.app.dripSats, dailyBudgetSats: cfg.app.dailyBudgetSats, powDifficulty: cfg.app.powDifficulty }));
  });
}

void main();
