# @bsh/notify

Notification core for all three products: subscriptions to platform topics, fanned out to **signed webhooks**,
**email** and **Telegram**, each delivery retried independently with exponential backoff and an idempotency key.
Events come from [`@bsh/events`](../events) (CloudEvents envelopes; topics in
[`contracts/asyncapi/platform-events.yaml`](../../contracts/asyncapi/platform-events.yaml)). No runtime
dependencies beyond `@bsh/events` and `node:crypto`.

```ts
import { Notifier, WebhookChannel, EmailChannel, ConsoleEmailSender, TelegramChannel, HttpTelegramClient } from '@bsh/notify';

const notifier = new Notifier({
  channels: [
    new WebhookChannel({ fetch, secrets: async (sub) => secretStore.get(`services/notify/webhooks/${sub.id}`) }),
    new EmailChannel(new ConsoleEmailSender()),                    // SES/Postmark adapter in production
    new TelegramChannel(new HttpTelegramClient({ botToken, fetch })),
  ],
  subscriptions, deliveryLog,                                      // durable stores in production
});
await notifier.subscribe({ subscriberId: 'acme', channel: 'webhook', target: 'https://hooks.acme.io/bsh',
                           topics: ['degent.mint.order.*', 'block.indexed.{network}'] });
await notifier.attach(bus);                                        // or: await notifier.handle(event)
```

## Quickstart

Inside this workspace, or a product repository that pins `deps/scribbit`: add `"@bsh/notify": "workspace:*"` to `dependencies` and `notify` to `depends_on` in your `component.yaml` (events come from `@bsh/events`). (Not yet published to npm.)

```ts
import { blockIndexed, sourceFor } from '@bsh/events';
import { Notifier, WebhookChannel, verifyWebhookSignature } from '@bsh/notify';

const SECRET = 'whsec-demo'; // production: per subscription, from the secret store
// A stand-in receiver: verifies the signature exactly as a customer's endpoint would.
const receiver = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
  const v = verifyWebhookSignature(init.body, init.headers['Bsh-Signature'], SECRET);
  console.log('receiver:', v.ok, JSON.parse(init.body).type);
  return new Response(null, { status: 204 });
};

const notifier = new Notifier({
  channels: [new WebhookChannel({ fetch: receiver, secrets: async () => SECRET })],
});
await notifier.subscribe({
  subscriberId: 'acme', channel: 'webhook', target: 'https://hooks.acme.example/bsh', topics: ['block.indexed.{network}'],
});

const event = blockIndexed.create({
  source: sourceFor('bitcoin-indexer'), params: { network: 'signet' },
  data: { network: 'signet', height: 1, hash: '00'.repeat(32), previousHash: '11'.repeat(32), time: '2026-09-23T12:00:00Z' },
});
console.log((await notifier.handle(event)).map((o) => o.status)); // receiver: true block.indexed.signet, then [ 'delivered' ]
```

Runs as is with `tsx` (Node 22); the comments show its output. In production, `notifier.attach(bus)` subscribes to a durable `@bsh/events` bus instead of calling
`handle` directly.

## Model

- **Subscription** `{ subscriberId, channel, target, topics[] }` (+ optional `id`, `active`). `topics` are
  patterns: exact names, AMQP wildcards (`*` one word, `#` zero or more) or templates (`{network}` = `*`).
  `subscribe()` validates patterns, the channel and the target (webhook: https, no embedded credentials, no
  localhost/private literal IPs; email address; Telegram chat id).
- **`handle(event)`** finds matching active subscriptions and delivers to each independently; resolves after first
  attempts with one outcome per subscription (`delivered`, `retrying`, `failed`, `duplicate`, `no_channel`).
- **Idempotency key** = `sha256(subscriptionId, source, eventId)`, identical on every attempt and every re-handling.
  Sent as `Idempotency-Key` (webhook) / passed to the email provider. A `DeliveryLog` records successes, so a bus
  redelivery of the same event does not notify twice.
- **Retries**: per channel `RetryPolicy` (webhook 8 attempts, 1 s ×3 up to 1 h, jittered; email 5; Telegram 6),
  overridable per kind. `Retry-After` / Telegram `retry_after` are honoured (capped at the policy max). Permanent
  failures (4xx other than 408/425/429, bounced email, blocked bot, bad target) are not retried. Exhausted or
  permanent failures land in `notifier.failed`.
- **Durability**: retry timers live in memory. Run the notifier behind a durable bus subscription (`attach`) with
  a durable `DeliveryLog`; after a restart the unacked event is redelivered and already-delivered subscriptions
  are skipped.

## Webhooks

Request: `POST <target>`, body = the CloudEvents envelope JSON, headers

| Header | Value |
|---|---|
| `Bsh-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` (several `v1` during rotation) |
| `Idempotency-Key` | stable per (subscription, event) |
| `Bsh-Event-Id`, `Bsh-Event-Type` | envelope `id`, `type` |
| `Bsh-Delivery-Attempt` | 1-based |
| `Content-Type` | `application/cloudevents+json; charset=utf-8` |

Any 2xx acknowledges. Redirects are not followed. Receivers verify on the **raw** body:

```ts
import { verifyWebhookSignature } from '@bsh/notify';
const raw = await req.text();
const v = verifyWebhookSignature(raw, req.headers.get('Bsh-Signature'), process.env.BSH_WEBHOOK_SECRET!, 300);
if (!v.ok) return new Response(v.reason, { status: 400 });   // malformed_header | no_v1_signature |
                                                             // signature_mismatch | timestamp_too_old | timestamp_in_future
if (await seen(req.headers.get('Idempotency-Key'))) return new Response(null, { status: 200 }); // replay inside the window
```

The timestamp is inside the MAC, so a captured request cannot be replayed after the tolerance window
(default 300 s, applied to both past and future skew); inside the window receivers de-duplicate on
`Idempotency-Key`. Comparison is constant-time. `secret` may be an array to accept old and new secrets during
rotation. Signing secrets are per subscription and live in the secret store (`WebhookSecretResolver`), never in
subscription records. Private-address blocking here covers literal IPs only; DNS-based SSRF protection belongs
to the egress proxy.

## Ports and adapters

| Port | Adapters here | Production |
|---|---|---|
| `NotificationChannel` | `WebhookChannel`, `EmailChannel`, `TelegramChannel` | as is |
| `EmailSender` | `ConsoleEmailSender` (dev: logs, keeps `sent`) | SES / Postmark adapter in the deploying service |
| `TelegramClient` | `HttpTelegramClient` (Bot API over injectable `fetch`; token never logged) | as is |
| `SubscriptionStore`, `DeliveryLog` | in-memory | Postgres tables |

## Commands

```bash
pnpm --filter @bsh/notify test
pnpm --filter @bsh/notify typecheck
```
