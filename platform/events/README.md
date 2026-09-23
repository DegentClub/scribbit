# @bsh/events

Typed platform events for block.space, scribb.it and degent.club: a CloudEvents 1.0 envelope, a versioned topic
registry with JSON Schema validation, an `EventBus` with AMQP topic-exchange semantics, a transactional outbox and
a RabbitMQ adapter. Zero runtime dependencies. The shared contract is
[`contracts/asyncapi/platform-events.yaml`](../../contracts/asyncapi/platform-events.yaml).

```ts
import { blockIndexed, InMemoryBus, platformRegistry, subscribeTopic, idempotent, sourceFor } from '@bsh/events';

const bus = new InMemoryBus({ registry: platformRegistry() });           // AmqpBusAdapter in production
await subscribeTopic(bus, blockIndexed, idempotent(async (e) => {       // e.data: BlockIndexed
  console.log(e.data.network, e.data.height);
}), { name: 'blockspace-meter.blocks' });

await bus.publish(blockIndexed.create({
  source: sourceFor('bitcoin-indexer'), params: { network: 'mainnet' },
  data: { network: 'mainnet', height: 900000, hash, previousHash, time },  // validated against the schema
}));
```

## Pieces

| Module | What |
|---|---|
| `envelope.ts` | `EventEnvelope<T>`, `createEvent()`, `assertEnvelope()` (wire checks) |
| `schema.ts` | Dependency-free JSON Schema subset validator (type, enum, const, properties, required, additionalProperties, items, min/max*, pattern, format date-time/uri/uuid, allOf/anyOf/oneOf, `#/$defs` refs). Contracts must stay inside this subset |
| `topics.ts` | `defineTopic()`, `TopicRegistry` (resolve, validate), `detectBreakingChanges()`, `assertCompatibleEvolution()` |
| `platform-topics.ts` | The registered platform topics, mirrored by the AsyncAPI file |
| `match.ts` | AMQP matching: `*` = exactly one word, `#` = zero or more; `{param}` templates bind as `*` |
| `bus.ts` | `EventBus` port, `subscribeTopic()`, `idempotent()` + `DedupeStore`, `NonRetryableError` |
| `in-memory-bus.ts` | `InMemoryBus` for dev/tests: per-subscription retry with backoff, dead letters, `redrive()` |
| `outbox.ts` | `OutboxPublisher` + `OutboxStore` port + `InMemoryOutboxStore` |
| `amqp.ts` | `AmqpBusAdapter` over the injectable `AmqpChannel` (an amqplib `ConfirmChannel` fits) |
| `clock.ts`, `backoff.ts` | `Clock` port, `ManualClock` fake for deterministic tests, exponential backoff with jitter |

## Topics and versioning

| Topic | Producer | Params |
|---|---|---|
| `block.indexed.{network}` | `bitcoin-indexer` | network: mainnet, testnet, signet, regtest |
| `collection.minted` | `degent-mint` | |
| `collection.certified` | `blockspace-certify` | |
| `degent.mint.order.{status}` | `degent-mint` (DegentClub/degent; its `contracts/asyncapi/degent-mint.yaml` must stay compatible with this canonical schema) | status: order state machine states (`awaiting_content` … `paid`, `confirming`, `member_review`, `declined`, `queued` … `failed`) |
| `batch.{status}` | `scribbit-ledger` | status: created, funded, committed, revealed, confirmed, failed, cancelled |

- A topic has a SemVer `version`. Additive changes (new optional or required fields, new enum values) bump
  **minor**; consumers must ignore unknown properties and tolerate new enum values.
- **Breaking** (property removed, required → optional, type changed, const changed, enum value removed) ⇒ a new
  topic named `<family>.v<major>` published **side by side** with the old one until the catalog shows no consumers.
  Major 1 has no suffix. `defineTopic` enforces the name/major pairing; `assertCompatibleEvolution(prev, next)`
  fails when a breaking change keeps the same major.
- **Contract first:** edit `contracts/asyncapi/platform-events.yaml`, then `src/platform-topics.ts`.
  `test/asyncapi.test.ts` fails when channel addresses, parameters, `x-topic-version`, `x-producer` or payload
  schemas disagree.

## Delivery semantics

At least once everywhere. Handlers must be idempotent on `(source, id)`: wrap them with `idempotent(handler,
store)`; in production back the `DedupeStore` with a unique-keyed table written in the handler's own
transaction. Throw to retry (exponential backoff, default 5 attempts); throw `NonRetryableError` to dead-letter
at once.

### Transactional outbox

Write state and events in one transaction, relay later:

```sql
CREATE TABLE outbox (
  id text PRIMARY KEY,                 -- envelope id (append is ON CONFLICT DO NOTHING)
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,         -- NULL = parked after maxAttempts
  published_at timestamptz,
  last_error text
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE published_at IS NULL;
```

`claim()` leases due rows with `FOR UPDATE SKIP LOCKED` and moves `next_attempt_at` to the lease end, so
concurrent relays never share a row. A crash between publish and `markPublished` republishes the row after the
lease with the **same id**; consumers de-duplicate.

### RabbitMQ (`AmqpBusAdapter`)

The adapter needs no amqplib dependency; the deploying service owns it:

```ts
import amqplib from 'amqplib';                       // in the service's package.json
const conn = await amqplib.connect(process.env.AMQP_URL!);
const channel = await conn.createConfirmChannel();  // confirm channel => publish() awaits broker acks
const bus = new AmqpBusAdapter({ channel, service: 'degent-mint', registry: platformRegistry() });
await bus.init();
conn.on('close', () => process.exit(1));             // let the supervisor restart; unacked messages are redelivered
```

- Wire format: CloudEvents structured mode, `content-type: application/cloudevents+json`, routing key = `type`,
  `message-id` = `id`, `app-id` = `source`, persistent, `traceparent` header.
- Topology: topic exchange `bsh.events`; per subscription a durable queue (`opts.name`, default
  `<service>.<pattern>`) with `x-dead-letter-exchange: bsh.events.dlx`, plus `<queue>.dlq`.
- Retries republish to the queue via the default exchange with `x-bsh-attempt` and ack the original only after
  the copy is confirmed. The wait happens in-process and holds a prefetch slot; for backoffs longer than seconds
  use per-delay TTL retry queues (`x-message-ttl` + dead-letter back to the main queue) instead.
- Unparseable or schema-invalid messages go straight to the DLQ.

## Commands

```bash
pnpm --filter @bsh/events test
pnpm --filter @bsh/events typecheck
```

## Changelog

Topic versions follow `x-topic-version` in the contract; the contract's own `info.version` moves with them.

| Contract | Topic | Change |
|---|---|---|
| 1.1.0 | `degent.mint.order.{status}` 1.1.0 | Additive: statuses `confirming` (commit tx seen, unconfirmed), `member_review` (commit confirmed; existing club members vote) and `declined` (reject quorum; self-rescue offered) inserted after `paid`, for member approval of the mint (degent ADR-0005). Non-breaking; consumers already tolerate new enum values |
| 1.0.0 | all | Initial contract |
