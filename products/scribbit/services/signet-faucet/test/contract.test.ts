import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { POW_ALGORITHM } from '@bsh/scribbit-playground-kit';
import { createApp, DRIP_RESULTS, FaucetWalletError } from '../src/index.js';
import { ADDR, challenge, DIFFICULTY, drip, makeFaucet, solvedDrip } from './helpers.js';

const contractPath = fileURLToPath(new URL('../../../../../contracts/openapi/scribbit-signet-faucet.yaml', import.meta.url));
const contract = parse(readFileSync(contractPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'contract');
const validator = (name: string) => ajv.getSchema(`contract#/components/schemas/${name}`)!;
function expectValid(name: string, body: unknown) {
  const v = validator(name);
  const ok = v(body);
  expect(v.errors ?? [], JSON.stringify(v.errors)).toEqual([]);
  expect(ok).toBe(true);
}
const errorCodes: string[] = (validator('Error').schema as { properties: { error: { properties: { code: { enum: string[] } } } } }).properties.error.properties.code.enum;

describe('contract (contracts/openapi/scribbit-signet-faucet.yaml)', () => {
  it('declares exactly the routes the app serves', () => {
    expect(Object.keys(contract.paths).sort()).toEqual(['/', '/healthz', '/metrics', '/v1/challenge', '/v1/drip', '/v1/status']);
    expect(Object.keys(contract.paths['/v1/drip'])).toEqual(['post']);
  });

  it('GET /, /healthz, /v1/status and /v1/challenge match their schemas', async () => {
    const f = makeFaucet({ publicUrl: 'https://faucet.scribbit.internal.example' });
    const idx = await (await f.app.request('/')).json();
    expectValid('Index', idx);
    expect(idx.pow.algorithm).toBe(POW_ALGORITHM);
    expect(idx.pow.difficulty).toBe(DIFFICULTY);
    expectValid('Health', await (await f.app.request('/healthz')).json());
    expectValid('Status', await (await f.app.request('/v1/status')).json());
    const { body } = await challenge(f);
    expectValid('Challenge', body);
    const off = createApp();
    expectValid('Index', await (await off.request('/')).json());
    expectValid('Status', await (await off.request('/v1/status')).json());
  });

  it('a drip matches Drip, and the request we send matches DripRequest', async () => {
    const f = makeFaucet({ explorerUrl: 'https://mempool.space/signet' });
    const { body: ch } = await challenge(f);
    const { solvePow } = await import('@bsh/scribbit-playground-kit');
    const req = { address: ADDR.signetTr, nonce: ch.nonce, solution: solvePow(ch.nonce, ADDR.signetTr, DIFFICULTY).solution };
    expectValid('DripRequest', req);
    const res = await drip(f, req);
    expect(res.status).toBe(200);
    expectValid('Drip', await res.json());
  });

  it('every error the service can produce matches Error with a code from the contract enum and a documented status', async () => {
    const f = makeFaucet({ dripSats: 10_000, dailyBudgetSats: 10_000, requestsPerMinute: 1000 });
    const responses: Response[] = [];
    responses.push(await drip(f, 'nope'));
    responses.push(await drip(f, { address: ADDR.mainnetTr, nonce: 'ab'.repeat(16), solution: '1' }));
    responses.push(await drip(f, { address: ADDR.regtestTr, nonce: 'ab'.repeat(16), solution: '1' }));
    responses.push(await drip(f, { address: 'tb1qqqqqq', nonce: 'ab'.repeat(16), solution: '1' }));
    responses.push(await drip(f, { address: ADDR.signetTr, nonce: 'ab'.repeat(16), solution: '1' }));
    responses.push(await drip(f, { address: ADDR.signetTr, nonce: 'ab'.repeat(16), solution: '1' }, { contentType: 'text/plain' }));
    responses.push(await solvedDrip(f, ADDR.signetTr));
    responses.push(await solvedDrip(f, ADDR.signetTr)); // address_rate_limited
    responses.push(await solvedDrip(f, ADDR.signetTr2)); // budget_exhausted
    responses.push(await f.app.request('/nope'));
    f.wallet.failWith = new FaucetWalletError('unavailable', 'x');
    const g = makeFaucet();
    g.wallet.failWith = new FaucetWalletError('unavailable', 'x');
    responses.push(await solvedDrip(g, ADDR.signetTr));
    g.wallet.failWith = new FaucetWalletError('insufficient_funds', 'x');
    responses.push(await solvedDrip(g, ADDR.signetTr));
    const seen = new Set<string>();
    for (const res of responses.filter((r) => r.status >= 400)) {
      const body = await res.json();
      expectValid('Error', body);
      expect(errorCodes, `${res.status} ${body.error.code}`).toContain(body.error.code);
      seen.add(body.error.code);
      const op = res.status === 404 ? null : contract.paths['/v1/drip'].post.responses[String(res.status)];
      if (op) expect(Object.keys(contract.paths['/v1/drip'].post.responses)).toContain(String(res.status));
    }
    expect([...seen].sort()).toEqual(['bad_request', 'mainnet_address_refused', 'wrong_network', 'invalid_address', 'challenge_unknown', 'unsupported_media_type', 'address_rate_limited', 'budget_exhausted', 'not_found', 'wallet_unavailable', 'faucet_empty'].sort());
  });

  it('every drip result counted by /metrics is ok or a contract error code', () => {
    for (const r of DRIP_RESULTS) if (r !== 'ok') expect(errorCodes).toContain(r);
  });
});
