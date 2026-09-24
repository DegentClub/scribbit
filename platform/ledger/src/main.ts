/**
 * Service entry point. Configuration is environment only (env.schema.json); secrets arrive as env values
 * injected from the secret store, never from files in the repo.
 */
import { serve } from '@hono/node-server';
import { InMemoryApiKeyStore, type ApiKeyRecord } from '@bsh/edge';
import { InMemoryBus, platformRegistry, type EventBus } from '@bsh/events';
import { createLedgerApp } from './api.js';
import { BtcpayProvider } from './providers/btcpay.js';
import { StripeLikeProvider, fixedRate } from './providers/card.js';
import { FakeProvider } from './providers/fake.js';
import { EsploraChain, OnchainAddressProvider, type AddressType, type BitcoinNetwork } from './providers/onchain.js';
import { PsbtProvider } from './providers/psbt.js';
import type { PaymentProvider } from './providers/provider.js';
import { LedgerService } from './service.js';
import { MemoryOrderStore } from './store/memory-store.js';
import type { OrderStore } from './store/order-store.js';
import { SqliteOrderStore } from './store/sqlite-store.js';
import { LedgerWorker } from './worker.js';

const env = process.env;
const num = (k: string, d: number): number => (env[k] ? Number(env[k]) : d);

export async function main(): Promise<void> {
  const store: OrderStore = env.LEDGER_DB_PATH ? new SqliteOrderStore(env.LEDGER_DB_PATH) : new MemoryOrderStore();
  const providers: PaymentProvider[] = [];

  if (env.LEDGER_XPUB) {
    if (!env.LEDGER_ESPLORA_URL) throw new Error('LEDGER_ESPLORA_URL is required with LEDGER_XPUB');
    providers.push(
      new OnchainAddressProvider({
        xpub: env.LEDGER_XPUB,
        network: (env.LEDGER_NETWORK ?? 'mainnet') as BitcoinNetwork,
        addressType: (env.LEDGER_ADDRESS_TYPE ?? 'p2wpkh') as AddressType,
        chain: new EsploraChain(env.LEDGER_ESPLORA_URL),
        store,
        policy: { confirmations: num('LEDGER_CONFIRMATIONS', 1), overpaymentToleranceSats: num('LEDGER_OVERPAY_TOLERANCE_SATS', 0), underpaymentToleranceSats: num('LEDGER_UNDERPAY_TOLERANCE_SATS', 0) },
        expiryMinutes: num('LEDGER_ONCHAIN_EXPIRY_MINUTES', 60),
      }),
    );
  }
  if (env.BTCPAY_URL) {
    if (!env.BTCPAY_STORE_ID || !env.BTCPAY_API_KEY || !env.BTCPAY_WEBHOOK_SECRET) throw new Error('BTCPAY_STORE_ID, BTCPAY_API_KEY and BTCPAY_WEBHOOK_SECRET are required with BTCPAY_URL');
    providers.push(
      new BtcpayProvider({
        baseUrl: env.BTCPAY_URL,
        storeId: env.BTCPAY_STORE_ID,
        apiKey: env.BTCPAY_API_KEY,
        webhookSecret: env.BTCPAY_WEBHOOK_SECRET.split(',').map((s) => s.trim()).filter(Boolean),
        methods: (env.BTCPAY_METHODS ?? 'lightning,onchain').split(',').map((s) => s.trim()) as Array<'lightning' | 'onchain'>,
        expiryMinutes: num('BTCPAY_EXPIRY_MINUTES', 15),
      }),
    );
  }
  if (env.CARD_API_URL) {
    if (!env.CARD_SECRET_KEY || !env.CARD_WEBHOOK_SECRET || !env.CARD_FIAT_MINOR_PER_BTC) throw new Error('CARD_SECRET_KEY, CARD_WEBHOOK_SECRET and CARD_FIAT_MINOR_PER_BTC are required with CARD_API_URL');
    providers.push(
      new StripeLikeProvider({
        baseUrl: env.CARD_API_URL,
        secretKey: env.CARD_SECRET_KEY,
        webhookSecret: env.CARD_WEBHOOK_SECRET.split(',').map((s) => s.trim()).filter(Boolean),
        fiatCurrency: env.CARD_FIAT_CURRENCY ?? 'usd',
        rates: fixedRate(Number(env.CARD_FIAT_MINOR_PER_BTC)), // replace with a quote source before production card volume
      }),
    );
  }
  if (env.LEDGER_PSBT_PROVIDER === '1') {
    // Non-custodial: no keys, no PSBT building. With an esplora backend the worker finds the settling transaction
    // by the payee scripts; without one the product reports it through PsbtProvider.evaluate + applyUpdate.
    providers.push(
      new PsbtProvider({
        network: (env.LEDGER_NETWORK ?? 'mainnet') as BitcoinNetwork,
        ...(env.LEDGER_ESPLORA_URL ? { chain: new EsploraChain(env.LEDGER_ESPLORA_URL) } : {}),
        store,
        policy: { confirmations: num('LEDGER_CONFIRMATIONS', 1), overpaymentToleranceSats: num('LEDGER_OVERPAY_TOLERANCE_SATS', 0), underpaymentToleranceSats: num('LEDGER_UNDERPAY_TOLERANCE_SATS', 0) },
        expiryMinutes: num('LEDGER_ONCHAIN_EXPIRY_MINUTES', 60),
      }),
    );
  }
  if (env.LEDGER_FAKE_PROVIDER === '1') providers.push(new FakeProvider());
  if (providers.length === 0) throw new Error('no payment provider configured');

  // Production wires AmqpBusAdapter (see @bsh/events README); the in-memory bus keeps events local.
  const bus: EventBus = new InMemoryBus({ registry: platformRegistry() });

  const defaultProvider: Partial<Record<'onchain' | 'lightning' | 'card' | 'psbt', string>> = {};
  if (env.LEDGER_ONCHAIN_PROVIDER) defaultProvider.onchain = env.LEDGER_ONCHAIN_PROVIDER;
  const service = new LedgerService({ store, providers, bus, defaultProvider });

  const apiKeyStore = new InMemoryApiKeyStore();
  const keys = JSON.parse(env.LEDGER_API_KEYS_JSON ?? '[]') as ApiKeyRecord[];
  for (const k of keys) apiKeyStore.add(k);

  const app = createLedgerApp({
    service,
    apiKeyStore,
    environment: (env.LEDGER_KEY_ENV ?? 'live') as 'live' | 'test',
    rateLimit: { windowMs: 60_000, max: num('LEDGER_RATE_LIMIT_PER_MINUTE', 600) },
    ...(env.LEDGER_TRUSTED_PROXIES ? { trustProxy: { trusted: env.LEDGER_TRUSTED_PROXIES.split(',').map((s) => s.trim()) } } : {}),
  });

  const worker = new LedgerWorker({ service, store, providers });
  const stop = worker.start(num('LEDGER_POLL_INTERVAL_MS', 15_000));

  const server = serve({ fetch: app.fetch, port: num('PORT', 3050), hostname: env.HOST ?? '127.0.0.1' }, (info) => {
    console.log(`ledger listening on ${info.address}:${info.port} providers=${providers.map((p) => p.name).join(',')}`);
  });
  const shutdown = (): void => {
    stop();
    server.close();
    void store.close?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && /main\.ts$|main\.js$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
