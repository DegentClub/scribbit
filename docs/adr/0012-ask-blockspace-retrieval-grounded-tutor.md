# ADR-0012: Ask Blockspace — a retrieval-grounded tutor with a provider-agnostic ChatPort and extractive fallback

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** scribb.it team
- **Components:** `@bsh/blockspace-tutor-kb` (library), `@bsh/blockspace-tutor` (service), `@bsh/blockspace-tutor-widget` (package), `@bsh/scribbit-mcp` (`ask_blockspace` tool)
- **Supersedes / Related:** ADR-0009 (Signet Playground — shares the "learn, not just click" goal and the kit-owned words), ADR-0002 (non-custodial signing — a tutor never touches keys); contract `contracts/openapi/scribbit-tutor.yaml`; portal glossary (`DegentClub/blockspace-holdings`), BSS-0001..0007 (`DegentClub/specs`)

## Context

The estate's mission is to educate the whole world about blockspace. People and AI agents ask blockspace
questions ("what is a witness discount?", "how big can an inscription be?") in chat, in the portal Build/Learn
area, and through MCP. Answering those questions well has two failure modes we must design against:

1. **Hallucination.** A general model will confidently invent Bitcoin facts (dust limits, weight rules, BIP
   numbers). The estate's honesty rule (root `CLAUDE.md` #4) forbids inventing facts, and blockspace facts are
   exactly the kind an unrounded model gets subtly wrong.
2. **Harm.** A tutor about a Bitcoin product must never give price/investment advice and must never ask for or
   accept a seed or private key, or offer to sign a mainnet transaction on someone's behalf.

We also cannot bind the estate to one LLM vendor. Model availability, pricing and endpoints move faster than our
release cadence, and much of the value here is retrieval + guardrails, not generation. The task is LLM-shaped but
provider-unstated.

Facts that constrain the design:

- The knowledge lives in four already-authored, primary sources: the portal glossary (60 terms, each with a
  primary source), the BSS specs (BSS-0001..0007), the estate ADRs, and the portal Academy lessons. Plus the
  canonical BIPs (340/341/342) and the ordinals envelope, which we summarise ourselves with a citation to the
  BIP number.
- Those sources live in *other* repositories (`blockspace-holdings`, `specs`). A committed, offline,
  reproducible index requires snapshotting the text we need into this package with source ids and anchors.
- Offline-by-default is a hard test rule: tests never touch the network or a real model.

## Decision

1. **Retrieval-grounded, not free generation.** Every answer is grounded in chunks retrieved from a committed
   knowledge base. The generator's job is only to phrase retrieved facts; it is given the retrieved context and
   told to use nothing else. Citations are the chunks the answer used, each with a stable source id, title and
   public URL. If retrieval is weak (top score below a confidence floor), the tutor says it is not sure and
   links to the glossary rather than guessing.

2. **A committed, offline knowledge base (`@bsh/blockspace-tutor-kb`).** Sources are snapshotted into the
   package as data modules (glossary terms, per-section spec excerpts, ADR summaries, hand-written BIP/ordinals
   summaries, Academy lesson summaries), each chunk carrying `{ id, title, text, source: { type, id, url,
   anchor?, section? }, tags }`. `buildIndex()` is a pure function of those sources; `data/index.json` is its
   output, committed to the repo; a **freshness test** asserts the committed index deep-equals `buildIndex()`,
   and `pnpm --filter @bsh/blockspace-tutor-kb refresh` regenerates it. Retrieval is a dependency-light BM25
   lexical search implemented in-package and unit-tested against a fixed query set with expected top-k.

