/** HTTP entry point: `pnpm --filter @bsh/blockspace-tutor dev | start`. Configuration: env.schema.json. */
import { serve } from '@hono/node-server';
import { createAnthropicChatPort } from '@bsh/blockspace-tutor-kb';
import { createApp } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';
import { HttpLiveFacts } from './livefacts-http.js';

function main(): void {
  let cfg;
  try {
    cfg = loadServerConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }

  const chat = createAnthropicChatPort(process.env);
  const liveFacts = cfg.liveFacts.enabled ? new HttpLiveFacts({ baseUrl: cfg.liveFacts.url! }) : undefined;

  const app = createApp({
    chat,
    liveFacts,
    maxQuestionChars: cfg.maxQuestionChars,
    corsOrigins: cfg.corsOrigins,
    trustedProxies: cfg.trustedProxies,
    rateLimit: { perMinute: cfg.ratePerMinute },
    publicUrl: cfg.publicUrl,
    onUnexpected: ({ requestId, where, error }) =>
      console.error(JSON.stringify({ msg: 'unexpected error', where, requestId: requestId ?? null, error: String((error as Error)?.message ?? error) })),
  });

  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(JSON.stringify({ msg: 'ask-blockspace listening', port: info.port, mode: chat ? 'chat' : 'extractive', liveFacts: cfg.liveFacts.enabled }));
  });
}

main();
