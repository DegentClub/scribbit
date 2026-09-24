import { describe, expect, it } from 'vitest';
import { classifyMimeType, descriptionBytes, encodeContent, guessContentType } from '../src/content.js';

describe('encodeContent', () => {
  it('sends text as UTF-8 text and binary as hex, echoing the mime type', () => {
    const text = encodeContent(new TextEncoder().encode('hello counters'), 'text/plain');
    expect(text).toEqual({ description: 'hello counters', mime_type: 'text/plain', kind: 'text' });
    const png = encodeContent(Uint8Array.of(0x89, 0x50, 0x4e, 0x47), 'image/png');
    expect(png).toEqual({ description: '89504e47', mime_type: 'image/png', kind: 'binary' });
  });

  it('classifies like Core classify_mime_type after the extended-MIME gate', () => {
    expect(classifyMimeType('text/html; charset=utf-8')).toBe('text');
    expect(classifyMimeType('message/rfc822')).toBe('text');
    expect(classifyMimeType('image/svg+xml')).toBe('text');
    expect(classifyMimeType('application/manifest+json')).toBe('text');
    expect(classifyMimeType('application/ld+json')).toBe('text');
    expect(classifyMimeType('application/javascript')).toBe('text');
    expect(classifyMimeType('application/yaml')).toBe('text');
    expect(classifyMimeType('application/octet-stream')).toBe('binary');
    expect(classifyMimeType('image/webp')).toBe('binary');
    expect(classifyMimeType('audio/ogg;codecs=opus')).toBe('binary');
  });

  it('refuses invalid UTF-8 under a textual type instead of coercing it', () => {
    expect(() => encodeContent(Uint8Array.of(0xff, 0xfe), 'text/plain')).toThrow(/not valid UTF-8/);
  });

  it('requires a mime type', () => {
    expect(() => encodeContent(new Uint8Array(1), '')).toThrow();
  });
});

describe('guessContentType', () => {
  it('prefers the extension, then the reported type, then octet-stream', () => {
    expect(guessContentType('a.webp', '')).toBe('image/webp');
    expect(guessContentType('a.svg', 'text/xml')).toBe('image/svg+xml');
    expect(guessContentType('noext', 'audio/flac')).toBe('audio/flac');
    expect(guessContentType('noext', '')).toBe('application/octet-stream');
  });
});

describe('descriptionBytes', () => {
  it('measures the API string in on-chain bytes', () => {
    expect(descriptionBytes('héllo', 'text/plain')).toBe(6);
    expect(descriptionBytes('89504e47', 'image/png')).toBe(4);
    expect(descriptionBytes(null, 'image/png')).toBe(0);
  });
});
