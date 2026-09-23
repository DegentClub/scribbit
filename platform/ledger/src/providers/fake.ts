import type { PaymentIntent, PaymentMethod, Refund } from '../domain/types.js';
import type { CreateIntentInput, PaymentProvider, ProviderIntent, ProviderRefundResult, ProviderUpdate } from './provider.js';

/**
 * Deterministic provider for tests and local dev. Push updates with `settle()` / `expire()` / `fail()`;
 * the worker's next `tick()` (or a direct `poll`) delivers them.
 */
export class FakeProvider implements PaymentProvider {
  readonly name: string;
  readonly methods: readonly PaymentMethod[];
  readonly intents = new Map<string, CreateIntentInput>();
  readonly refunds: Array<{ intent: PaymentIntent; refund: Refund }> = [];
  private readonly queued = new Map<string, ProviderUpdate>();
  private seq = 0;
  refundResult: ProviderRefundResult = { status: 'completed', providerRef: 'fake-refund' };

  constructor(opts: { name?: string; methods?: readonly PaymentMethod[] } = {}) {
    this.name = opts.name ?? 'fake';
    this.methods = opts.methods ?? ['onchain', 'lightning', 'card'];
  }

  async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
    const ref = `${this.name}-${++this.seq}`;
    this.intents.set(ref, input);
    const checkout =
      input.method === 'onchain'
        ? { address: `bcrt1qfake${this.seq}` }
        : input.method === 'lightning'
          ? { bolt11: `lnbcrt${input.amountSats}n1fake${this.seq}` }
          : { clientSecret: `${ref}_secret`, checkoutUrl: `https://fake.invalid/checkout/${ref}` };
    return { providerRef: ref, checkout, expiresAt: input.expiresAt };
  }

  /** Queue a settlement; `amountSats` defaults to the intent amount (exact payment). */
  settle(providerRef: string, amountSats?: number, extra: Partial<ProviderUpdate> = {}): void {
    const input = this.intents.get(providerRef);
    if (!input) throw new Error(`unknown intent ${providerRef}`);
    const paid = amountSats ?? input.amountSats;
    const status = paid < input.amountSats ? 'underpaid' : paid > input.amountSats ? 'overpaid' : 'paid';
    this.queued.set(providerRef, { status, amountPaidSats: paid, paidAt: input.now.toISOString(), ...extra });
  }

  pending(providerRef: string, amountSats = 0): void {
    this.queued.set(providerRef, { status: 'pending', amountPaidSats: amountSats });
  }

  expire(providerRef: string): void {
    this.queued.set(providerRef, { status: 'expired' });
  }

  fail(providerRef: string, detail = 'declined'): void {
    this.queued.set(providerRef, { status: 'failed', detail });
  }

  async poll(intent: PaymentIntent): Promise<ProviderUpdate | undefined> {
    const u = this.queued.get(intent.providerRef);
    this.queued.delete(intent.providerRef);
    return u;
  }

  async refund(intent: PaymentIntent, refund: Refund): Promise<ProviderRefundResult> {
    this.refunds.push({ intent, refund });
    return this.refundResult;
  }
}
