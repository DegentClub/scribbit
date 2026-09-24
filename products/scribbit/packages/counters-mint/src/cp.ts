/**
 * Counterparty Core v2, through the product's mint-api proxy.
 *
 * One rule runs through every helper: a 404 is an answer ("no such asset")
 * and anything else is not. Folding both into `null` turned a proxy outage
 * into "no asset exists" in an earlier life; here a failure throws.
 *
 * `baseUrl` is the proxy root that fronts Core's `/v2` (counters.fun:
 * `/api/cp`). Composes go as a form body so a file-sized description fits;
 * responses are parsed losslessly so 10^16-scale quantities keep their digits.
 * `fetch` is injectable and nothing is fetched at import time.
 *
 * Ported from counters.fun `apps/web/src/lib/cp.ts` (+ `api/owned/route.ts`
 * for the description-stripped owned list, done client-side here).
 */

import { type ComposeResult } from './compose.js';
import { descriptionBytes } from './content.js';
import { big, parseJsonLossless, type Raw } from './numeric.js';

export class CpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CpError';
  }
}

/** The node answered, and the answer is "no such thing". */
export class CpNotFound extends CpError {
  constructor(path: string) {
    super(`not found: ${path}`, 404);
    this.name = 'CpNotFound';
  }
}

export interface AssetInfo {
  asset: string;
  asset_longname: string | null;
  owner: string;
  issuer: string;
  divisible: boolean;
  locked: boolean;
  description_locked?: boolean;
  supply: Raw;
  description?: string | null;
  mime_type?: string | null;
  first_issuance_block_index?: number;
  last_issuance_block_index?: number | null;
}

/** One asset an address owns, as a reinscribe picker needs it: everything but the file. */
export interface OwnedAsset {
  asset: string;
  asset_longname: string | null;
  divisible: boolean;
  locked: boolean;
  supply: string;
  description_locked: boolean;
  mime_type: string | null;
  /** Size of the description on chain, in bytes. 0 means it has none. */
  description_bytes: number;
  last_issuance_block_index: number | null;
}

export type ComposeType = 'issuance' | 'fairminter';

export interface CpClient {
  /** `POST addresses/{address}/compose/{type}` with a form body. Add `verbose=true` for a signable result (`lock_scripts`). */
  compose(address: string, type: ComposeType, params: Record<string, string>): Promise<ComposeResult>;
  /** The asset, or null when nobody has issued it. Throws on anything else. */
  getAsset(name: string): Promise<AssetInfo | null>;
  /** One address's balance of one asset, raw. Zero rows is zero; a failure throws. */
  getBalance(address: string, asset: string): Promise<bigint>;
  /** Everything the address owns, descriptions measured and dropped. Throws on a failure. */
  getOwnedAssets(address: string): Promise<OwnedAsset[]>;
  /** The chain tip Counterparty has parsed to. */
  getTip(): Promise<number>;
  /** `sendrawtransaction` through the node. Returns the txid or throws with the node's reason. */
  broadcast(hex: string): Promise<string>;
  /** Does this node know the transaction? A 404 is a real answer: it has never seen it. */
  knowsTransaction(txid: string): Promise<boolean>;
}

export interface CpClientOptions {
  /** The mint-api proxy root, e.g. `/api/cp` or `http://127.0.0.1:4000/v2`. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Page size for the owned-assets listing (Core caps at 1000). */
  ownedPageSize?: number;
}

const TXID = /^[0-9a-f]{64}$/i;
const OWNED_MAX_PAGES = 20;

