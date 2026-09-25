/**
 * Service entry point. Configuration is environment only (env.schema.json); secrets (the
 * authorization private key, API key hashes, the ledger key) arrive as environment values
 * injected from the secret store, never from files in the repository.
 */
import { serve } from '@hono/node-server';
import { InMemoryApiKeyStore } from '@bsh/edge';
import { createPlaneApp } from './api.ts';
import { loadConfig } from './config.ts';
import { httpLedgerPort } from './ledger.ts';
import { PlaneService } from './service.ts';
import { MemoryPlaneStore } from './store/memory.ts';
import { SqlitePlaneStore } from './store/sqlite.ts';
import type { PlaneStore } from './store/types.ts';

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const store: PlaneStore = config.dbPath ? new SqlitePlaneStore(config.dbPath) : new MemoryPlaneStore();
  if (!config.dbPath) console.warn('plane: PLANE_DB_PATH is not set - in-memory store, every reservation and the audit log are lost on restart (dev only)');
  const service = new PlaneService({
    store,
    signingKey: config.signingKey,
    retiredPublicKeys: config.retiredPublicKeys,
    name: config.name,
    url: config.publicUrl,
    chains: config.chains,
    denylist: config.denylist,
    firstTimeEscalateAbove: config.firstTimeEscalateAbove,
    authorizationTtlMs: config.authorizationTtlMs,
    decisionTtlMs: config.decisionTtlMs,
    ...(config.ledger ? { ledger: httpLedgerPort(config.ledger) } : {}),
  });
  const apiKeyStore = new InMemoryApiKeyStore();
  for (const k of config.keys) apiKeyStore.add(k);
  const app = createPlaneApp({
    service,
    apiKeyStore,
    approvers: config.approvers,
    environment: config.keyEnv,
    rateLimit: { windowMs: 60_000, max: config.rateLimitPerMinute },
    ...(config.trustedProxies.length ? { trustProxy: { trusted: config.trustedProxies } } : {}),
  });
  // Expiry does not wait for traffic: release what lapsed once a minute.
  const timer = setInterval(() => void service.sweep().catch((err) => console.error('plane: sweep failed', err)), 60_000);
  timer.unref();
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`plane: listening on ${info.address}:${info.port} (${config.chains.join(', ')}; ${config.keys.length} keys, ${config.approvers.length} approvers${config.ledger ? ', ledger on' : ''})`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`plane: ${(err as Error).message}`);
    process.exit(1);
  });
}
