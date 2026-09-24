import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_HEADER,
  AmqpBusAdapter,
  ManualClock,
  NonRetryableError,
  amqplibChannel,
  blockIndexed,
  connectAmqpBus,
  platformRegistry,
  subscribeTopic,
  type EventEnvelope,
} from '../src/index.js';
import { FakeAmqplibConfirmChannel, fakeAmqplib } from './fake-amqplib.js';

const block = (height: number) =>
  blockIndexed.create({
    source: 'urn:bsh:bitcoin-indexer',
    params: { network: 'signet' },
    data: { network: 'signet', height, hash: 'a'.repeat(64), previousHash: 'b'.repeat(64), time: '2026-09-23T12:00:00Z' },
  });

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('amqplibChannel binding', () => {
  it('publishes through the confirm callback with deliveryMode 2 and resolves waitForConfirms on ack', async () => {
    const raw = new FakeAmqplibConfirmChannel();
    const ch = amqplibChannel(raw);
    const ok = ch.publish('bsh.events', 'block.indexed.signet', Buffer.from('{}'), { persistent: true, messageId: 'm1', contentType: 'application/cloudevents+json' });
    expect(ok).toBe(true);
    expect(raw.publishCalls[0]).toMatchObject({ exchange: 'bsh.events', routingKey: 'block.indexed.signet', hasCallback: true, options: { persistent: true, deliveryMode: 2, messageId: 'm1' } });
    await expect(ch.waitForConfirms!()).resolves.toBeUndefined();
  });

  it('waitForConfirms rejects when the broker nacks, and reports it via onNack', async () => {
    const raw = new FakeAmqplibConfirmChannel();
    raw.nackRoutingKeys.add('bad.key');
    const nacks: string[] = [];
    const ch = amqplibChannel(raw, { onNack: (i) => nacks.push(`${i.routingKey}:${i.messageId}`) });
    ch.publish('bsh.events', 'bad.key', Buffer.from('{}'), { messageId: 'm2' });
    await expect(ch.waitForConfirms!()).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(nacks).toEqual(['bad.key:m2']);
    // A later wait with nothing outstanding resolves: the failed confirm is not sticky.
    await expect(ch.waitForConfirms!()).resolves.toBeUndefined();
  });

  it('waits only for the publishes made through this binding that are still outstanding', async () => {
    const raw = new FakeAmqplibConfirmChannel();
    raw.confirmDelayMs = 20;
    const ch = amqplibChannel(raw);
    ch.publish('bsh.events', 'a', Buffer.from('1'));
    const first = ch.waitForConfirms!();
    let firstDone = false;
    void first.then(() => (firstDone = true));
    await tick();
    expect(firstDone).toBe(false);
    raw.confirmDelayMs = 1_000;
    ch.publish('bsh.events', 'b', Buffer.from('2')); // slow, unrelated publish
    await first; // resolves after ~20ms regardless of the slow one
    expect(firstDone).toBe(true);
  });

  it('a publish nobody waits for does not cause an unhandled rejection', async () => {
    const raw = new FakeAmqplibConfirmChannel();
    raw.nackRoutingKeys.add('x');
    const ch = amqplibChannel(raw);
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', h);
    try {
      ch.publish('bsh.events', 'x', Buffer.from('{}'));
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', h);
    }
    expect(unhandled).toEqual([]);
  });

  it('passes prefetch, consume, ack and nack through with amqplib signatures', async () => {
    const raw = new FakeAmqplibConfirmChannel();
    const ch = amqplibChannel(raw);
    await ch.prefetch!(7);
    expect(raw.prefetchCalls).toEqual([[7, false]]);
    await ch.assertExchange('ex', 'topic', { durable: true });
    await ch.assertQueue('q', { durable: true });
    await ch.bindQueue('q', 'ex', 'a.#');
    const seen: unknown[] = [];
    const { consumerTag } = await ch.consume('q', (m) => seen.push(m), { noAck: false });
    expect(consumerTag).toMatch(/^ctag-/);
    ch.publish('ex', 'a.b', Buffer.from('hi'), { messageId: 'id' });
    await ch.waitForConfirms!();
    expect(seen).toHaveLength(1);
    const msg = seen[0] as { content: Buffer; fields: { routingKey: string }; properties: { messageId: string } };
    expect(msg.content.toString()).toBe('hi');
    expect(msg.fields.routingKey).toBe('a.b');
    expect(msg.properties.messageId).toBe('id');
    ch.ack(msg as never);
    expect(raw.ackCalls).toHaveLength(1);
    ch.nack(msg as never); // binding default: not allUpTo, not requeue (dead-letter semantics)
    expect(raw.nackCalls[0]!.slice(1)).toEqual([false, false]);
    ch.nack(msg as never, false, true);
    expect(raw.nackCalls[1]!.slice(1)).toEqual([false, true]);
    await ch.cancel(consumerTag);
  });
});

