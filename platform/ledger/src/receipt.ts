import type { Order, Payee, PaymentIntent, Payout, Refund } from './domain/types.js';
import { satsToBtc } from './money.js';

export interface ReceiptPayment {
  id: string;
  method: PaymentIntent['method'];
  provider: string;
  status: PaymentIntent['status'];
  amountSats: number;
  amountPaidSats: number;
  refundedSats: number;
  paidAt: string | null;
  txid?: string;
  /** Provider-side reference (address, invoice id, card intent id): useful on a receipt, never secret. */
  reference: string;
}

export interface Receipt {
  receiptId: string;
  issuedAt: string;
  order: Pick<Order, 'id' | 'product' | 'customerRef' | 'status' | 'currency' | 'totalSats' | 'lineItems' | 'createdAt' | 'metadata'>;
  payments: ReceiptPayment[];
  refunds: Array<Pick<Refund, 'id' | 'paymentId' | 'amountSats' | 'status' | 'reason' | 'createdAt'>>;
  /** Payee payouts found in the settling transaction(s) (psbt). */
  payouts: ReceiptPayout[];
  totals: { totalSats: number; paidSats: number; refundedSats: number; dueSats: number };
}

export interface ReceiptPayout {
  id: string;
  paymentId: string;
  payee: Payee;
  amountSats: number;
  txid: string;
  vout: number;
  status: Payout['status'];
}

/** Receipts are pure projections of ledger state: the same input always renders the same receipt. */
export function buildReceipt(order: Order, payments: readonly PaymentIntent[], refunds: readonly Refund[], issuedAt: string, payouts: readonly Payout[] = []): Receipt {
  const paidSats = payments.reduce((s, p) => s + p.amountPaidSats, 0);
  const refundedSats = payments.reduce((s, p) => s + p.refundedSats, 0);
  return {
    receiptId: `rcpt_${order.id.replace(/^ord_/, '')}`,
    issuedAt,
    order: {
      id: order.id,
      product: order.product,
      customerRef: order.customerRef,
      status: order.status,
      currency: order.currency,
      totalSats: order.totalSats,
      lineItems: order.lineItems,
      createdAt: order.createdAt,
      metadata: order.metadata,
    },
    payments: payments.map((p) => {
      const r: ReceiptPayment = {
        id: p.id,
        method: p.method,
        provider: p.provider,
        status: p.status,
        amountSats: p.amountSats,
        amountPaidSats: p.amountPaidSats,
        refundedSats: p.refundedSats,
        paidAt: p.paidAt,
        reference: p.providerRef,
      };
      if (p.txid) r.txid = p.txid;
      return r;
    }),
    refunds: refunds.map((r) => ({ id: r.id, paymentId: r.paymentId, amountSats: r.amountSats, status: r.status, reason: r.reason, createdAt: r.createdAt })),
    payouts: payouts.map((p) => ({ id: p.id, paymentId: p.paymentId, payee: { ...p.payee }, amountSats: p.amountSats, txid: p.txid, vout: p.vout, status: p.status })),
    totals: { totalSats: order.totalSats, paidSats, refundedSats, dueSats: Math.max(0, order.totalSats - paidSats + refundedSats) },
  };
}

const fmt = (sats: number): string => `${sats.toLocaleString('en-US')} sat (${satsToBtc(sats)} BTC)`;

/** Plain-text receipt (fixed width, 72 columns, ASCII only). */
export function renderReceiptText(r: Receipt): string {
  const line = '-'.repeat(72);
  const out: string[] = [];
  out.push(`RECEIPT ${r.receiptId}`, `Issued   ${r.issuedAt}`, `Order    ${r.order.id}  (${r.order.product})`, `Customer ${r.order.customerRef}`, `Status   ${r.order.status}`, line);
  for (const li of r.order.lineItems) {
    const label = `${li.quantity} x ${li.description} [${li.sku}]`;
    out.push(`${label.padEnd(48).slice(0, 48)} ${String(li.quantity * li.unitSats).padStart(20)} sat`);
  }
  out.push(line, `${'TOTAL'.padEnd(48)} ${String(r.totals.totalSats).padStart(20)} sat`);
  if (r.payments.length) {
    out.push('', 'Payments');
    for (const p of r.payments) {
      out.push(`  ${p.id}  ${p.method}/${p.provider}  ${p.status}  ${fmt(p.amountPaidSats)}${p.paidAt ? `  at ${p.paidAt}` : ''}`);
      if (p.txid) out.push(`    txid ${p.txid}`);
      out.push(`    ref  ${p.reference}`);
    }
  }
  if (r.refunds.length) {
    out.push('', 'Refunds');
    for (const x of r.refunds) out.push(`  ${x.id}  ${x.status}  ${fmt(x.amountSats)}  ${x.reason}`);
  }
  if (r.payouts.length) {
    out.push('', 'Payouts');
    for (const x of r.payouts) {
      out.push(`  ${x.id}  ${x.status}  ${fmt(x.amountSats)}  to ${x.payee.kind}:${x.payee.ref}`);
      out.push(`    txid ${x.txid}:${x.vout}`);
    }
  }
  out.push('', line, `Paid     ${fmt(r.totals.paidSats)}`, `Refunded ${fmt(r.totals.refundedSats)}`, `Due      ${fmt(r.totals.dueSats)}`, '');
  return out.join('\n');
}
