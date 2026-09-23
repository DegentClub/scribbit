import type { PaymentIntent, PaymentStatus } from './domain/types.js';
import type { PaymentProvider } from './providers/provider.js';
import type { LedgerService } from './service.js';
import type { OrderStore } from './store/order-store.js';

export interface WorkerOptions {
  service: LedgerService;
  store: Pick<OrderStore, 'listPaymentsByStatus'>;
  providers: readonly PaymentProvider[];
  now?: () => Date;
  /** Intents examined per tick. Default 200. */
  batch?: number;
  /** Keep polling expired intents this long after expiry (late on-chain payments). Default 24 h. */
  expiredGraceMs?: number;
  onError?: (err: unknown, intent: PaymentIntent) => void;
}

export interface TickResult {
  polled: number;
  applied: number;
  errors: number;
}

const OPEN: readonly PaymentStatus[] = ['created', 'pending', 'underpaid', 'expired'];

/**
 * Reconciliation loop: polls every open intent's provider and applies what it reports; expires intents
 * whose provider does not report expiry itself. Idempotent: running it twice is the same as once, so it can
 * run on a timer, from a cron, or from a test with a fake clock (`now`).
 */
export class LedgerWorker {
  private readonly providers: Map<string, PaymentProvider>;
  private readonly now: () => Date;

  constructor(private readonly opts: WorkerOptions) {
    this.providers = new Map(opts.providers.map((p) => [p.name, p]));
    this.now = opts.now ?? (() => new Date());
  }

  async tick(): Promise<TickResult> {
    const res: TickResult = { polled: 0, applied: 0, errors: 0 };
    const now = this.now();
    const grace = this.opts.expiredGraceMs ?? 24 * 3_600_000;
    const intents = await this.opts.store.listPaymentsByStatus(OPEN, this.opts.batch ?? 200);
    for (const intent of intents) {
      if (intent.status === 'expired') {
        if (intent.method !== 'onchain' || !intent.expiresAt || now.getTime() - Date.parse(intent.expiresAt) > grace) continue;
      }
      const provider = this.providers.get(intent.provider);
      if (!provider) continue;
      res.polled++;
      try {
        let update = await provider.poll(intent, now);
        if (!update && intent.status === 'created' && intent.expiresAt && now.getTime() >= Date.parse(intent.expiresAt)) update = { status: 'expired', detail: 'expired without payment' };
        if (!update) continue;
        const applied = await this.opts.service.applyUpdate(intent.id, update, 'worker poll');
        if (applied.applied) res.applied++;
      } catch (e) {
        res.errors++;
        (this.opts.onError ?? ((err, i) => console.error('ledger worker: poll failed', i.id, err)))(e, intent);
      }
    }
    return res;
  }

  /** Run `tick()` every `intervalMs` until the returned function is called. */
  start(intervalMs: number): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      try {
        await this.tick();
      } catch (e) {
        console.error('ledger worker: tick failed', e);
      }
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