describe('AmqpBusAdapter over the amqplib binding (end to end against the fake broker)', () => {
  function setup() {
    const raw = new FakeAmqplibConfirmChannel();
    const clock = new ManualClock();
    const bus = new AmqpBusAdapter({ channel: amqplibChannel(raw), service: 'svc', registry: platformRegistry(), clock, defaultMaxAttempts: 2, defaultBackoff: { initialMs: 10, factor: 2, maxMs: 100 } });
    return { raw, clock, bus };
  }

  it('delivers, acks after a successful handler, and republishes with x-bsh-attempt on failure', async () => {
    const { raw, clock, bus } = setup();
    const got: EventEnvelope[] = [];
    let fails = 1;
    await subscribeTopic(bus, blockIndexed, async (e) => {
      if (fails-- > 0) throw new Error('flaky');
      got.push(e);
    }, { name: 'svc.blocks' });
    const e = block(1);
    await bus.publish(e);
    expect(raw.publishCalls.map((p) => [p.exchange, p.routingKey])).toEqual([['bsh.events', 'block.indexed.signet']]);
    clock.advance(10); // retry timer fires: republish via default exchange
    await tick();
    expect(raw.publishCalls[1]).toMatchObject({ exchange: '', routingKey: 'svc.blocks', options: { headers: { [ATTEMPT_HEADER]: 2 }, deliveryMode: 2 } });
    await tick();
    expect(got.map((x) => x.id)).toEqual([e.id]);
    expect(raw.ackCalls).toHaveLength(2); // original (after the republish confirmed) + the retry
  });

  it('NonRetryableError nacks without requeue so the broker dead-letters to <queue>.dlq', async () => {
    const { raw, bus } = setup();
    await subscribeTopic(bus, blockIndexed, async () => {
      throw new NonRetryableError('poison');
    }, { name: 'svc.blocks' });
    await bus.publish(block(2));
    await tick();
    expect(raw.nackCalls[0]!.slice(1)).toEqual([false, false]);
    expect(raw.broker.depth('svc.blocks.dlq')).toHaveLength(1);
  });
});

describe('connectAmqpBus', () => {
  it('connects, opens a confirm channel, declares topology and returns a working bus', async () => {
    const lib = fakeAmqplib();
    const closes: unknown[] = [];
    const { bus, connection, channel, close } = await connectAmqpBus({
      url: 'amqp://guest:guest@rabbit:5672/bsh',
      socketOptions: { heartbeat: 30 },
      service: 'degent-mint',
      exchange: 'bsh.test',
      registry: platformRegistry(),
      amqplib: lib,
      onClose: (i) => closes.push(i),
    });
    expect(lib.connections[0]).toMatchObject({ url: 'amqp://guest:guest@rabbit:5672/bsh', socketOptions: { heartbeat: 30 } });
    const raw = channel as FakeAmqplibConfirmChannel;
    expect(raw.broker.exchanges).toEqual(new Map([['bsh.test', 'topic'], ['bsh.test.dlx', 'direct']]));
    expect(raw.prefetchCalls).toEqual([[16, false]]);

    const got: number[] = [];
    await subscribeTopic(bus, blockIndexed, async (e) => void got.push(e.data.height));
    await bus.publish(block(3));
    await tick();
    expect(got).toEqual([3]);
    expect(raw.broker.queues.has('degent-mint.block.indexed.any')).toBe(true);

    await close();
    expect(raw.closed).toBe(true);
    expect((connection as unknown as { closed: boolean }).closed).toBe(true);
    expect(closes).toEqual([]); // a deliberate close is not reported
    await close(); // idempotent
  });

  it('reports broker-initiated connection and channel closes', async () => {
    const lib = fakeAmqplib();
    const closes: unknown[] = [];
    const { connection, channel } = await connectAmqpBus({ url: 'amqp://x', service: 's', amqplib: lib, onClose: (i) => closes.push(i) });
    (channel as FakeAmqplibConfirmChannel).emit('error', new Error('channel boom'));
    (channel as FakeAmqplibConfirmChannel).emit('close');
    (connection as unknown as { emit(e: string, ...a: unknown[]): void }).emit('error', new Error('conn boom'));
    (connection as unknown as { emit(e: string, ...a: unknown[]): void }).emit('close', new Error('lost'));
    expect(closes).toEqual([
      { what: 'channel', error: new Error('channel boom') },
      { what: 'channel' },
      { what: 'connection', error: new Error('conn boom') },
      { what: 'connection', error: new Error('lost') },
    ]);
  });

  it('cleans up the connection when the channel cannot be opened, and propagates connect failures', async () => {
    const lib = fakeAmqplib();
    lib.failConnect = new Error('ECONNREFUSED');
    await expect(connectAmqpBus({ url: 'amqp://x', service: 's', amqplib: lib })).rejects.toThrow('ECONNREFUSED');

    const lib2 = fakeAmqplib();
    const origConnect = lib2.connect.bind(lib2);
    lib2.connect = async (...a) => {
      const c = await origConnect(...a);
      (c as unknown as { failChannel: boolean }).failChannel = true;
      return c;
    };
    await expect(connectAmqpBus({ url: 'amqp://x', service: 's', amqplib: lib2 })).rejects.toThrow('channel refused');
    expect(lib2.connections[0]!.conn.closed).toBe(true);
  });

  it('without an injected module it lazily imports amqplib (and explains when it is missing)', async () => {
    // amqplib is an optional peer dependency. When another workspace package has it installed the real module
    // loads and fails at the network; otherwise the binding names the missing dependency.
    const err = await connectAmqpBus({ url: 'amqp://127.0.0.1:1', service: 's', socketOptions: { timeout: 200 } }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/optional peer dependency "amqplib"|ECONNREFUSED|ENOTFOUND|connect|timeout/i);
  });
});
