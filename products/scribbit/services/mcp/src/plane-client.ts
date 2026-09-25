/**
 * A small client for the platform authorization plane (contracts/openapi/plane.yaml, `@bsh/plane`, ADR-0014): only
 * `POST /v1/orgs/{org}/wallet/propose`. The plane identifies the agent by its key, so the server holds one plane key
 * per governed agent, chosen by the MCP caller's `ownerId` (`MCP_PLANE_AGENTS_JSON`). Keys are sent and never
 * returned, logged or put in an error. `fetch` is injectable so tests run against an in-process plane.
 */
import type { FetchLike } from './ledger-client.js';

export interface PlaneAgent {
  /** The agent's name on the plane (its envelope is addressed by it). */
  agent: string;
  /** The plane API key of that agent (scope wallet:propose). Secret. */
  apiKey: string;
}

/** What the plane answers (the contract's `Verdict`), narrowed to what the tools read. */
export interface PlaneVerdict {
  verdict: 'ALLOW' | 'ESCALATE' | 'DENY';
  decisionId: string;
  reasons: string[];
  code?: string;
  reason?: string;
  impact?: string;
  reservationId?: string;
  authorization?: { id: string; maxAmount: string; destination: string | null; expiresAt: string };
  replayed?: boolean;
}

export interface PlaneRecord {
  kind: 'transfer';
  chain: string;
  asset: 'native';
  amount: string;
  destination: string;
  payee?: { kind: string; ref: string };
  raw?: Record<string, unknown>;
}

export class PlaneClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PlaneClientError';
    this.status = status;
    this.code = code;
  }
}

export interface PlaneClient {
  readonly org: string;
  /** The plane agent a caller acts as, or undefined when its key is not governed by the plane. */
  agentFor(ownerId: string | undefined): PlaneAgent | undefined;
  propose(agent: PlaneAgent, record: PlaneRecord, idempotencyKey?: string): Promise<PlaneVerdict>;
}

export interface PlaneClientOptions {
  baseUrl: string;
  org: string;
  /** MCP key ownerId → the plane agent it acts as. */
  agents: Readonly<Record<string, PlaneAgent>>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function createPlaneClient(opts: PlaneClientOptions): PlaneClient {
  let parsed: URL;
  try {
    parsed = new URL(opts.baseUrl);
  } catch {
    throw new Error(`plane URL is not a URL: "${opts.baseUrl}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`plane URL must be http(s): "${opts.baseUrl}"`);
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const f: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const agents = new Map(Object.entries(opts.agents));
  return {
    org: opts.org,
    agentFor: (ownerId) => (ownerId === undefined ? undefined : agents.get(ownerId)),
    async propose(agent, record, idempotencyKey) {
      const headers: Record<string, string> = { authorization: `Bearer ${agent.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      let res: Response;
      try {
        res = await f(`${baseUrl}/v1/orgs/${encodeURIComponent(opts.org)}/wallet/propose`, { method: 'POST', headers, body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new PlaneClientError(0, 'PLANE_UNAVAILABLE', `authorization plane unreachable: ${(e as Error)?.message ?? String(e)}`);
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new PlaneClientError(res.status, 'PLANE_MALFORMED', `the plane answered ${res.status} with a body that is not JSON`);
      }
      if (res.status === 200 || res.status === 201 || res.status === 202) {
        const v = body as PlaneVerdict;
        if (!v || (v.verdict !== 'ALLOW' && v.verdict !== 'ESCALATE' && v.verdict !== 'DENY')) throw new PlaneClientError(res.status, 'PLANE_MALFORMED', 'the plane answered without a verdict');
        return { ...v, reasons: Array.isArray(v.reasons) ? v.reasons : [] };
      }
      const err = (body as { error?: { code?: string; message?: string } })?.error;
      throw new PlaneClientError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `the plane answered ${res.status}`);
    },
  };
}
