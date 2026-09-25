/**
 * @bsh/blockspace-tutor-kb — the knowledge base, retrieval, guardrails and answering core behind Ask Blockspace.
 *
 * The HTTP service (`@bsh/blockspace-tutor`) and the MCP `ask_blockspace` tool both build an `Asker` over the
 * committed `KbIndex` and share the same guardrails, so policy lives in one place. Everything is offline by
 * default: `ExtractiveChatPort` needs no model, `loadIndex()` reads the committed JSON.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { KbIndex } from './types.js';

export type { Chunk, ChunkSource, KbIndex, SearchHit } from './types.js';
export { buildIndex, buildIndexFromDisk, loadSources, INDEX_VERSION, type Sources } from './build.js';
export { Retriever, tokenize } from './retrieval.js';
export { classifyRefusal, sanitize, learnRedirect, type Refusal, type RefusalReason, type Sanitized } from './guardrails.js';
export { ExtractiveChatPort, type ChatPort, type ChatRequest, type ChatResponse, type ChatMessage, type ChatContextChunk, type ExtractiveOptions } from './chat.js';
export { createAnthropicChatPort, type AnthropicChatOptions } from './chat-anthropic.js';
export { FakeLiveFacts, NoLiveFacts, type LiveFact, type LiveFactsPort } from './livefacts.js';
export { Asker, LEVELS, SYSTEM_PROMPT, type AskRequest, type AskResult, type AskOptions, type Citation, type Groundedness, type Level } from './ask.js';

let cached: KbIndex | undefined;

/** Load the committed index (`data/index.json`). Cached after first read. */
export function loadIndex(): KbIndex {
  if (!cached) {
    const p = fileURLToPath(new URL('../data/index.json', import.meta.url));
    cached = JSON.parse(readFileSync(p, 'utf8')) as KbIndex;
  }
  return cached;
}
