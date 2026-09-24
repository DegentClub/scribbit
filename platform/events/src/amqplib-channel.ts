/**
 * Binding between a real `amqplib` ConfirmChannel and the `AmqpChannel` port that `AmqpBusAdapter` uses.
 *
 * amqplib is an OPTIONAL peer dependency: this file imports nothing from it. The shapes below are the
 * subset of amqplib's public API (v0.10) the binding touches, written out structurally so the package
 * type-checks without `@types/amqplib` and so tests can pass a fake with the same method signatures.
 *
 * Why not use amqplib's channel directly (it already fits `AmqpChannel` structurally)? Two reasons:
 *   1. Confirms. amqplib's `waitForConfirms()` waits for EVERY outstanding publish on the channel, so a
 *      slow unrelated publish stalls this one. The binding uses the per-publish confirm callback and
 *      `waitForConfirms()` here resolves once the publishes made THROUGH THIS BINDING are confirmed
 *      (and rejects when the broker nacks one, which amqplib's channel-wide wait also surfaces).
 *   2. Lifecycle. `connectAmqpBus()` owns connect → confirm channel → adapter → close, and lazily
 *      imports amqplib so consumers that only use the in-memory bus never load it.
 */
import { AmqpBusAdapter, type AmqpBusOptions, type AmqpChannel, type AmqpMessage, type AmqpPublishOptions } from './amqp.js';

/** amqplib `ConsumeMessage`. */
export interface AmqplibMessage {
  content: Buffer;
  fields: { consumerTag?: string; deliveryTag: number; redelivered: boolean; exchange: string; routingKey: string };
  properties: {
    contentType?: string;
    contentEncoding?: string;
    headers?: Record<string, unknown>;
    deliveryMode?: number;
    priority?: number;
    correlationId?: string;
    replyTo?: string;
    expiration?: string;
    messageId?: string;
    timestamp?: number;
    type?: string;
    userId?: string;
    appId?: string;
    clusterId?: string;
  };
}

/** amqplib `Options.Publish` (the fields we use). */
export interface AmqplibPublishOptions extends AmqpPublishOptions {
  deliveryMode?: number;
}

