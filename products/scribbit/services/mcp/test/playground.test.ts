import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explainStep, STEP_IDS } from '@bsh/scribbit-playground-kit';
import { connect, expectSchemaError, type Harness } from './helpers.js';

describe('playground_explain_step', () => {
  let h: Harness;
  beforeAll(async () => (h = await connect()));
  afterAll(() => h.close());

  it('returns the same explanation and glossary the playground page shows, by number or id', async () => {
    for (const [i, id] of STEP_IDS.entries()) {
      const byNumber = (await h.call<Record<string, unknown>>('playground_explain_step', { step: i + 1 })).data;
      const byId = (await h.call<Record<string, unknown>>('playground_explain_step', { step: id })).data;
      const want = explainStep(id);
      expect(byNumber).toMatchObject({ step: want.step, id, title: want.title, explanation: want.explanation, onChain: want.onChain, glossary: want.glossary });
      expect(byId).toEqual(byNumber);
      expect(byId.steps).toEqual([...STEP_IDS]);
      expect(String(byId.faucet)).toMatch(/no faucet tool on purpose/);
    }
  });

  it('refuses unknown steps (schema) and there is no faucet tool at all', async () => {
    await expectSchemaError(h, 'playground_explain_step', { step: 6 });
    await expectSchemaError(h, 'playground_explain_step', { step: 'mainnet' });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /faucet|drip/i.test(n))).toEqual([]);
    const t = (await h.client.listTools()).tools.find((x) => x.name === 'playground_explain_step')!;
    expect(t.annotations?.readOnlyHint).toBe(true);
  });
});
