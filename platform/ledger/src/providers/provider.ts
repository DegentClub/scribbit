import type { CheckoutDetails, Order, PaymentIntent, PaymentMethod, PaymentStatus, Refund } from '../domain/types.js';

/** What a provider returns when an intent is created. */
export interface ProviderIntent {
  providerRef: string;
  checkout: CheckoutDetails;
  /** ISO time; null = the provider imposes no expiry. */
  expiresAt: string | null;
  providerData?: Record<string, unknown>;
}

/** A provider's view of an intent, applied by the service through the payment state table. */
export interface ProviderUpdate {
  status: PaymentStatus;
  /** Credited satoshis (confirmed per the provider's policy). */
  amountPaidSats?: number;
  paidAt?: string;
  txid?: string;
  preimage?: string;
  providerData?: Record<string, unknown>;
  detail?: string;
}

export interface ProviderRefundResult {
  status: 'pending' | 'completed' | 'failed';
  providerRef: string | null;
  detail?: string;
}

/** A parsed, authenticated webhook: which intent it concerns and what it says. */
export interface ProviderWebhook {
  /** Unique delivery id for replay protection. */
  deliveryId: string;
  providerRef: string;
  /** Undefined for informational events that do not change state. */
  update?: ProviderUpdate;
  /** Set when the webhook says a refund settled. */
  refund?: { providerRef: string; status: 'completed' | 'failed'; detail?: string };
  eventType: string;
}

export class WebhookError extends Error {
  constructor(
    readonly code: 'invalid_signature' | 'malformed_payload',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

export interface CreateIntentInput {
  intentId: string;
  order: Order;
  method: PaymentMethod;
  amountSats: number;
  expiresAt: string | null;
  now: Date;
}

/**
 * Payment provider port. One adapter may serve several methods (BTCPay: lightning + onchain).
 * `poll` is called by the worker for open intents; `parseWebhook` by the webhook routes. Both feed the same
 * `ProviderUpdate` shape, so the state machine has one entry point regardless of the source.
 */
export interface PaymentProvider {
  readonly name: string;
  readonly methods: readonly PaymentMethod[];
  createIntent(input: CreateIntentInput): Promise<ProviderIntent>;
  /** Current provider-side state, or undefined when nothing changed / polling is not supported. */
  poll(intent: PaymentIntent, now: Date): Promise<ProviderUpdate | undefined>;
  refund(intent: PaymentIntent, refund: Refund): Promise<ProviderRefundResult>;
  parseWebhook?(rawBody: string, headers: Headers, now: Date): Promise<ProviderWebhook>;
}

/** Card providers never see card data on our side; the browser talks to the provider with `clientSecret`. */
export interface CardProvider extends PaymentProvider {
  readonly methods: readonly ['card'];
  /** Server-side confirm for flows where the client cannot (e.g. saved payment methods). */
  confirm(intent: PaymentIntent, paymentMethodToken: string): Promise<ProviderUpdate>;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