export function createCpClient(opts: CpClientOptions): CpClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const pageSize = opts.ownedPageSize ?? 500;

  async function parse<T>(res: Response, path: string): Promise<{ result: T; next_cursor?: string | null }> {
    const text = await res.text();
    let body: { result?: T; error?: string; next_cursor?: string | null } = {};
    try {
      body = parseJsonLossless(text);
    } catch {
      // Not JSON — the proxy or the node fell over mid-reply.
    }
    if (res.status === 404) throw new CpNotFound(path);
    if (!res.ok) throw new CpError(body.error ?? `Counterparty said ${res.status}`, res.status);
    return { result: body.result as T, next_cursor: body.next_cursor };
  }

  async function get<T>(path: string): Promise<{ result: T; next_cursor?: string | null }> {
    const res = await doFetch(`${base}/${path}`, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
    return parse<T>(res, path);
  }

  async function postForm<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await doFetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    return (await parse<T>(res, path)).result;
  }

  return {
    compose(address, type, params) {
      return postForm<ComposeResult>(`addresses/${encodeURIComponent(address)}/compose/${type}`, params);
    },

    async getAsset(name) {
      try {
        return (await get<AssetInfo>(`assets/${encodeURIComponent(name)}`)).result;
      } catch (cause) {
        if (cause instanceof CpNotFound) return null;
        throw cause;
      }
    },

    async getBalance(address, asset) {
      const { result } = await get<{ quantity: Raw }[]>(`addresses/${encodeURIComponent(address)}/balances/${encodeURIComponent(asset)}?type=address`);
      return (result ?? []).reduce((sum, r) => sum + big(r.quantity), 0n);
    },

    async getOwnedAssets(address) {
      const owned: OwnedAsset[] = [];
      let cursor: string | null | undefined = null;
      for (let page = 0; page < OWNED_MAX_PAGES; page++) {
        const query = new URLSearchParams({ limit: String(pageSize), verbose: 'false' });
        if (cursor) query.set('cursor', cursor);
        const { result, next_cursor } = await get<AssetInfo[]>(`addresses/${encodeURIComponent(address)}/assets/owned?${query}`);
        for (const row of result ?? []) {
          if (!row.asset) continue;
          owned.push({
            asset: row.asset,
            asset_longname: row.asset_longname ?? null,
            divisible: row.divisible === true,
            locked: row.locked === true,
            supply: big(row.supply).toString(),
            description_locked: row.description_locked === true,
            mime_type: row.mime_type ?? null,
            description_bytes: descriptionBytes(row.description, row.mime_type),
            last_issuance_block_index: row.last_issuance_block_index ?? null,
          });
        }
        cursor = next_cursor;
        if (!cursor || (result ?? []).length === 0) break;
      }
      owned.sort((a, b) => (b.last_issuance_block_index ?? 0) - (a.last_issuance_block_index ?? 0));
      return owned;
    },

    async getTip() {
      const { result } = await get<{ block_index: number }>('blocks/last');
      return result.block_index;
    },

    async broadcast(hex) {
      const res = await doFetch(`${base}/bitcoin/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ signedhex: hex }).toString(),
      });
      const text = (await res.text()).trim();
      let parsed: { result?: unknown; error?: unknown } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        // fall through
      }
      if (res.ok && typeof parsed.result === 'string' && TXID.test(parsed.result)) return parsed.result;
      const reason = typeof parsed.error === 'string' ? parsed.error : text.slice(0, 200);
      throw new CpError(reason || `broadcast failed (${res.status})`, res.status);
    },

    async knowsTransaction(txid) {
      try {
        await get<string>(`bitcoin/transactions/${encodeURIComponent(txid)}?result_format=hex`);
        return true;
      } catch (cause) {
        if (cause instanceof CpNotFound) return false;
        throw cause;
      }
    },
  };
}

/* -------------------------------------------------------------------- */
/* Compose parameter builders (the semantics of each MintKind)          */
/* -------------------------------------------------------------------- */

/**
 * The parameters every counter compose shares. `encoding=taproot` is what
 * makes the description land in witness data, and it is the only encoding
 * that can produce a counter: classic OP_RETURN data is ARC4-encrypted, so it
 * can never show the literal `CNTRPRTY` marker the protocol requires.
 * `inscription=true` asks for the ord-compatible wrapper; Core applies it only
 * to content-carrying messages and otherwise falls back silently — check the
 * composed envelope with `detectOrdEnvelope`.
 */
export function commonComposeParams(args: { description: string; mimeType: string; feeRate: number; ordWrapper: boolean }): Record<string, string> {
  return {
    description: args.description,
    mime_type: args.mimeType,
    encoding: 'taproot',
    inscription: String(args.ordWrapper),
    sat_per_vbyte: String(args.feeRate),
    verbose: 'true',
    // A UTXO carrying an asset balance is not a coin to spend on fees; moving it would move the balance.
    exclude_utxos_with_balances: 'true',
  };
}

/**
 * What an issuance says about supply. A reinscription is a *reissuance* to
 * Core, which may not change the asset: it sends quantity 0, the asset's own
 * divisibility (Core defaults a missing one to true and refuses `cannot change
 * divisibility`) and no new lock — the supply lock is permanent, and would
 * otherwise freeze the asset as a side effect of putting a new file on it.
 */
export function supplyParams(
  req: { kind: 'counter' | 'reinscription'; quantity: bigint; divisible: boolean; lockQuantity: boolean },
  existing: Pick<AssetInfo, 'divisible'> | null,
): Record<string, string> {
  if (req.kind === 'counter') {
    return { quantity: req.quantity.toString(), divisible: String(req.divisible), lock: String(req.lockQuantity) };
  }
  if (!existing) throw new Error('A reinscription needs an asset that already exists.');
  return { quantity: '0', divisible: String(existing.divisible), lock: 'false' };
}
