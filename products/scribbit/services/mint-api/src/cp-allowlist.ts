/**
 * The Counterparty v2 allowlist, modelled on counters.fun's `app/api/cp/[...path]/route.ts` and cut down to
 * what the counters mint page needs: a few reads, two composes and the relay of an already-signed
 * transaction. Everything else is 403 before any upstream call.
 *
 * Signing never passes through here. A compose returns an unsigned transaction and moves nothing; a signed
 * transaction cannot be altered in transit; so what the proxy relays is exactly what the wallet produced.
 */

export type CpMethod = 'GET' | 'POST';

/** Reads, by path shape (after the `/api/cp/` prefix, without the query string). */
const READ_ALLOWED: readonly RegExp[] = [
  /^assets\/[A-Za-z0-9.\-_@!]{1,250}$/, // asset info: exists? owner? locked?
  /^addresses\/[A-Za-z0-9]{20,90}\/balances$/, // every balance at an address
  /^addresses\/[A-Za-z0-9]{20,90}\/balances\/[A-Za-z0-9.\-_@!]{1,250}$/, // one balance (XCP for the burn check)
  /^addresses\/[A-Za-z0-9]{20,90}\/assets$/, // assets issued by the address
  /^addresses\/[A-Za-z0-9]{20,90}\/assets\/owned$/, // assets owned (the reinscribe picker)
  /^blocks\/last$/, // the tip, for scheduling a fairminter
  /^bitcoin\/transactions\/[0-9a-fA-F]{64}$/, // did a broadcast land at the node?
];

/** Composes. Each returns an unsigned transaction; none of them move anything. */
const COMPOSE_ALLOWED: ReadonlySet<string> = new Set(['issuance', 'fairminter']);

/** POSTs other than composes. */
const POST_ALLOWED: ReadonlySet<string> = new Set(['bitcoin/transactions']); // sendrawtransaction of a signed hex

export type CpRoute = { kind: 'read' } | { kind: 'compose'; type: string; address: string } | { kind: 'broadcast' };

/** Classify a request against the allowlist; `null` means "not proxied". */
export function cpRoute(method: string, path: string): CpRoute | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.includes('..') || clean.includes('//')) return null;
  if (method === 'GET') return READ_ALLOWED.some((re) => re.test(clean)) ? { kind: 'read' } : null;
  if (method === 'POST') {
    if (POST_ALLOWED.has(clean)) return { kind: 'broadcast' };
    const parts = clean.split('/');
    if (parts.length === 4 && parts[0] === 'addresses' && parts[2] === 'compose' && COMPOSE_ALLOWED.has(parts[3]!) && /^[A-Za-z0-9]{20,90}$/.test(parts[1]!)) {
      return { kind: 'compose', type: parts[3]!, address: parts[1]! };
    }
  }
  return null;
}

export const CP_ALLOWLIST_DOC = {
  reads: ['assets/{name}', 'addresses/{addr}/balances', 'addresses/{addr}/balances/{asset}', 'addresses/{addr}/assets', 'addresses/{addr}/assets/owned', 'blocks/last', 'bitcoin/transactions/{txid}'],
  composes: [...COMPOSE_ALLOWED].map((t) => `addresses/{addr}/compose/${t}`),
  posts: [...POST_ALLOWED],
} as const;
