# @bsh/blockspace-tutor — Ask Blockspace API

The HTTP surface for **Ask Blockspace**: a retrieval-grounded tutor that answers Bitcoin blockspace questions
with citations. Public, read-only, non-custodial. It never gives price/investment advice and never asks for keys
or seeds. Retrieval, guardrails and the answering core live in
[`@bsh/blockspace-tutor-kb`](../../packages/tutor-kb); this service is the Hono edge around it. Design:
[ADR-0012](../../../../docs/adr/0012-ask-blockspace-retrieval-grounded-tutor.md). Policy:
[POLICY.md](../../packages/tutor-kb/POLICY.md).

## Quickstart

```bash
pnpm --filter @bsh/blockspace-tutor dev      # extractive-only, offline, on :3060

curl -s localhost:3060/v1/ask -H 'content-type: application/json' \
  -d '{"question":"what is the witness discount?"}' | jq
# → { "answer": "...", "citations": [{ "sourceId": "witness-discount", "url": "...", ... }],
#     "groundedness": "grounded", "refused": false, "model": "extractive", ... }

curl -s localhost:3060/v1/ask -H 'content-type: application/json' \
  -d '{"question":"should I buy bitcoin?"}' | jq '{refused, refusalReason}'
# → { "refused": true, "refusalReason": "price_advice" }
```

Embed with your own `ChatPort` / live facts:

```ts
import { createApp } from '@bsh/blockspace-tutor';
import { createAnthropicChatPort } from '@bsh/blockspace-tutor-kb';

const app = createApp({ chat: createAnthropicChatPort(process.env) }); // undefined chat → extractive
```

## What / why

- **What:** `POST /v1/ask` (grounded answer + citations + guardrails), plus discovery (`GET /`), `GET /healthz`,
  `GET /llms.txt` and `GET /openapi.yaml`.
- **Why:** answer blockspace questions honestly — grounded in cited sources, refusing the unsafe classes — for
  both people (the widget) and agents (the MCP tool shares the same core). The value is the retrieval and the
  guardrails, not the generation.

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/ask` | Ask a question → `AskResponse` (or a `refused` result; refusals are 200). |
| GET | `/` | Discovery: capabilities, endpoints, limits. JSON twin of the widget page. |
| GET | `/healthz` | Liveness + capabilities. |
| GET | `/llms.txt` | Machine-readable guide for agents. |
| GET | `/openapi.yaml` | The OpenAPI 3.1 contract. |

`AskResponse`: `{ question, answer, citations[], groundedness: grounded|weak|refused, groundednessNote, refused,
refusalReason?, liveFacts?[], model, injectionNeutralised }`. Contract:
[`contracts/openapi/scribbit-tutor.yaml`](../../../../contracts/openapi/scribbit-tutor.yaml). Typed error codes:
`invalid_request`, `question_required`, `question_too_long`, `unsupported_level`, `rate_limited`,
`payload_too_large`, `not_found`, `internal_error`.

## Configuration (env)

Everything defaults to the safe, offline mode. See [`env.schema.json`](./env.schema.json) for the full list.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3060` / `0.0.0.0` | Listen address. |
| `TUTOR_PUBLIC_URL` | _(none)_ | Absolute public URL (advertised in discovery + llms.txt). |
| `TUTOR_CORS_ORIGINS` | _(none)_ | Comma-separated browser origins allowed (the widget host). |
| `TUTOR_TRUSTED_PROXIES` | _(none)_ | CIDRs trusted for `X-Forwarded-For`. |
| `TUTOR_RATE_LIMIT_PER_MIN` | `60` | Per-IP token bucket. |
| `TUTOR_MAX_QUESTION_CHARS` | `2000` | Longest accepted question. |
| `CHAT_PROVIDER` | **off** | Enable the real generation adapter (Anthropic-compatible). Unset → extractive. |
| `CHAT_BASE_URL` | _(none)_ | Endpoint base URL (path). Required to enable chat. |
| `CHAT_API_KEY` | _(none)_ | **Secret path** `services/blockspace-tutor/chat-api-key`; sent as `x-api-key`. |
| `CHAT_MODEL` | _(none)_ | Model id from env — **no model string is hardcoded**. Required to enable chat. |
| `LIVE_FACTS` | **off** | Enable the live chain-facts port. Requires `LIVE_FACTS_URL`. |
| `LIVE_FACTS_URL` | _(none)_ | Public mempool.space-compatible base URL. |
| `LIVE_FACTS_NETWORK` | `mainnet` | Default network label for live facts. |

## Limits

- Rate limited per IP; questions capped at `TUTOR_MAX_QUESTION_CHARS`; body capped at 64 KiB.
- English only today (`lang` accepts a BCP-47 tag; other tags are accepted but answered from the English KB).
- Extractive by default — grounded but encyclopedic; configure `CHAT_PROVIDER` for smoother phrasing.

## Use

```bash
pnpm --filter @bsh/blockspace-tutor test
pnpm --filter @bsh/blockspace-tutor typecheck
```
