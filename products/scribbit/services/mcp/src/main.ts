/** HTTP entry point: `pnpm --filter @bsh/scribbit-mcp dev | start`. Configuration: env.schema.json. */
import { serve } from '@hono/node-server';
import { Asker, createAnthropicChatPort, loadIndex } from '@bsh/blockspace-tutor-kb';
import { createApp } from './app.js';
import { ConfigError, keyStoreFrom, loadServerConfig } from './config.js';
import { feeProviders } from './fees.js';

function main(): void {
  let cfg;
  try {
    cfg = loadServerConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  const chat = createAnthropicChatPort(process.env);
  const asker = new Asker({ index: loadIndex(), ...(chat ? { chat } : {}) });
  const app = createApp({
    ports: { fees: feeProviders(cfg.networks, cfg.feeUrls), asker },
    keys: keyStoreFrom(cfg.keys),
    keyEnv: cfg.keyEnv,
    requireApiKey: cfg.requireApiKey,
    networks: cfg.networks,
    publicUrl: cfg.publicUrl,
    trustedProxies: cfg.trustedProxies,
    corsOrigins: cfg.corsOrigins,
    rateLimit: cfg.rateLimit,
    maxBodyBytes: cfg.maxBodyBytes,
    onUnexpected: ({ requestId, where, error }) =>
      console.error(JSON.stringify({ msg: 'unexpected error', where, requestId: requestId ?? null, error: String((error as Error)?.message ?? error) })),
  });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(
      JSON.stringify({
        msg: 'scribbit mcp listening',
        port: info.port,
        networks: cfg.networks,
        keyEnv: cfg.keyEnv,
        requireApiKey: cfg.requireApiKey,
        keys: cfg.keys.length,
      }),
    );
  });
}

main();
