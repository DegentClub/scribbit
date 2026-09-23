import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATH, ledgerOrderStatus, ledgerPaymentStatus, validate } from '@bsh/events';
import { LEDGER_ORDER_STATUSES, LEDGER_PAYMENT_STATUSES } from '@bsh/events';
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, PRODUCTS } from '../src/index.js';
import { ASYNCAPI_PATH, asyncapi, repoRoot } from './contract.js';

type Any = any;
const platform: Any = parse(readFileSync(`${repoRoot}${CONTRACT_PATH}`, 'utf8'));
const topics = [ledgerOrderStatus, ledgerPaymentStatus];

describe(`${ASYNCAPI_PATH} ↔ platform-events.yaml ↔ @bsh/events registry`, () => {
  it('the ledger domain enums are the registry enums', () => {
    expect([...ORDER_STATUSES]).toEqual([...LEDGER_ORDER_STATUSES]);
    expect([...PAYMENT_STATUSES]).toEqual([...LEDGER_PAYMENT_STATUSES]);
    expect(ledgerPaymentStatus.schema.properties!.method!.enum).toEqual([...PAYMENT_METHODS]);
    expect(ledgerPaymentStatus.schema.properties!.product!.enum).toEqual([...PRODUCTS]);
  });

  it.each(topics.map((t) => [t.name, t] as const))('%s: the ledger contract mirrors the canonical channel', (_n, topic) => {
    const mine = Object.values<Any>(asyncapi.channels).find((c) => c.address === topic.name);
    const canonical = Object.values<Any>(platform.channels).find((c) => c.address === topic.name);
    expect(mine, 'channel in ledger.yaml').toBeDefined();
    expect(canonical, 'channel in platform-events.yaml').toBeDefined();
    expect(mine.description).toBe(topic.description);
    expect(mine.parameters.status.enum).toEqual([...topic.params.status!.enum!]);
    const msgName = Object.keys(mine.messages)[0]!;
    const msg = asyncapi.components.messages[msgName];
    expect(msg['x-topic-version']).toBe(topic.version);
    expect(msg['x-producer']).toBe(topic.producer);
    const schemaName = msg.payload.allOf[1].properties.data.$ref.replace('#/components/schemas/', '');
    expect(asyncapi.components.schemas[schemaName]).toEqual(JSON.parse(JSON.stringify(topic.schema)));
    expect(platform.components.schemas[schemaName]).toEqual(asyncapi.components.schemas[schemaName]);
  });

  it('example payloads validate against both files', () => {
    const order = { orderId: 'ord_1', product: 'scribbit', customerRef: 'u', status: 'paid', previousStatus: 'awaiting_payment', currency: 'sat', totalSats: 1, at: '2026-09-23T12:00:00Z' };
    expect(validate(asyncapi.components.schemas.LedgerOrderStatusChanged, order).valid).toBe(true);
    expect(validate(asyncapi.components.schemas.LedgerOrderStatusChanged, { ...order, currency: 'usd' }).valid).toBe(false);
    const payment = { paymentId: 'pay_1', orderId: 'ord_1', product: 'degent', method: 'card', provider: 'card', status: 'paid', previousStatus: null, amountSats: 5, amountPaidSats: 5, at: '2026-09-23T12:00:00Z' };
    expect(validate(asyncapi.components.schemas.LedgerPaymentStatusChanged, payment).valid).toBe(true);
    expect(validate(asyncapi.components.schemas.LedgerPaymentStatusChanged, { ...payment, amountSats: -1 }).valid).toBe(false);
  });
});
