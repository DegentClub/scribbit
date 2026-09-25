/** Real ChainApi over an Esplora-compatible signet REST API (mempool.space/signet/api by default). */
import { BroadcastRejectedError, type ChainApi, type TxStatus, type Utxo } from '../types';
import type { FetchLike } from './faucet';

const TXID_RE = /^[0-9a-f]{64}$/;

export function createEsploraChain(esploraUrl: string, opts: { fixedFeeRate?: number | null; minFeeRate?: number; fetch?: FetchLike } = {}): ChainApi {
  const f: FetchLike = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const base = esploraUrl.replace(/\/+$/, '');
  const min = opts.minFeeRate ?? 1;
  const get = async (path: string, what: string): Promise<Response> => {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { cache: 'no-store' });
    } catch {
      throw new Error(`${what}: the signet API could not be reached (network)`);
    }
    return res;
  };
  return {
    async getUtxos(address) {
      const res = await get(`/address/${encodeURIComponent(address)}/utxo`, 'UTXO lookup');
      if (!res.ok) throw new Error(`UTXO lookup failed (HTTP ${res.status})`);
      const list = (await res.json()) as Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean; block_height?: number } }>;
      return list.map((u): Utxo => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: u.status?.confirmed === true, ...(typeof u.status?.block_height === 'number' ? { block_height: u.status.block_height } : {}) } }));
    },
    async getTx(txid) {
      const res = await get(`/tx/${txid}/status`, 'Transaction lookup');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Transaction lookup failed (HTTP ${res.status})`);
      const s = (await res.json()) as { confirmed?: boolean; block_height?: number };
      const out: TxStatus = { txid, confirmed: s.confirmed === true };
      if (typeof s.block_height === 'number') out.blockHeight = s.block_height;
      return out;
    },
    async getFeeRate() {
      if (opts.fixedFeeRate) return Math.max(opts.fixedFeeRate, min);
      try {
        const res = await get('/fee-estimates', 'Fee estimate');
        if (!res.ok) return min;
        const est = (await res.json()) as Record<string, number>;
        const r = est['3'] ?? est['6'] ?? est['1'];
        return typeof r === 'number' && Number.isFinite(r) ? Math.max(min, Math.ceil(r * 100) / 100) : min;
      } catch {
        return min;
      }
    },
    async broadcast(hex) {
      let res: Response;
      try {
        res = await f(`${base}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex });
      } catch {
        throw new Error('Broadcast: the signet API could not be reached (network). Nothing was lost; try again.');
      }
      const text = (await res.text()).trim();
      if (res.status === 400) throw new BroadcastRejectedError(text.slice(0, 300) || 'rejected');
      if (!res.ok) throw new Error(`Broadcast failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
      if (!TXID_RE.test(text)) throw new Error(`Broadcast: the API did not return a txid (${text.slice(0, 80)})`);
      return text;
    },
  };
}
