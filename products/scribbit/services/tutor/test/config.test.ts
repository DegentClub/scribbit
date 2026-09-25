import { describe, expect, it } from 'vitest';
import { ConfigError, loadServerConfig } from '../src/index.js';

describe('loadServerConfig', () => {
  it('defaults to the safe, offline mode', () => {
    const c = loadServerConfig({});
    expect(c.port).toBe(3060);
    expect(c.ratePerMinute).toBe(60);
    expect(c.maxQuestionChars).toBe(2000);
    expect(c.liveFacts.enabled).toBe(false);
    expect(c.chatConfigured).toBe(false);
  });

  it('parses lists and numbers', () => {
    const c = loadServerConfig({ TUTOR_CORS_ORIGINS: 'https://a.example, https://b.example', TUTOR_RATE_LIMIT_PER_MIN: '10' });
    expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(c.ratePerMinute).toBe(10);
  });

  it('requires LIVE_FACTS_URL when LIVE_FACTS is on', () => {
    expect(() => loadServerConfig({ LIVE_FACTS: 'on' })).toThrow(ConfigError);
    const c = loadServerConfig({ LIVE_FACTS: 'on', LIVE_FACTS_URL: 'https://mempool.example' });
    expect(c.liveFacts).toMatchObject({ enabled: true, url: 'https://mempool.example' });
  });

  it('requires the full CHAT_* set when CHAT_PROVIDER is on', () => {
    expect(() => loadServerConfig({ CHAT_PROVIDER: 'anthropic', CHAT_BASE_URL: 'https://x' })).toThrow(ConfigError);
    const c = loadServerConfig({ CHAT_PROVIDER: 'anthropic', CHAT_BASE_URL: 'https://x', CHAT_API_KEY: 'k', CHAT_MODEL: 'm' });
    expect(c.chatConfigured).toBe(true);
  });

  it('treats CHAT_PROVIDER=off as disabled', () => {
    expect(loadServerConfig({ CHAT_PROVIDER: 'off' }).chatConfigured).toBe(false);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadServerConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });
});
