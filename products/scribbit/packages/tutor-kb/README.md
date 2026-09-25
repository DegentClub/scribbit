# @bsh/blockspace-tutor-kb

The knowledge base, retrieval, guardrails and answering core behind **Ask Blockspace** — the retrieval-grounded
tutor that answers blockspace questions with citations. This library is shared by the HTTP service
(`@bsh/blockspace-tutor`) and the MCP `ask_blockspace` tool, so policy and grounding live in exactly one place.

It is **offline by default**: retrieval is dependency-light BM25 over a committed JSON index, and the default
generator (`ExtractiveChatPort`) returns matching passages verbatim with no model and no network. See
[ADR-0012](../../../../docs/adr/0012-ask-blockspace-retrieval-grounded-tutor.md) for the design and
[POLICY.md](./POLICY.md) for the guardrail invariants.

## Quickstart

```ts
import { Asker, loadIndex } from '@bsh/blockspace-tutor-kb';

const asker = new Asker({ index: loadIndex() }); // extractive, offline, no model
const r = await asker.ask({ question: 'what is the witness discount?' });

console.log(r.answer);          // grounded passages, verbatim
console.log(r.groundedness);    // 'grounded' | 'weak' | 'refused'
console.log(r.citations);       // [{ sourceId, type, title, url, score }, ...]

await asker.ask({ question: 'should I buy bitcoin?' });
// → { refused: true, refusalReason: 'price_advice', citations: [], ... }
```

To let a real model phrase the retrieved facts, pass a `ChatPort` — the extractive one stays the default:

```ts
import { Asker, createAnthropicChatPort, loadIndex } from '@bsh/blockspace-tutor-kb';

const chat = createAnthropicChatPort(process.env); // undefined unless CHAT_PROVIDER + endpoint/key/model are set
const asker = new Asker({ index: loadIndex(), ...(chat ? { chat } : {}) });
```

## What / why

- **What:** a committed knowledge base (glossary, BSS specs, ADRs, BIP/ordinals summaries, Academy lessons), a
  BM25 retriever, the product-policy guardrails, a provider-agnostic generation port, and the `Asker` that ties
  them together.
- **Why:** general models hallucinate blockspace facts and can drift into price advice or unsafe key handling.
  Grounding every answer in retrieved, cited chunks — and refusing the unsafe classes outright — is the honest
  baseline. Generation is swappable so the estate is not bound to one LLM vendor, and the extractive fallback
  keeps the tutor useful with no model configured.

## Configuration (env)

The library itself reads no env. The real generation adapter (`createAnthropicChatPort`) reads these — **all
paths/values come from the environment; no model id is hardcoded anywhere in this repo**:

| Env var | Default | Meaning |
|---|---|---|
| `CHAT_PROVIDER` | _(off)_ | Truthy, non-`off` value enables the real adapter. Unset → extractive-only. |
| `CHAT_BASE_URL` | _(none)_ | Base URL of an **Anthropic-compatible** Messages API (no trailing `/v1`). Required to enable. |
| `CHAT_API_KEY` | _(none)_ | API key, sent as `x-api-key`. Never logged or stored. Required to enable. |
| `CHAT_MODEL` | _(none)_ | Model id, read from env. **This repo pins no model string.** Required to enable. |
| `CHAT_ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` header value. |
| `CHAT_MAX_TOKENS` | `1024` | Max output tokens for a grounded answer. |

If `CHAT_PROVIDER` is unset or any of base URL / key / model is missing, `createAnthropicChatPort` returns
`undefined` and the caller runs extractive-only.

## Data & freshness

- `sources/*.snapshot.json` — snapshots of the portal glossary, Academy lessons and BSS spec abstracts, each
  with provenance. `sources/bips.ts` and `sources/adrs.ts` are authored summaries (labelled `authored`).
- `data/index.json` — the committed searchable index, exactly `buildIndexFromDisk()`.
- `pnpm --filter @bsh/blockspace-tutor-kb refresh` rebuilds `data/index.json` from `sources/`.
- `pnpm --filter @bsh/blockspace-tutor-kb snapshot` (dev-only; needs `PORTAL_DIR` + `SPECS_DIR`) re-pulls the
  upstream snapshots as a reviewable diff.
- A **freshness test** fails if `data/index.json` ever drifts from the sources.

## API summary

- `loadIndex()`, `buildIndex(sources)`, `buildIndexFromDisk()` — the index.
- `Retriever` — BM25 search (`search(query, k)`), `tokenize`.
- `classifyRefusal`, `sanitize` — guardrails (see POLICY.md).
- `ChatPort`, `ExtractiveChatPort`, `createAnthropicChatPort` — generation.
- `LiveFactsPort`, `FakeLiveFacts`, `NoLiveFacts` — live chain facts (labelled, optional).
- `Asker` — the shared answering core (`ask(req)` → `AskResult`).

## Limits

- Lexical retrieval only (no embeddings) — great for a small, inspectable corpus; revisit above a few thousand
  chunks.
- The index is a snapshot; upstream edits land via `snapshot` + `refresh`, not live.

## Use

```bash
pnpm --filter @bsh/blockspace-tutor-kb test
pnpm --filter @bsh/blockspace-tutor-kb typecheck
```
