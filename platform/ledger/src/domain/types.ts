/**
 * Ledger domain. Money is always integer satoshis (`currency: 'sat'`); card payments are priced in sats and
 * settled in fiat by the card provider, the fiat side is recorded in `PaymentIntent.providerData`.
 */

export const PRODUCTS = ['blockspace', 'scribbit', 'degent'] as const;
export type Product = (typeof PRODUCTS)[number];

export const ORDER_STATUSES = ['created', 'awaiting_payment', 'paid', 'expired', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['onchain', 'lightning', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['created', 'pending', 'paid', 'underpaid', 'overpaid', 'expired', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ['pending', 'completed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export interface LineItem {
  sku: string;
  description: string;
  quantity: number;
  /** Price per unit in satoshis. */
  unitSats: number;
}

export interface Order {
  id: string;
  product: Product;
  /** Opaque customer reference owned by the product (user id, wallet address, e-mail hash…). Never PII by contract. */
  customerRef: string;
  lineItems: LineItem[];
  currency: 'sat';
  totalSats: number;
  status: OrderStatus;
  metadata: Record<string, string>;
  /** Optimistic-concurrency version, bumped on every write. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** What a customer needs to pay: exactly one of the fields is set per method. Nothing here is a secret. */
export interface CheckoutDetails {
  /** onchain: the payment address (fresh per intent). */
  address?: string;
  /** lightning: BOLT11 invoice. */
  bolt11?: string;
  /** Hosted checkout page (BTCPay invoice page or card checkout). */
  checkoutUrl?: string;
  /** card: token the browser hands to the provider's client SDK. Never a card number. */
  clientSecret?: string;
}

export interface PaymentIntent {
  id: string;
  orderId: string;
  product: Product;
  method: PaymentMethod;
  /** Provider adapter name (`onchain`, `btcpay`, `card`, `fake`). */
  provider: string;
  /** Provider-side identifier (BTCPay invoice id, card provider intent id, on-chain address). */
  providerRef: string;
  amountSats: number;
  /** Satoshis the provider has credited so far (confirmed per policy). */
  amountPaidSats: number;
  /** Satoshis refunded so far (sum of completed refunds). */
  refundedSats: number;
  status: PaymentStatus;
  checkout: CheckoutDetails;
  expiresAt: string | null;
  paidAt: string | null;
  txid?: string;
  preimage?: string;
  /** Provider-specific bookkeeping (fiat amount, address index…). Never card data. */
  providerData: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Refund {
  id: string;
  paymentId: string;
  orderId: string;
  amountSats: number;
  status: RefundStatus;
  reason: string;
  /** Provider-side reference (BTCPay pull payment id, card refund id) or null when settled manually. */
  providerRef: string | null;
  /** Where the money goes back to (on-chain address / bolt11) when the customer must supply one. */
  destination: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set(['failed', 'refunded']);
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ['created', 'pending', 'underpaid'];
