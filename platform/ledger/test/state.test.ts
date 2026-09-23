import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  REFUND_STATUSES,
  REFUND_TRANSITIONS,
  assertOrderTransition,
  assertPaymentTransition,
  assertRefundTransition,
  canPaymentTransition,
} from '../src/index.js';

describe('transition tables', () => {
  it('cover every status exactly once and only reference known statuses', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
    expect(Object.keys(REFUND_TRANSITIONS).sort()).toEqual([...REFUND_STATUSES].sort());
    for (const [from, tos] of Object.entries(PAYMENT_TRANSITIONS)) {
      expect(tos).not.toContain(from); // no self transitions
      for (const to of tos) expect(PAYMENT_STATUSES).toContain(to);
    }
    for (const [from, tos] of Object.entries(ORDER_TRANSITIONS)) {
      expect(tos).not.toContain(from);
      for (const to of tos) expect(ORDER_STATUSES).toContain(to);
    }
  });

  it('terminal states have no exits', () => {
    for (const s of ['expired', 'cancelled', 'refunded'] as const) expect(ORDER_TRANSITIONS[s]).toEqual([]);
    for (const s of ['failed', 'refunded'] as const) expect(PAYMENT_TRANSITIONS[s]).toEqual([]);
    for (const s of ['completed', 'failed'] as const) expect(REFUND_TRANSITIONS[s]).toEqual([]);
  });

  it('every non-terminal status can reach paid or a terminal state', () => {
    // reachability from created
    const seen = new Set<string>();
    const stack = ['created'];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...PAYMENT_TRANSITIONS[s as keyof typeof PAYMENT_TRANSITIONS]);
    }
    expect([...seen].sort()).toEqual([...PAYMENT_STATUSES].sort());
  });

  it('illegal transitions throw a 409 with a stable code', () => {
    expect(() => assertOrderTransition('paid', 'awaiting_payment')).toThrow(LedgerError);
    try {
      assertPaymentTransition('refunded', 'paid');
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerError);
      expect((e as LedgerError).status).toBe(409);
      expect((e as LedgerError).code).toBe('illegal_transition');
      expect((e as LedgerError).message).toMatch(/refunded to paid/);
    }
    expect(() => assertRefundTransition('completed', 'pending')).toThrow(/completed to pending/);
    // @ts-expect-error unknown status
    expect(() => assertPaymentTransition('bogus', 'paid')).toThrow(/unknown/);
  });

  it.each([
    ['created', 'pending', true],
    ['created', 'paid', true],
    ['created', 'refunded', false],
    ['pending', 'underpaid', true],
    ['underpaid', 'paid', true],
    ['underpaid', 'refunded', true],
    ['paid', 'refunded', true],
    ['paid', 'pending', false],
    ['overpaid', 'refunded', true],
    ['overpaid', 'paid', false],
    ['expired', 'paid', true], // late on-chain payment
    ['expired', 'failed', false],
    ['failed', 'paid', false],
  ] as const)('payment %s -> %s allowed=%s', (from, to, allowed) => {
    expect(canPaymentTransition(from, to)).toBe(allowed);
    if (allowed) expect(() => assertPaymentTransition(from, to)).not.toThrow();
    else expect(() => assertPaymentTransition(from, to)).toThrow(LedgerError);
  });

  it('order: created -> awaiting_payment -> paid -> refunded; cancel only before paid', () => {
    expect(() => assertOrderTransition('created', 'awaiting_payment')).not.toThrow();
    expect(() => assertOrderTransition('awaiting_payment', 'paid')).not.toThrow();
    expect(() => assertOrderTransition('paid', 'refunded')).not.toThrow();
    expect(() => assertOrderTransition('paid', 'cancelled')).toThrow(LedgerError);
    expect(() => assertOrderTransition('created', 'paid')).toThrow(LedgerError); // must go through an intent
  });
});
