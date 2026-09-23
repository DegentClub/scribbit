import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildHalfSignedReveal, commitAddress, type InscriptionContent, type Network } from '@bsh/inscription';
import type { FeeProvider, FeesResponse } from '@bsh/scribbit-fee-oracle';
import { createScribbitMcpServer, type ScribbitMcpPorts } from '../src/index.js';

/** Deterministic pseudo-random bytes (xorshift), so fixtures are stable across runs. */
export function bytes(n: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export const PRIV = bytes(32, 7);
export const PUB = schnorr.getPublicKey(PRIV);
export const PUB_HEX = hex(PUB);
export const PARENT_ID = `${'ab'.repeat(32)}i0`;

export function fakeFees(network: Network = 'mainnet', overrides: Partial<FeesResponse> = {}): FeesResponse {
  return {
    network,
    minFeeRate: 1,
    standard: { slow: 1.5, normal: 4, fast: 6.2 },
    block: { min: 1, recommended: 5.1 },
    fetchedAt: '2026-09-23T12:00:00.000Z',
    stale: false,
    sources: ['fake'],
    ...overrides,
  };
}

export function fakeProvider(network: Network = 'mainnet', fees: FeesResponse = fakeFees(network)): FeeProvider & { calls: number } {
  const p = {
    network,
    calls: 0,
    async getFees() {
      p.calls++;
      return fees;
    },
  };
  return p;
}

export function failingProvider(network: Network = 'mainnet', message = 'ECONNREFUSED'): FeeProvider {
  return { network, getFees: async () => Promise.reject(new Error(message)) };
}

/** A real half-signed reveal PSBT (regtest) for rescue tests. */
export function halfSignedFixture(content: InscriptionContent = { contentType: 'text/plain', body: bytes(300), parentId: PARENT_ID }, network: Network = 'regtest') {
  const recipient = commitAddress(PUB, { contentType: 'x', body: new Uint8Array(1) }, network).address;
  const half = buildHalfSignedReveal({
    network,
    sighash: 'single_anyonecanpay', // the 0x83 layout: the half-signed PSBT IS the rescue transaction
    revealPrivkey: PRIV,
    content,
    commitOutpoint: { txid: '11'.repeat(32), vout: 1 },
    commitValue: 10_000n,
    recipientAddress: recipient,
    postage: 546n,
  });
  return { ...half, content, recipient, network };
}

export interface Harness {
  client: Client;
  call<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<{ result: CallToolResult; data: T; isError: boolean }>;
  close(): Promise<void>;
}

/** Client + server over InMemoryTransport: the real protocol path without any network. */
export async function connect(ports: ScribbitMcpPorts = {}): Promise<Harness> {
  const server = createScribbitMcpServer(ports);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverT);
  await client.connect(clientT);
  return {
    client,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { result, data: (result.structuredContent ?? {}) as never, isError: result.isError === true };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export type ErrBody = { error: { code: string; message: string; details?: unknown } };

/** The SDK answers schema violations with an `isError` result carrying the -32602 message, not a rejection. */
export async function expectSchemaError(h: Harness, name: string, args: Record<string, unknown>): Promise<void> {
  const r = await h.call(name, args);
  if (!r.isError) throw new Error(`${name} accepted invalid arguments ${JSON.stringify(args)}`);
  const text = (r.result.content[0] as { text?: string })?.text ?? '';
  if (!/Invalid arguments|validation/i.test(text)) throw new Error(`${name}: unexpected error text ${text}`);
}
