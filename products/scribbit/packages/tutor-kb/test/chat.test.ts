import { describe, expect, it } from 'vitest';
import { ExtractiveChatPort, createAnthropicChatPort } from '../src/index.js';
import { AnthropicChatPort } from '../src/chat-anthropic.js';

const ctx = [
  { id: 'glossary:sat', title: 'Sat', text: 'A sat is the smallest unit of bitcoin. There are 100 million per bitcoin. Ordinal theory numbers them.' },
  { id: 'glossary:vbyte', title: 'Virtual byte', text: 'A vbyte is weight divided by four. Fee rates are quoted per vbyte.' },
];

describe('ExtractiveChatPort', () => {
  it('returns matching passages verbatim and reports the ids it used', async () => {
    const port = new ExtractiveChatPort({ maxPassages: 2, sentencesPerPassage: 1 });
    const r = await port.answer({ system: 's', messages: [{ role: 'user', content: 'q' }], context: ctx });
    expect(r.model).toBe('extractive');
    expect(r.usedSourceIds).toEqual(['glossary:sat', 'glossary:vbyte']);
    // every emitted sentence is a substring of a context chunk (faithful by construction)
    for (const s of r.text.split('\n\n')) expect(ctx.some((c) => c.text.includes(s))).toBe(true);
  });

  it('is deterministic', async () => {
    const port = new ExtractiveChatPort();
    const a = await port.answer({ system: 's', messages: [], context: ctx });
    const b = await port.answer({ system: 's', messages: [], context: ctx });
    expect(a).toEqual(b);
  });
});

describe('createAnthropicChatPort — env gating (no model hardcoded)', () => {
  it('returns undefined when CHAT_PROVIDER is unset (extractive-only)', () => {
    expect(createAnthropicChatPort({})).toBeUndefined();
    expect(createAnthropicChatPort({ CHAT_PROVIDER: 'off', CHAT_BASE_URL: 'x', CHAT_API_KEY: 'x', CHAT_MODEL: 'x' })).toBeUndefined();
  });

  it('returns undefined when any of base url / key / model is missing', () => {
    expect(createAnthropicChatPort({ CHAT_PROVIDER: 'anthropic' })).toBeUndefined();
    expect(createAnthropicChatPort({ CHAT_PROVIDER: 'anthropic', CHAT_BASE_URL: 'https://x', CHAT_API_KEY: 'k' })).toBeUndefined();
  });

  it('builds a port only when fully configured; the model id comes from env', () => {
    const port = createAnthropicChatPort({ CHAT_PROVIDER: 'anthropic', CHAT_BASE_URL: 'https://api.example', CHAT_API_KEY: 'k', CHAT_MODEL: 'some-model-from-env' });
    expect(port?.kind).toBe('anthropic');
  });
});

describe('AnthropicChatPort — Anthropic wire format over a fake fetch', () => {
  it('posts to /v1/messages with system + max_tokens + messages, and parses the SOURCES line', async () => {
    let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'A vbyte is weight over four.\nSOURCES: glossary:vbyte' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const port = new AnthropicChatPort({ baseUrl: 'https://api.example/', apiKey: 'secret', model: 'model-x', fetchImpl: fakeFetch });
    const r = await port.answer({ system: 'sys', messages: [{ role: 'user', content: 'what is a vbyte' }], context: ctx });

    expect(seen!.url).toBe('https://api.example/v1/messages');
    expect(seen!.body.model).toBe('model-x');
    expect(seen!.body.max_tokens).toBeTypeOf('number');
    expect(Array.isArray(seen!.body.messages)).toBe(true);
    expect(seen!.body.system).toContain('sys');
    expect(seen!.headers['x-api-key']).toBe('secret');
    expect(seen!.headers['anthropic-version']).toBeTruthy();
    expect(r.model).toBe('model-x');
    expect(r.usedSourceIds).toEqual(['glossary:vbyte']);
    expect(r.text).not.toMatch(/SOURCES:/);
  });

  it('throws on a non-2xx response (so the caller can fall back)', async () => {
    const fail = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const port = new AnthropicChatPort({ baseUrl: 'https://api.example', apiKey: 'k', model: 'm', fetchImpl: fail });
    await expect(port.answer({ system: 's', messages: [], context: [] })).rejects.toThrow(/500/);
  });
});
