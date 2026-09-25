import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { FakeLiveFacts } from '@bsh/blockspace-tutor-kb';
import { createApp } from '../src/index.js';

const contractPath = fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-tutor.yaml', import.meta.url));
const contract = parse(readFileSync(contractPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'contract');
const validate = (name: string, body: unknown) => {
  const v = ajv.getSchema(`contract#/components/schemas/${name}`)!;
  const ok = v(body);
  expect(v.errors ?? [], JSON.stringify(v.errors)).toEqual([]);
  expect(ok).toBe(true);
};

const H = { 'content-type': 'application/json' };
const ask = (app: ReturnType<typeof createApp>, body: unknown) => app.request('/v1/ask', { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('HTTP surface matches contracts/openapi/scribbit-tutor.yaml', () => {
  it('declares exactly the routes the app serves', () => {
    expect(Object.keys(contract.paths).sort()).toEqual(['/', '/healthz', '/llms.txt', '/openapi.yaml', '/v1/ask']);
  });

  it('GET / matches Index', async () => {
    const b = await (await createApp({ publicUrl: 'https://tutor.example' }).request('/')).json();
    validate('Index', b);
  });

  it('GET /healthz matches Health', async () => {
    validate('Health', await (await createApp().request('/healthz')).json());
  });

  it('a grounded answer matches AskResponse', async () => {
    validate('AskResponse', await (await ask(createApp(), { question: 'what is the witness discount' })).json());
  });

  it('a refusal matches AskResponse', async () => {
    validate('AskResponse', await (await ask(createApp(), { question: 'should I buy bitcoin' })).json());
  });

  it('a weak answer matches AskResponse', async () => {
    validate('AskResponse', await (await ask(createApp(), { question: 'zzxq wibble frobnicate' })).json());
  });

  it('an answer with live facts matches AskResponse', async () => {
    validate('AskResponse', await (await ask(createApp({ liveFacts: new FakeLiveFacts() }), { question: 'what is a fee rate', includeLiveFacts: true })).json());
  });

  it('citations validate against Citation', async () => {
    const b = await (await ask(createApp(), { question: 'ordinals envelope' })).json();
    for (const c of b.citations) validate('Citation', c);
  });

  it('a validation error matches Error', async () => {
    validate('Error', await (await ask(createApp(), { level: 'beginner' })).json());
  });
});
