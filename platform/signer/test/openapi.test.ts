import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { InMemoryApiKeyStore } from '@bsh/edge';
import { InMemoryAuditLog, InMemoryKeyProvider, Signer, createSignerApp } from '../src/index.js';
import { PRIV_A } from './helpers.js';

const contract = parse(readFileSync(path.resolve(import.meta.dirname, '../../../contracts/openapi/signer.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

describe('contracts/openapi/signer.yaml', () => {
  const app = createSignerApp({
    signer: new Signer({ keys: new InMemoryKeyProvider([['a', PRIV_A]]), audit: new InMemoryAuditLog(), allowedPurposes: [] }),
    keys: new InMemoryApiKeyStore(),
  });

  it('every documented route is served (no 404) and every method matches', async () => {
    for (const [p, methods] of Object.entries(contract.paths)) {
      const url = p.replace('{id}', 'a');
      for (const method of Object.keys(methods)) {
        const res = await app.request(url, { method: method.toUpperCase() });
        expect(res.status, `${method.toUpperCase()} ${p}`).not.toBe(404);
        expect(res.status, `${method.toUpperCase()} ${p}`).not.toBe(405);
      }
    }
  });

  it('documents exactly the routes the app has', () => {
    expect(Object.keys(contract.paths).sort()).toEqual(['/v1/audit', '/v1/health', '/v1/keys/{id}/pubkey', '/v1/sign/digest', '/v1/sign/taproot-keypath']);
  });
});
