/**
 * A fake `amqplib` with amqplib's method signatures (confirm-callback publish, `ConsumeMessage` shape,
 * `connect()` → `createConfirmChannel()`), built on the in-process broker model of `FakeAmqpChannel`.
 * Confirms are delivered asynchronously (next macrotask) so tests exercise the real ordering.
 */
import type { AmqplibConfirmChannel, AmqplibConnection, AmqplibMessage, AmqplibModule, AmqplibPublishOptions } from '../src/index.js';
import { FakeAmqpChannel } from './fake-amqp.js';

export class FakeAmqplibConfirmChannel implements AmqplibConfirmChannel {
  readonly broker = new FakeAmqpChannel();
  /** Publishes the "broker" will nack, matched by routing key. */
  nackRoutingKeys = new Set<string>();
  /** Delay (ms) before a confirm callback fires; -1 = never (simulates a hung broker). */
  confirmDelayMs = 0;
  publishCalls: Array<{ exchange: string; routingKey: string; options: AmqplibPublishOptions; hasCallback: boolean }> = [];
  prefetchCalls: Array<[number, boolean | undefined]> = [];
  ackCalls: Array<[AmqplibMessage, boolean | undefined]> = [];
  nackCalls: Array<[AmqplibMessage, boolean | undefined, boolean | undefined]> = [];
  closed = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  assertExchange(exchange: string, type: string, options?: { durable?: boolean }) {
    return this.broker.assertExchange(exchange, type).then(() => ({ exchange, ...options }));
  }
  assertQueue(queue: string, options?: { durable?: boolean; arguments?: Record<string, unknown> }) {
    return this.broker.assertQueue(queue, options).then(() => ({ queue, messageCount: 0, consumerCount: 0 }));
  }
  bindQueue(queue: string, source: string, pattern: string) {
    return this.broker.bindQueue(queue, source, pattern);
  }
  publish(exchange: string, routingKey: string, content: Buffer, options: AmqplibPublishOptions = {}, callback?: (err: Error | null, ok?: unknown) => void): boolean {
    this.publishCalls.push({ exchange, routingKey, options, hasCallback: typeof callback === 'function' });
    const nack = this.nackRoutingKeys.has(routingKey);
    if (!nack) this.broker.publish(exchange, routingKey, content, options);
    if (callback && this.confirmDelayMs >= 0) setTimeout(() => callback(nack ? new Error(`channel closed by server: PRECONDITION_FAILED on ${routingKey}`) : null, {}), this.confirmDelayMs);
    return true;
  }
  consume(queue: string, onMessage: (msg: AmqplibMessage | null) => void, _options?: { noAck?: boolean }) {
    return this.broker.consume(queue, (m) => onMessage(m as unknown as AmqplibMessage | null));
  }
  cancel(consumerTag: string) {
    return this.broker.cancel(consumerTag);
  }
  ack(message: AmqplibMessage, allUpTo?: boolean) {
    this.ackCalls.push([message, allUpTo]);
    this.broker.ack(message as never);
  }
  nack(message: AmqplibMessage, allUpTo?: boolean, requeue?: boolean) {
    this.nackCalls.push([message, allUpTo, requeue]);
    this.broker.nack(message as never, allUpTo, requeue);
  }
  async prefetch(count: number, global?: boolean) {
    this.prefetchCalls.push([count, global]);
    return this.broker.prefetch(count);
  }
  async waitForConfirms() {
    /* channel-wide wait: not used by the binding */
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

export class FakeAmqplibConnection implements AmqplibConnection {
  channels: FakeAmqplibConfirmChannel[] = [];
  closed = false;
  failChannel = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  async createConfirmChannel() {
    if (this.failChannel) throw new Error('channel refused');
    const ch = new FakeAmqplibConfirmChannel();
    this.channels.push(ch);
    return ch;
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

export function fakeAmqplib(): AmqplibModule & { connections: Array<{ url: string | Record<string, unknown>; socketOptions?: Record<string, unknown>; conn: FakeAmqplibConnection }>; failConnect?: Error } {
  const connections: Array<{ url: string | Record<string, unknown>; socketOptions?: Record<string, unknown>; conn: FakeAmqplibConnection }> = [];
  const mod = {
    connections,
    failConnect: undefined as Error | undefined,
    async connect(url: string | Record<string, unknown>, socketOptions?: Record<string, unknown>) {
      if (mod.failConnect) throw mod.failConnect;
      const conn = new FakeAmqplibConnection();
      connections.push({ url, ...(socketOptions ? { socketOptions } : {}), conn });
      return conn;
    },
  };
  return mod;
}
