/** HTTP entry point: `pnpm --filter @bsh/scribbit-mint-api dev | start`. Configuration: env.schema.json. */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';
import { feeProviderFor } from './fees.js';

function main(): void {
  let cfg;
  try {
    cfg = loadServerConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  const app = createApp({
    network: cfg.network,
    esploraUrl: cfg.esploraUrl,
    cpUrl: cfg.cpUrl,
    fees: feeProviderFor(cfg.feeUrl, cfg.network),
    corsOrigins: cfg.corsOrigins,
    trustedProxies: cfg.trustedProxies,
    publicUrl: cfg.publicUrl,
    rateLimit: cfg.rateLimit,
    limits: cfg.limits,
    onUnexpected: ({ requestId, where, error }) =>
      console.error(JSON.stringify({ msg: 'unexpected error', where, requestId: requestId ?? null, error: String((error as Error)?.message ?? error) })),
  });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(JSON.stringify({ msg: 'scribbit mint api listening', port: info.port, network: cfg.network, esplora: cfg.esploraUrl, counterparty: cfg.cpUrl ?? null, fees: cfg.feeUrl ?? 'public mempool', cors: cfg.corsOrigins }));
  });
}

main();
