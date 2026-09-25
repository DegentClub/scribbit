// The optional ledger port. When the signer reports a CONFIRMED settlement together with the
// ledger payment it paid, the plane forwards the transaction to the platform ledger as an
// observation - `POST /v1/payments/{id}/observations` of contracts/openapi/ledger.yaml
// (1.2) - so the order is credited and payouts recorded from the same report. The plane
// does not import @bsh/ledger: it speaks the contract.
export interface LedgerObservation {
  paymentId: string;
  outputs: Array<{ scriptHex: string; valueSats: number }>;
  confirmations?: number;
  rbfSignalled?: boolean;
}

export interface LedgerObservationResult {
  applied: boolean;
  reason?: string;
}

export interface LedgerPort {
  observe(txid: string, observation: LedgerObservation): Promise<LedgerObservationResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class LedgerPortError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'LedgerPortError';
    this.status = status;
    this.code = code;
  }
}

/** HTTP adapter for the ledger contract. The API key is sent and never logged or returned. */
export function httpLedgerPort(options: { url: string; apiKey: string; fetch?: FetchLike; timeoutMs?: number }): LedgerPort {
  const base = options.url.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((u, i) => fetch(u, i));
  return {
    async observe(txid, obs) {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/payments/${encodeURIComponent(obs.paymentId)}/observations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ txid, outputs: obs.outputs, ...(obs.confirmations !== undefined ? { confirmations: obs.confirmations } : {}), ...(obs.rbfSignalled !== undefined ? { rbfSignalled: obs.rbfSignalled } : {}) }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new LedgerPortError(`ledger unreachable: ${(err as Error).message}`, 0);
      }
      const body = (await res.json().catch(() => undefined)) as { applied?: boolean; reason?: string; error?: { code?: string; message?: string } } | undefined;
      if (!res.ok) throw new LedgerPortError(`ledger answered ${res.status}: ${body?.error?.message ?? 'no message'}`, res.status, body?.error?.code);
      return { applied: body?.applied === true, ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}) };
    },
  };
}
