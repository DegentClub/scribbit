import type { OrderStatus, PaymentStatus, PayoutStatus, RefundStatus } from './types.js';
import { LedgerError } from './errors.js';

/**
 * Explicit transition tables. Anything not listed is illegal and throws `illegal_transition`.
 * A "transition" to the current status is not a transition (callers treat it as an idempotent no-op).
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['awaiting_payment', 'cancelled', 'expired'],
  awaiting_payment: ['paid', 'cancelled', 'expired'],
  paid: ['refunded'],
  expired: [],
  cancelled: [],
  refunded: [],
};

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['pending', 'paid', 'underpaid', 'overpaid', 'expired', 'failed'],
  pending: ['paid', 'underpaid', 'overpaid', 'expired', 'failed'],
  // partial funds present; a top-up completes it, a refund returns it
  underpaid: ['pending', 'paid', 'overpaid', 'refunded', 'failed'],
  paid: ['refunded'],
  overpaid: ['refunded'],
  // funds can still arrive on chain after the timer ran out (BTCPay: Expired + PaidLate)
  expired: ['pending', 'paid', 'underpaid', 'overpaid'],
  failed: [],
  refunded: [],
};

export const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  pending: ['settled', 'failed'],
  settled: [],
  failed: [],
};

function assertTransition<S extends string>(table: Readonly<Record<S, readonly S[]>>, kind: string, from: S, to: S): void {
  const allowed = table[from];
  if (!allowed) throw new LedgerError(400, 'invalid_status', `${kind} status "${from}" is unknown`);
  if (!allowed.includes(to)) throw new LedgerError(409, 'illegal_transition', `${kind} cannot go from ${from} to ${to}`);
}

export const assertOrderTransition = (from: OrderStatus, to: OrderStatus): void => assertTransition(ORDER_TRANSITIONS, 'order', from, to);
export const assertPaymentTransition = (from: PaymentStatus, to: PaymentStatus): void => assertTransition(PAYMENT_TRANSITIONS, 'payment', from, to);
export const assertRefundTransition = (from: RefundStatus, to: RefundStatus): void => assertTransition(REFUND_TRANSITIONS, 'refund', from, to);
export const assertPayoutTransition = (from: PayoutStatus, to: PayoutStatus): void => assertTransition(PAYOUT_TRANSITIONS, 'payout', from, to);

export const canOrderTransition = (from: OrderStatus, to: OrderStatus): boolean => ORDER_TRANSITIONS[from]?.includes(to) ?? false;
export const canPaymentTransition = (from: PaymentStatus, to: PaymentStatus): boolean => PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;
