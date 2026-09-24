/** Real ChainApi: the mint API (contracts/openapi/scribbit-mint-api.yaml): fees + Esplora proxy. */
import type { ChainApi, FeeSnapshot, TxStatus, Utxo } from '../types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readError(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  let message = `${what} failed (HTTP ${res.status})`;
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    if (body.error?.message) message = `${what}: ${body.error.message}`;
  } catch {
    if (text) message += `: ${text.slice(0, 200)}`;
  }
  return new Error(message);
}

export function createMintApiChain(mintApiUrl: string, ordUrl: string, fetchImpl?: FetchLike): ChainApi {
  const f: FetchLike = fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const base = mintApiUrl.replace(/\/+$/, '');
  return {
    async getFees() {
      const res = await f(`${base}/api/fees`, { cache: 'no-store' });
      if (!res.ok) throw await readError(res, 'Fee lookup');
      const fees = (await res.json()) as FeeSnapshot;
      return { minFeeRate: fees.minFeeRate, standard: fees.standard, block: fees.block, fetchedAt: fees.fetchedAt, stale: fees.stale };
    },
    async getUtxos(address) {
      const res = await f(`${base}/api/esplora/address/${encodeURIComponent(address)}/utxo`, { cache: 'no-store' });
      if (!res.ok) throw await readError(res, 'UTXO lookup');
      const list = (await res.json()) as Utxo[];
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: !!u.status?.confirmed, ...(u.status?.block_height !== undefined ? { block_height: u.status.block_height } : {}) } }));
    },
    async getTx(txid) {
      const res = await f(`${base}/api/esplora/tx/${txid}`, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw await readError(res, 'Transaction lookup');
      const tx = (await res.json()) as { txid: string; status: { confirmed: boolean; block_height?: number } };
      const out: TxStatus = { txid: tx.txid, confirmed: !!tx.status?.confirmed };
      if (tx.status?.block_height !== undefined) out.blockHeight = tx.status.block_height;
      return out;
    },
    async broadcast(hex) {
      const res = await f(`${base}/api/esplora/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex });
      if (!res.ok) throw await readError(res, 'Broadcast');
      return ((await res.json()) as { txid: string }).txid;
    },
    async getInscriptionContent(id) {
      const res = await f(`${ordUrl.replace(/\/+$/, '')}/content/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw await readError(res, 'Content lookup');
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