3. **A provider-agnostic `ChatPort`.** Generation is an interface: input = system prompt + messages + retrieved
   context; output = text + which source ids it used. Two implementations:
   - **`ExtractiveChatPort`** (the default, and the *only* one used in tests): deterministic, no network. It
     returns the best-matching knowledge-base passages verbatim with their citations. Every factual sentence
     therefore maps to a retrieved chunk by construction — citation faithfulness is a property, not a hope.
   - **`createAnthropicChatPort`** (optional, behind `CHAT_PROVIDER`): expects an **Anthropic-compatible**
     endpoint configured entirely from env — base URL, API key and model id are all env paths, **nothing is
     hardcoded**. If `CHAT_PROVIDER` is unset the service runs extractive-only and says so in its `groundedness`
     note and discovery document. The real adapter follows the `claude-api` skill for request shape and params
     (system as a top-level field, `max_tokens` required, messages array), but reads the model id from
     `CHAT_MODEL` so no model string lives in the repo.

4. **Guardrails as product policy, shared by every surface.** The kb package owns the guardrails so the HTTP
   service and the MCP tool enforce the identical rules (see `POLICY.md`, stated as testable invariants):
   - **Price/investment** questions are refused (`refused: true`, `refusalReason: "price_advice"`) with an
     explanation and a redirect to learning. The tutor talks about how blockspace *works*, never what anything
     is worth or whether to buy it.
   - **Key material** — any request to reveal, generate, store or hand over a seed / recovery phrase / private
     key is refused hard (`refusalReason: "key_material"`) with a safety warning. A server never asks for or
     accepts keys.
   - **Mainnet signing/broadcast on someone's behalf** is refused (`refusalReason: "mainnet_signing"`); the
     tutor explains the non-custodial model instead.
   - **Prompt injection** in user or retrieved text is treated as data: injection markers are stripped from the
     question and the KB context is delivered as inert reference material the generator is told not to obey.
   - **Weak-retrieval humility**: below the confidence floor the answer is an explicit "not sure" pointer to the
     glossary, never a fabricated claim.

5. **Live chain facts behind a port, labelled and optional.** Current fee estimate and tip height come through a
   `LiveFactsPort` with a fake in tests. Live facts are off by default (`LIVE_FACTS=off`), labelled with a
   timestamp and source when present, and the tutor works fully with the port disabled.

6. **Machine-native everywhere.** `POST /v1/ask` has an OpenAPI 3.1 contract, JSON Schemas for every response,
   typed machine error codes, rate limiting and a `?format=json` twin; the same core is an MCP tool
   (`ask_blockspace`); the widget/demo ships `llms.txt`. The widget is a framework-free `<ask-blockspace>` web
   component (shadow DOM, < 30 KB, fixture mode offline) embedded in the portal only via a documented snippet.

## Alternatives considered

- **Free generation with a system prompt only.** Rejected: it hallucinates blockspace facts and cannot cite.
  Retrieval + extractive fallback is the honest baseline.
- **Vector embeddings for retrieval.** Rejected for now: needs a model or a heavy dependency and a non-reviewable
  binary index. BM25 over a 60–200 chunk corpus is fast, dependency-light, and its ranking is inspectable and
  unit-testable. Revisit if the corpus grows past a few thousand chunks.
- **Hardcoding a model / calling a vendor SDK.** Rejected: couples the estate to one vendor and one model string.
  The ChatPort keeps generation swappable and the extractive fallback keeps the service useful with no model at
  all.
- **Live index pulled from the source repos at build time.** Rejected: those repos are not present in this
  workspace at test time and a network build breaks offline reproducibility. Snapshotting into the package makes
  the index a committed, diffable artifact with a freshness test.

## Consequences

- The KB must be re-snapshotted when upstream sources change; the freshness test guards drift *within* the
  committed sources, and a documented `refresh` step plus the snapshot provenance in each chunk make upstream
  re-snapshots a mechanical, reviewable diff. Follow-up: an automated upstream-sync job once the source repos are
  co-located.
- Extractive mode reads a little more like an encyclopedia than a chat; that is an acceptable, honest default. A
  configured `CHAT_PROVIDER` smooths phrasing while retrieval + the "used sources" contract keep it grounded.
- Guardrails living in the kb library mean one place to test and change policy; both the service and the MCP tool
  inherit fixes automatically.
- Adding a source type later (e.g. RFCs) is a new data module + chunks + a query-set case, no retrieval or
  guardrail change.
