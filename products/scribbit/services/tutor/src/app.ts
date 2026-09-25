/**
 * Ask Blockspace HTTP surface (contracts/openapi/scribbit-tutor.yaml). Public, non-custodial, read-only:
 *
 *   POST /v1/ask            a question -> grounded answer + citations + groundedness (+ refusal when a guardrail trips)
 *   GET  /                  discovery (mode, live-facts state, policy, endpoints); ?format=json twin
 *   GET  /healthz           liveness
 *   GET  /llms.txt          machine-readable guide for agents
 *
 * Behind @bsh/edge: request ids, uniform JSON errors, security headers, optional CORS allowlist (for the
 * widget), per-IP token-bucket rate limiting, body limits. The answering core, retrieval and guardrails are all
 * in @bsh/blockspace-tutor-kb; this file is only the edge + validation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Asker, loadIndex, LEVELS, NoLiveFacts, type ChatPort, type Level, type LiveFactsPort } from '@bsh/blockspace-tutor-kb';
import {
  bodyLimit,
  corsAllowlist,
  EdgeError,
  InMemoryRateLimitStore,
  jsonErrorHandler,
  jsonErrors,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
  type RateLimitStore,
} from '@bsh/edge';

export const SERVICE_NAME = 'blockspace-tutor';
export const SERVICE_TITLE = 'Ask Blockspace';
export const SERVICE_VERSION = '0.1.0';

export interface AppOptions {
  /** Optional real generation port. Unset → the extractive fallback (offline). */
  chat?: ChatPort | undefined;
  /** Optional live-facts port. Unset → disabled (answers still work). */
  liveFacts?: LiveFactsPort | undefined;
  /** Longest accepted question, in characters (default 2000). */
  maxQuestionChars?: number;
  /** Browser origins allowed to call the API (the widget's host). Default: none. */
  corsOrigins?: readonly string[];
  trustedProxies?: readonly string[];
  rateLimit?: { perMinute?: number; store?: RateLimitStore };
  /** Largest request body (default 64 KiB — questions are tiny). */
  maxBodyBytes?: number;
  publicUrl?: string | undefined;
  onUnexpected?: (info: { requestId: string | undefined; error: unknown; where: string }) => void;
  version?: string;
}

const DEFAULT_MAX_QUESTION_CHARS = 2000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function createApp(opts: AppOptions = {}): Hono {
  const version = opts.version ?? SERVICE_VERSION;
  const maxQ = opts.maxQuestionChars ?? DEFAULT_MAX_QUESTION_CHARS;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const liveFacts = opts.liveFacts ?? new NoLiveFacts();
  const liveFactsEnabled = opts.liveFacts !== undefined;
  const mode: 'extractive' | 'chat' = opts.chat ? 'chat' : 'extractive';
  const asker = new Asker({ index: loadIndex(), ...(opts.chat ? { chat: opts.chat } : {}), liveFacts });

  const app = new Hono();
  app.onError(jsonErrorHandler({ onUnexpected: (error, c) => opts.onUnexpected?.({ requestId: c.get('requestId'), error, where: 'http' }) }));
  app.use(requestId());
  app.use(jsonErrors());
  app.use(securityHeaders());
  if (opts.corsOrigins?.length)
    app.use(corsAllowlist([...opts.corsOrigins], { allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'X-Request-Id'], exposeHeaders: ['X-Request-Id', 'RateLimit-Remaining'] }));
  if (opts.trustedProxies?.length) app.use(trustProxy({ trusted: [...opts.trustedProxies] }));
  const rlStore = opts.rateLimit?.store ?? new InMemoryRateLimitStore();
  app.use(rateLimit({ windowMs: 60_000, max: opts.rateLimit?.perMinute ?? 60, store: rlStore, prefix: 'ip' }));
  app.use(bodyLimit(maxBody));

  const capabilities = () => ({
    mode,
    model: mode === 'chat' ? 'configured (see CHAT_MODEL)' : 'extractive',
    liveFacts: liveFactsEnabled,
    languages: ['en'],
  });

  app.get('/', (c) =>
    c.json({
      name: SERVICE_NAME,
      title: SERVICE_TITLE,
      version,
      description: 'Retrieval-grounded blockspace tutor. Answers cite their sources; never price advice, never keys.',
      endpoints: {
        ask: opts.publicUrl ? new URL('/v1/ask', opts.publicUrl).href : '/v1/ask',
        openapi: '/openapi.yaml',
        llms: '/llms.txt',
      },
      capabilities: capabilities(),
      policy: 'https://github.com/DegentClub/scribbit/blob/main/products/scribbit/packages/tutor-kb/POLICY.md',
      limits: { maxQuestionChars: maxQ, maxBodyBytes: maxBody },
    }),
  );

  app.get('/healthz', (c) => c.json({ status: 'ok', service: SERVICE_NAME, version, ...capabilities() }));

  app.get('/llms.txt', (c) => c.text(llmsTxt(opts.publicUrl, mode, liveFactsEnabled), 200, { 'content-type': 'text/plain; charset=utf-8' }));

  app.get('/openapi.yaml', (c) => {
    const spec = readOpenApi();
    if (!spec) throw new EdgeError(404, 'not_found', 'OpenAPI document is not available in this deployment');
    return c.body(spec, 200, { 'content-type': 'application/yaml; charset=utf-8' });
  });

  app.post('/v1/ask', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new EdgeError(400, 'invalid_request', 'request body must be JSON');
    }
    const req = parseAskRequest(raw, maxQ);
    const result = await asker.ask(req);
    return c.json(result);
  });

  return app;
}