/** The subset of amqplib's `ConfirmChannel` this binding uses, with amqplib's exact signatures. */
export interface AmqplibConfirmChannel {
  assertExchange(exchange: string, type: string, options?: { durable?: boolean }): Promise<{ exchange: string }>;
  assertQueue(queue: string, options?: { durable?: boolean; arguments?: Record<string, unknown> }): Promise<{ queue: string; messageCount: number; consumerCount: number }>;
  bindQueue(queue: string, source: string, pattern: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Confirm-channel publish: `callback(err, ok)` fires when the broker acks (err = null) or nacks (err set). */
  publish(exchange: string, routingKey: string, content: Buffer, options?: AmqplibPublishOptions, callback?: (err: Error | null, ok?: unknown) => void): boolean;
  consume(queue: string, onMessage: (msg: AmqplibMessage | null) => void, options?: { noAck?: boolean }): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  ack(message: AmqplibMessage, allUpTo?: boolean): void;
  nack(message: AmqplibMessage, allUpTo?: boolean, requeue?: boolean): void;
  prefetch(count: number, global?: boolean): Promise<unknown>;
  waitForConfirms(): Promise<void>;
  close(): Promise<void>;
  on?(event: 'close' | 'error' | 'return' | 'drain', listener: (...args: unknown[]) => void): unknown;
}

/** amqplib `ChannelModel` (what `amqplib.connect()` resolves to). */
export interface AmqplibConnection {
  createConfirmChannel(): Promise<AmqplibConfirmChannel>;
  close(): Promise<void>;
  on(event: 'close' | 'error' | 'blocked' | 'unblocked', listener: (...args: unknown[]) => void): unknown;
}

/** The `amqplib` module surface used by `connectAmqpBus`. */
export interface AmqplibModule {
  connect(url: string | Record<string, unknown>, socketOptions?: Record<string, unknown>): Promise<AmqplibConnection>;
}

export interface AmqplibChannelOptions {
  /** Called when the broker nacks a publish (the message was not persisted). `waitForConfirms()` also rejects. */
  onNack?: (info: { exchange: string; routingKey: string; messageId?: string; error: Error }) => void;
}

/**
 * Adapt an amqplib ConfirmChannel to `AmqpChannel`. Messages, acks and nacks pass through untouched (an
 * amqplib message already has `{ content, fields, properties }`); `publish` records a confirm promise per
 * message; `waitForConfirms` awaits the confirms outstanding at the time of the call.
 */
export function amqplibChannel(ch: AmqplibConfirmChannel, opts: AmqplibChannelOptions = {}): AmqpChannel {
  const pending = new Set<Promise<void>>();

  return {
    assertExchange: (exchange, type, options) => ch.assertExchange(exchange, type, options),
    assertQueue: (queue, options) => ch.assertQueue(queue, options),
    bindQueue: (queue, source, pattern) => ch.bindQueue(queue, source, pattern),
    prefetch: (count) => ch.prefetch(count, false),
    cancel: (tag) => ch.cancel(tag),
    ack: (m) => ch.ack(m as AmqplibMessage),
    nack: (m, allUpTo = false, requeue = false) => ch.nack(m as AmqplibMessage, allUpTo, requeue),

    publish(exchange, routingKey, content, options = {}) {
      let done!: () => void;
      let fail!: (e: Error) => void;
      const p = new Promise<void>((resolve, reject) => {
        done = resolve;
        fail = reject;
      });
      p.catch(() => undefined); // observed via waitForConfirms; avoid unhandled rejection when nobody waits
      pending.add(p);
      const settle = () => pending.delete(p);
      const ok = ch.publish(exchange, routingKey, content, { ...options, ...(options.persistent ? { deliveryMode: 2 } : {}) }, (err) => {
        settle();
        if (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          opts.onNack?.({ exchange, routingKey, messageId: options.messageId, error });
          fail(error);
        } else done();
      });
      return ok;
    },

    async waitForConfirms() {
      await Promise.all([...pending]);
    },

    async consume(queue, onMessage, options) {
      return ch.consume(queue, (m) => onMessage(m as AmqpMessage | null), options);
    },
  };
}

export interface ConnectAmqpBusOptions extends Omit<AmqpBusOptions, 'channel'> {
  /** `amqp://user:pass@host:5672/vhost` (or amqps://). */
  url: string;
  /** Passed to `amqplib.connect(url, socketOptions)`: TLS options, `clientProperties`, `heartbeat` etc. */
  socketOptions?: Record<string, unknown>;
  /** Injected module (tests, or a pre-loaded amqplib). Default: `await import('amqplib')`. */
  amqplib?: AmqplibModule;
  /** Connection or channel closed by the broker / network. Default: nothing (the caller usually exits). */
  onClose?: (info: { what: 'connection' | 'channel'; error?: unknown }) => void;
  onNack?: AmqplibChannelOptions['onNack'];
}

export interface ConnectedAmqpBus {
  bus: AmqpBusAdapter;
  connection: AmqplibConnection;
  channel: AmqplibConfirmChannel;
  /** Stop retries, close the channel, then the connection. Unacked messages are redelivered by the broker. */
  close(): Promise<void>;
}

async function loadAmqplib(): Promise<AmqplibModule> {
  const specifier = 'amqplib'; // variable so bundlers and TypeScript do not resolve the optional dependency
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (e) {
    throw new Error('connectAmqpBus needs the optional peer dependency "amqplib" (pnpm add amqplib) — or pass options.amqplib', { cause: e });
  }
  const m = mod as { connect?: unknown; default?: { connect?: unknown } };
  const connect = typeof m.connect === 'function' ? m.connect : typeof m.default?.connect === 'function' ? m.default.connect : undefined;
  if (!connect) throw new Error('the loaded "amqplib" module has no connect()');
  return { connect: connect as AmqplibModule['connect'] };
}

/**
 * Connect to RabbitMQ and return an initialised `AmqpBusAdapter`:
 *
 *   const { bus, close } = await connectAmqpBus({ url: process.env.AMQP_URL!, service: 'degent-mint', registry: platformRegistry() });
 *   process.on('SIGTERM', () => close().then(() => process.exit(0)));
 *
 * The connection's `close`/`error` events call `onClose`; the recommended reaction is to exit and let the
 * supervisor restart the process (unacked messages are redelivered).
 */
export async function connectAmqpBus(opts: ConnectAmqpBusOptions): Promise<ConnectedAmqpBus> {
  const { url, socketOptions, amqplib, onClose, onNack, ...busOptions } = opts;
  const lib = amqplib ?? (await loadAmqplib());
  const connection = await lib.connect(url, socketOptions);
  let closing = false;
  connection.on('error', (error) => onClose?.({ what: 'connection', error }));
  connection.on('close', (error) => {
    if (!closing) onClose?.({ what: 'connection', ...(error !== undefined ? { error } : {}) });
  });

  let channel: AmqplibConfirmChannel;
  try {
    channel = await connection.createConfirmChannel();
  } catch (e) {
    await connection.close().catch(() => undefined);
    throw e;
  }
  channel.on?.('error', (error) => onClose?.({ what: 'channel', error }));
  channel.on?.('close', () => {
    if (!closing) onClose?.({ what: 'channel' });
  });

  const bus = new AmqpBusAdapter({ ...busOptions, channel: amqplibChannel(channel, onNack ? { onNack } : {}) });
  try {
    await bus.init();
  } catch (e) {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
    throw e;
  }

  return {
    bus,
    connection,
    channel,
    async close() {
      if (closing) return;
      closing = true;
      await bus.close();
      await channel.close().catch(() => undefined);
      await connection.close();
    },
  };
}
