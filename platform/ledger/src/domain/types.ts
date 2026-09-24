/**
 * Ledger domain. Money is always integer satoshis (`currency: 'sat'`); card payments are priced in sats and
 * settled in fiat by the card provider, the fiat side is recorded in `PaymentIntent.providerData`.
 */

export const PRODUCTS = ['blockspace', 'scribbit', 'degent'] as const;
export type Product = (typeof PRODUCTS)[number];

export const ORDER_STATUSES = ['created', 'awaiting_payment', 'paid', 'expired', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** `psbt` (1.1): the customer signs a PSBT the product builds; the ledger checks the settling transaction's outputs. */
export const PAYMENT_METHODS = ['onchain', 'lightning', 'card', 'psbt'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['created', 'pending', 'paid', 'underpaid', 'overpaid', 'expired', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ['pending', 'completed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const PAYEE_KINDS = ['artist', 'club', 'platform', 'other'] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

/**
 * Who a line item's money goes to. Exactly one of `address` / `scriptHex` is set. The ledger matches transaction
 * outputs by scriptPubKey, never by address string (an address is decoded to its script at intent creation).
 */
export interface Payee {
  kind: PayeeKind;
  /** Opaque payee reference owned by the product (artist id, club slug...). Never PII. 1..128 chars. */
  ref: string;
  address?: string;
  /** scriptPubKey, lowercase hex. */
  scriptHex?: string;
}

export interface LineItem {
  sku: string;
  description: string;
  quantity: number;
  /** Price per unit in satoshis. */
  unitSats: number;
  /** Who receives this line's money (required on every line for `psbt` payments). */
  payee?: Payee;
}

/** An output the paying transaction must carry (`psbt`): the line items paying one script, summed. */
export interface ExpectedOutput {
  scriptHex: string;
  valueSats: number;
  /** The payee address when one was given (informational; matching uses `scriptHex`). */
  address?: string;
  payee: Payee;
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
  /** psbt: the outputs the product's PSBT must carry (one per payee script). */
  outputs?: ExpectedOutput[];
}

export interface PaymentIntent {
  id: string;
  orderId: string;
  product: Product;
  method: PaymentMethod;
  /** Provider adapter name (`onchain`, `btcpay`, `card`, `psbt`, `fake`). */
  provider: string;
  /** Provider-side identifier (BTCPay invoice id, card provider intent id, on-chain address, psbt: the intent id). */
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
  /** Optimistic-concurrency version, bumped on every write. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const PAYOUT_STATUSES = ['settled', 'pending', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Money that reached a payee in the transaction settling a payment (one record per payee output found). The
 * ledger records payouts, it never moves them: the customer's own transaction paid the payee directly.
 */
export interface Payout {
  id: string;
  orderId: string;
  paymentId: string;
  product: Product;
  payee: Payee;
  amountSats: number;
  txid: string;
  vout: number;
  status: PayoutStatus;
  settledAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Statuses in which an intent's `txid` is a claim on that transaction (psbt: one transaction settles one intent). */
export const TXID_CLAIMING_STATUSES: ReadonlySet<PaymentStatus> = new Set(['pending', 'paid', 'underpaid', 'overpaid', 'refunded']);
export const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set(['failed', 'refunded']);
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ['created', 'pending', 'underpaid'];