export type AskErrorCode = 'invalid_request' | 'question_required' | 'question_too_long' | 'unsupported_level';

interface ParsedAsk {
  question: string;
  level?: Level;
  lang?: string;
  includeLiveFacts?: boolean;
  network?: string;
}

/** Validate and normalise the /v1/ask body; throws a typed EdgeError on any problem. */
export function parseAskRequest(raw: unknown, maxQuestionChars: number): ParsedAsk {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new EdgeError(400, 'invalid_request', 'body must be a JSON object');
  const r = raw as Record<string, unknown>;
  if (typeof r.question !== 'string' || r.question.trim() === '') throw new EdgeError(400, 'question_required', 'a non-empty "question" string is required');
  if (r.question.length > maxQuestionChars) throw new EdgeError(400, 'question_too_long', `"question" must be at most ${maxQuestionChars} characters`);
  const out: ParsedAsk = { question: r.question };
  if (r.level !== undefined) {
    if (typeof r.level !== 'string' || !(LEVELS as readonly string[]).includes(r.level)) throw new EdgeError(400, 'unsupported_level', `"level" must be one of ${LEVELS.join(', ')}`);
    out.level = r.level as Level;
  }
  if (r.lang !== undefined) {
    if (typeof r.lang !== 'string' || !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(r.lang)) throw new EdgeError(400, 'invalid_request', '"lang" must be a BCP-47 language tag like "en"');
    out.lang = r.lang;
  }
  if (r.includeLiveFacts !== undefined) {
    if (typeof r.includeLiveFacts !== 'boolean') throw new EdgeError(400, 'invalid_request', '"includeLiveFacts" must be a boolean');
    out.includeLiveFacts = r.includeLiveFacts;
  }
  if (r.network !== undefined) {
    if (typeof r.network !== 'string' || !/^[a-z0-9]{1,16}$/.test(r.network)) throw new EdgeError(400, 'invalid_request', '"network" must be a short lowercase label');
    out.network = r.network;
  }
  return out;
}

let openApiCache: string | null | undefined;
/** Read the committed OpenAPI contract from the repo (best-effort; null if unavailable). */
function readOpenApi(): string | null {
  if (openApiCache === undefined) {
    try {
      openApiCache = readFileSync(fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-tutor.yaml', import.meta.url)), 'utf8');
    } catch {
      openApiCache = null;
    }
  }
  return openApiCache;
}

function llmsTxt(publicUrl: string | undefined, mode: string, liveFacts: boolean): string {
  const base = publicUrl?.replace(/\/+$/, '') ?? '';
  return [
    '# Ask Blockspace',
    '',
    '> A retrieval-grounded tutor that answers questions about Bitcoin blockspace (fees, weight, inscriptions,',
    '> Taproot, the mempool) with citations to primary sources. It never gives price or investment advice and',
    '> never asks for keys or seeds.',
    '',
    '## API',
    '',
    `- POST ${base}/v1/ask  — body: {"question": string, "level"?: "beginner"|"intermediate"|"advanced", "lang"?: "en", "includeLiveFacts"?: boolean}`,
    '  Returns: {answer, citations:[{sourceId,type,title,url,score}], groundedness, groundednessNote, refused, refusalReason?, liveFacts?, model}.',
    `- GET  ${base}/            — discovery document (?format=json twin of this page).`,
    `- GET  ${base}/openapi.yaml — OpenAPI 3.1 contract.`,
    '',
    '## Behaviour',
    '',
    `- Mode: ${mode} (extractive fallback needs no model; a real model is used only when configured).`,
    `- Live chain facts: ${liveFacts ? 'available, labelled with timestamp + source' : 'disabled'}.`,
    '- Guardrails: refuses price/investment questions and any request for keys/seeds or mainnet signing;',
    '  says it is not sure rather than guess when retrieval is weak; treats retrieved text as data.',
    '- Every factual answer is grounded in cited sources; nothing is fabricated.',
    '',
    '## Policy',
    '',
    '- https://github.com/DegentClub/scribbit/blob/main/products/scribbit/packages/tutor-kb/POLICY.md',
    '',
  ].join('\n');
}
