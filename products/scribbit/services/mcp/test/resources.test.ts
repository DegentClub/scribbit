import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Harness } from './helpers.js';
import { extractSecuritySection, inscribePrompt } from '../src/index.js';

describe('resources', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('lists the two docs resources', async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['scribbit://docs/lanes', 'scribbit://docs/security-model']);
    for (const r of resources) expect(r.mimeType).toBe('text/markdown');
  });

  it('scribbit://docs/lanes carries the real size table and lane maxima', async () => {
    const { contents } = await h.client.readResource({ uri: 'scribbit://docs/lanes' });
    const text = (contents[0] as { text: string }).text;
    expect(text).toContain('| standard | 400,000 WU | 100,000 vB | 396,735 B | 397,134 B |');
    expect(text).toContain('| block | 3,990,000 WU | 997,500 vB | 3,966,141 B | 3,966,542 B |');
    expect(text).toContain('| 400,000 | 403,285 | 100,822 | block | 201,644 | 402,883 | block |');
    expect(text).toContain('402 WU lighter');
  });

  it('scribbit://docs/security-model comes from the @bsh/inscription README', async () => {
    const { contents } = await h.client.readResource({ uri: 'scribbit://docs/security-model' });
    const c = contents[0] as { text: string; _meta?: { source: string } };
    expect(c._meta?.source).toBe('inscription-readme');
    expect(c.text).toMatch(/^# @bsh\/inscription security model/);
    expect(c.text).toContain('ANYONECANPAY');
    expect(c.text).toMatch(/Known limitation of 0x83/);
    expect(c.text).toMatch(/rescue/i);
    expect(c.text.length).toBeGreaterThan(1000);
    expect(c.text).not.toContain('\n## '); // stops at the next section
  });

  it('extractSecuritySection handles a missing section', () => {
    expect(extractSecuritySection('# nothing here')).toBeUndefined();
    expect(extractSecuritySection('## Security model\nbody\n## Next\nx')).toBe('# @bsh/inscription security model\n\nbody\n');
  });

  it('unknown resources are errors', async () => {
    await expect(h.client.readResource({ uri: 'scribbit://docs/nope' })).rejects.toThrow(/not found/i);
  });
});

describe('prompts', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('inscribe_this walks quote -> commit -> reveal -> rescue and never asks for a private key', async () => {
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['inscribe_this']);
    expect(prompts[0]!.arguments?.map((a) => a.name).sort()).toEqual(['contentType', 'network', 'parentId']);
    const r = await h.client.getPrompt({ name: 'inscribe_this', arguments: { contentType: 'image/webp', network: 'signet', parentId: 'ab'.repeat(32) + 'i0' } });
    const text = (r.messages[0]!.content as { text: string }).text;
    expect(r.messages[0]!.role).toBe('user');
    expect(text).toBe(inscribePrompt({ contentType: 'image/webp', network: 'signet', parentId: 'ab'.repeat(32) + 'i0' }));
    for (const step of ['get_fees', 'quote_inscription', 'commit_address', 'buildHalfSignedReveal', 'rescue_tx', 'scribbit://docs/security-model'])
      expect(text).toContain(step);
    expect(text).toMatch(/never ask me for a private key/);
    const bare = await h.client.getPrompt({ name: 'inscribe_this', arguments: {} });
    expect((bare.messages[0]!.content as { text: string }).text).toContain('Bitcoin mainnet');
    expect((bare.messages[0]!.content as { text: string }).text).toContain('No parent');
  });
});
