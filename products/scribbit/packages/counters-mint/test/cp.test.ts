import { describe, expect, it } from 'vitest';
import { CpError, commonComposeParams, createCpClient, supplyParams } from '../src/cp.js';
import { encodeContent } from '../src/content.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createCpClient', () => {
  it('composes with a form-encoded body against the proxy root, and nothing at import time', async () => {
    const { fetch, calls } = fakeFetch(() => json({ result: { rawtransaction: '02', envelope_script: '00', signed_reveal_rawtransaction: '02', btc_fee: 310 } }));
    const cp = createCpClient({ baseUrl: '/api/cp/', fetch });
    const { description, mime_type } = encodeContent(new TextEncoder().encode('hello counters'), 'text/plain');
    const params = {
      asset: 'MEMENOME',
      ...supplyParams({ kind: 'counter', quantity: 1000n, divisible: true, lockQuantity: true }, null),
      ...commonComposeParams({ description, mimeType: mime_type, feeRate: 2.5, ordWrapper: false }),
    };
    const res = await cp.compose('bc1pSOURCE', 'issuance', params);
    expect(res.btc_fee).toBe(310);
    const call = calls[0]!;
    expect(call.url).toBe('/api/cp/addresses/bc1pSOURCE/compose/issuance');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(call.body!);
    expect(body.get('description')).toBe('hello counters');
    expect(body.get('mime_type')).toBe('text/plain');
    expect(body.get('encoding')).toBe('taproot');
    expect(body.get('inscription')).toBe('false');
    expect(body.get('sat_per_vbyte')).toBe('2.5');
    expect(body.get('verbose')).toBe('true');
    expect(body.get('exclude_utxos_with_balances')).toBe('true');
    expect(body.get('quantity')).toBe('1000');
    expect(body.get('divisible')).toBe('true');
    expect(body.get('lock')).toBe('true');
  });

  it('a reinscription is quantity 0 with the asset\'s own divisibility and no lock; a fairminter deploy carries the file', async () => {
    expect(supplyParams({ kind: 'reinscription', quantity: 5n, divisible: true, lockQuantity: true }, { divisible: false })).toEqual({ quantity: '0', divisible: 'false', lock: 'false' });
    expect(() => supplyParams({ kind: 'reinscription', quantity: 0n, divisible: true, lockQuantity: false }, null)).toThrow(/already exists/);
    const { fetch, calls } = fakeFetch(() => json({ result: {} }));
    const cp = createCpClient({ baseUrl: '/api/cp', fetch });
    await cp.compose('bc1p', 'fairminter', { asset: 'MEMENOME', ...commonComposeParams({ description: '89504e47', mimeType: 'image/png', feeRate: 1, ordWrapper: true }) });
    expect(calls[0]!.url).toBe('/api/cp/addresses/bc1p/compose/fairminter');
    expect(new URLSearchParams(calls[0]!.body!).get('inscription')).toBe('true');
    expect(new URLSearchParams(calls[0]!.body!).get('description')).toBe('89504e47');
  });

  it('parses large quantities losslessly and treats 404 as an answer', async () => {
    const { fetch } = fakeFetch((c) => {
      if (c.url.endsWith('/assets/NOPE')) return json({ error: 'not found' }, 404);
      // Literals above 2^53 written as text: JSON.stringify would already have rounded them.
      if (c.url.includes('/assets/MEMENOME')) return new Response('{"result":{"asset":"MEMENOME","divisible":true,"supply":10000000000000001}}', { status: 200 });
      if (c.url.includes('/balances/')) return new Response('{"result":[{"quantity":10000000000000001},{"quantity":1}]}', { status: 200 });
      if (c.url.endsWith('blocks/last')) return json({ result: { block_index: 961_100 } });
      return json({ error: 'boom' }, 500);
    });
    const cp = createCpClient({ baseUrl: 'http://node/v2', fetch });
    expect(await cp.getAsset('NOPE')).toBeNull();
    const asset = await cp.getAsset('MEMENOME');
    expect(asset!.supply).toBe('10000000000000001');
    expect(await cp.getBalance('bc1p', 'MEMENOME')).toBe(10000000000000002n);
    expect(await cp.getTip()).toBe(961_100);
    await expect(cp.getAsset('ERR')).rejects.toBeInstanceOf(CpError);
  });

  it('lists owned assets across pages with descriptions measured and dropped', async () => {
    const { fetch, calls } = fakeFetch((c) => {
      const url = new URL(c.url, 'http://x');
      if (!url.searchParams.get('cursor')) {
        return json({ result: [{ asset: 'ONE', divisible: true, locked: false, supply: 5, description: 'hello', mime_type: 'text/plain', last_issuance_block_index: 10 }], next_cursor: '7' });
      }
      return json({ result: [{ asset: 'TWO', divisible: false, locked: true, supply: '10000000000000000', description: '89504e47', mime_type: 'image/png', description_locked: true, last_issuance_block_index: 20 }], next_cursor: null });
    });
    const cp = createCpClient({ baseUrl: '/api/cp', fetch, ownedPageSize: 1 });
    const owned = await cp.getOwnedAssets('bc1p');
    expect(calls[0]!.url).toBe('/api/cp/addresses/bc1p/assets/owned?limit=1&verbose=false');
    expect(calls[1]!.url).toContain('cursor=7');
    expect(owned.map((o) => o.asset)).toEqual(['TWO', 'ONE']); // newest issuance first
    expect(owned[0]).toEqual({ asset: 'TWO', asset_longname: null, divisible: false, locked: true, supply: '10000000000000000', description_locked: true, mime_type: 'image/png', description_bytes: 4, last_issuance_block_index: 20 });
    expect(owned[1]!.description_bytes).toBe(5);
    expect(JSON.stringify(owned)).not.toContain('hello');
  });

  it('broadcasts as sendrawtransaction with a form body and surfaces the node\'s reason', async () => {
    const txid = 'f'.repeat(64);
    const { fetch, calls } = fakeFetch((c) => (new URLSearchParams(c.body!).get('signedhex') === 'dead' ? json({ error: 'min relay fee not met' }, 400) : json({ result: txid })));
    const cp = createCpClient({ baseUrl: '/api/cp', fetch });
    expect(await cp.broadcast('0200')).toBe(txid);
    expect(calls[0]!.url).toBe('/api/cp/bitcoin/transactions');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    await expect(cp.broadcast('dead')).rejects.toThrow('min relay fee not met');
  });

  it('knowsTransaction: 404 is "never seen", anything else throws', async () => {
    const { fetch } = fakeFetch((c) => (c.url.includes('/aaaa') ? json({ result: '02' }) : c.url.includes('/bbbb') ? json({}, 404) : json({}, 503)));
    const cp = createCpClient({ baseUrl: '/api/cp', fetch });
    expect(await cp.knowsTransaction('aaaa')).toBe(true);
    expect(await cp.knowsTransaction('bbbb')).toBe(false);
    await expect(cp.knowsTransaction('cccc')).rejects.toBeInstanceOf(CpError);
  });
});
