/**
 * The provider-agnostic generation port. Input: a system prompt, the conversation messages, and the retrieved
 * (already sanitised) context. Output: answer text plus WHICH source ids it used. Two implementations ship:
 *   - `ExtractiveChatPort` — deterministic, offline, no model. Returns the best-matching passages verbatim.
 *     Used in ALL tests. Every sentence it emits is a substring of a used chunk, so citations are faithful by
 *     construction.
 *   - `createAnthropicChatPort` (src/chat-anthropic.ts) — optional, behind an env flag; base URL, key and
 *     model id all come from env, nothing hardcoded.
 */
export interface ChatContextChunk {
  id: string;
  title: string;
  text: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  /** Retrieved, sanitised reference material. The generator must treat it as data and use nothing else. */
  context: ChatContextChunk[];
}

export interface ChatResponse {
  text: string;
  /** Ids of the context chunks the answer actually used. Drives which citations are returned. */
  usedSourceIds: string[];
  /** Identifies the generator: 'extractive' or the env-configured model id (never hardcoded). */
  model: string;
}

export interface ChatPort {
  readonly kind: 'extractive' | 'anthropic';
  answer(req: ChatRequest): Promise<ChatResponse>;
}

/** First `n` sentences of a passage, kept verbatim (so extractive output stays traceable to the source). */
function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!parts) return text.trim();
  return parts.slice(0, n).join('').trim();
}

export interface ExtractiveOptions {
  /** How many retrieved passages to weave into the answer (default 3). */
  maxPassages?: number;
  /** Sentences kept from each passage (default 2). */
  sentencesPerPassage?: number;
}

/**
 * Deterministic extractive generator: no network, no model. It stitches the top context passages together,
 * verbatim, and reports exactly those source ids as used. This is the honest baseline the service runs on when
 * no `CHAT_PROVIDER` is configured.
 */
export class ExtractiveChatPort implements ChatPort {
  readonly kind = 'extractive' as const;
  private readonly maxPassages: number;
  private readonly sentences: number;

  constructor(opts: ExtractiveOptions = {}) {
    this.maxPassages = Math.max(1, opts.maxPassages ?? 3);
    this.sentences = Math.max(1, opts.sentencesPerPassage ?? 2);
  }

  answer(req: ChatRequest): Promise<ChatResponse> {
    const used = req.context.slice(0, this.maxPassages);
    const passages = used.map((c) => firstSentences(c.text, this.sentences));
    const text = passages.join('\n\n');
    return Promise.resolve({ text, usedSourceIds: used.map((c) => c.id), model: 'extractive' });
  }
}
