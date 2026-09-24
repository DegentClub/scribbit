/** HTTP entry point: `pnpm --filter @bsh/signer dev | start`. Configuration: env.schema.json. */
import { serve } from '@hono/node-server';
import { createSignerApp } from './app.js';
import { InMemoryAuditLog, JsonLinesAuditLog, MultiAuditLog } from './audit.js';
import { apiKeyStoreFrom, ConfigError, keyProviderFrom, loadConfig, taprootPoliciesFrom } from './config.js';
import { Signer } from './signer.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  const keys = keyProviderFrom(cfg, process.env);
  const auditLog = new InMemoryAuditLog(cfg.auditCapacity);
  const signer = new Signer({
    keys,
    audit: new MultiAuditLog([auditLog, new JsonLinesAuditLog()]),
    allowedPurposes: cfg.allowedPurposes,
    allowedSighashTypes: cfg.allowedSighashTypes,
    taprootPolicies: taprootPoliciesFrom(cfg),
    network: cfg.network,
  });
  const app = createSignerApp({
    signer,
    keys: apiKeyStoreFrom(cfg.apiKeys),
    keyEnv: cfg.keyEnv,
    auditLog,
    trustedProxies: cfg.trustedProxies,
    rateLimit: cfg.rateLimit,
    maxBodyBytes: cfg.maxBodyBytes,
    onUnexpected: ({ requestId, error }) =>
      console.error(JSON.stringify({ msg: 'unexpected error', requestId: requestId ?? null, error: String((error as Error)?.message ?? error) })),
  });
  const keyIds = await keys.keyIds();
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(
      JSON.stringify({
        msg: 'signer listening',
        port: info.port,
        host: cfg.host,
        network: cfg.network,
        keyProvider: cfg.keyProvider,
        keys: keyIds,
        purposes: cfg.allowedPurposes,
        sighash: cfg.allowedSighashTypes,
        apiKeys: cfg.apiKeys.length,
      }),
    );
  });
}

void main();
