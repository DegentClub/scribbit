/**
 * The MCP server: "scribb.it: write to Bitcoin". Tools, resources and prompts are registered on an
 * `McpServer` from the official SDK; transports (Streamable HTTP, stdio, in-memory for tests) are attached
 * by the caller. Construction is cheap and pure, so the HTTP app builds one per request (stateless mode).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NETWORKS } from './content.js';
import { securityModelDoc } from './docs.js';
import { guarded, okResult } from './errors.js';
import { MAX_CONTENT_BYTES } from './limits.js';
import {
  buildEnvelope,
  commitAddressTool,
  explainLanes,
  getFees,
  lanesMarkdown,
  quoteInscription,
  rescueTx,
  TIERS,
  type ScribbitMcpPorts,
} from './tools.js';

export const SERVER_NAME = 'scribbit';
export const SERVER_TITLE = 'scribb.it: write to Bitcoin';
export const SERVER_VERSION = '0.1.0';

export const INSTRUCTIONS = `scribb.it puts data on Bitcoin as ordinals inscriptions with exact costs up front and no custody of user keys.
Flow: get_fees -> quote_inscription (exact weight/vsize/lane/fee) -> commit_address (fund it with commitValue) -> build the half-signed
reveal with @bsh/inscription in the user's wallet/browser -> the scribb.it service attaches the parent and broadcasts; rescue_tx turns the
half-signed PSBT into a broadcastable no-parent transaction if the service disappears. Every tool is deterministic and offline except
get_fees (and quote_inscription without feeRate), which read the configured fee oracle. Content up to 4 MiB as base64, or a length for size-only quotes.
Read scribbit://docs/lanes for the size table and scribbit://docs/security-model before handling anyone's PSBT.`;

const network = z.enum(NETWORKS as [string, ...string[]]).describe('mainnet | testnet | signet | regtest');
const contentType = z.string().min(1).max(520).describe('MIME type of the inscription, e.g. "image/webp" or "text/plain;charset=utf-8"');
const contentBase64 = z.string().max(6 * 1024 * 1024).describe(`Exact content bytes, base64 (<= ${MAX_CONTENT_BYTES} bytes decoded)`);
const contentLength = z.number().int().min(0).max(MAX_CONTENT_BYTES).describe('Body size in bytes for a size-only calculation (when the bytes are not at hand)');
const contentSha256 = z.string().length(64).describe('Optional hex SHA-256 of the content; checked against contentBase64 when both are given');
const parentId = z.string().min(66).max(80).describe('Parent inscription id "<txid>i<index>" (adds the parent tag; the reveal then uses the parent layout)');
const metadataBase64 = z.string().max(2 * 1024 * 1024).describe('Optional CBOR metadata (ord tag 5), base64, <= 1 MiB decoded');
const revealPubkey = z.string().min(64).max(66).describe('32-byte x-only reveal public key (64 hex chars); a 33-byte compressed key is accepted and its x coordinate used');
const feeRate = z.number().positive().describe('Fee rate in sat/vB (fractional allowed)');

export function createScribbitMcpServer(ports: ScribbitMcpPorts = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const run = (tool: string, fn: () => Promise<Record<string, unknown>> | Record<string, unknown>, summary?: (r: Record<string, unknown>) => string) =>
    guarded(
      async () => {
        const r = await fn();
        return okResult(r, summary?.(r));
      },
      (e) => ports.onUnexpected?.(tool, e),
    );

  server.registerTool(
    'get_fees',
    {
      title: 'Current fee rates',
      description:
        'Aggregated Bitcoin fee rates (sat/vB) from the scribb.it fee oracle: standard tiers slow/normal/fast, the block-lane min/recommended rate, and the min relay floor. Reads the configured oracle; fails with fees_unavailable when none is configured for the network.',
      inputSchema: { network: network.optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => run('get_fees', async () => ({ ...(await getFees(args, ports)) }), (r) => `Fees on ${String(r.network)} (sat/vB), fetched ${String(r.fetchedAt)}`),
  );

  server.registerTool(
    'quote_inscription',
    {
      title: 'Quote an inscription',
      description:
        'Exact reveal weight, vsize, lane (standard | block) and fee for an inscription, plus the commit value to fund (fee + postage). Pass contentBase64 for the exact bytes or contentLength for a size-only quote. With parentId the quote is for the parent layout and the rescue layout (402 WU lighter) is included. Without feeRate the oracle rate is used (standard.<tier>, or block.recommended for block-lane reveals). Fails with too_large when nothing fits.',
      inputSchema: {
        network: network.optional(),
        contentType,
        contentBase64: contentBase64.optional(),
        contentLength: contentLength.optional(),
        contentSha256: contentSha256.optional(),
        parentId: parentId.optional(),
        metadataBase64: metadataBase64.optional(),
        feeRate: feeRate.optional(),
        tier: z.enum(TIERS).optional().describe('Standard-lane tier when using the oracle (default normal)'),
        recipientAddress: z.string().max(100).optional().describe('Child recipient address (default: a P2TR output is assumed; only the script size matters)'),
        postage: z.number().int().min(0).optional().describe('Child output value in sats (default 546, min 330)'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(
        'quote_inscription',
        () => quoteInscription(args, ports),
        (r) => {
          const reveal = r.reveal as { weight: number; vsize: number; lane: string };
          const fees = r.fees as { revealFee: number; commitValue: number };
          return `${reveal.lane} lane: ${reveal.weight} WU / ${reveal.vsize} vB, reveal fee ${fees.revealFee} sats at ${String(r.feeRate)} sat/vB, fund the commit with ${fees.commitValue} sats`;
        },
      ),
  );

  server.registerTool(
    'build_envelope',
    {
      title: 'Inspect the ord envelope',
      description:
        'Builds the ord inscription tapscript (byte-for-byte as ord emits it) and reports its size, body chunking (<= 520-byte pushes), overhead, and a hex preview (first 64 + last 16 bytes). Never returns the full script; use @bsh/inscription for that. A zero placeholder key is used unless revealPubkey is given.',
      inputSchema: {
        contentType,
        contentBase64: contentBase64.optional(),
        contentLength: contentLength.optional(),
        parentId: parentId.optional(),
        metadataBase64: metadataBase64.optional(),
        revealPubkey: revealPubkey.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('build_envelope', () => buildEnvelope(args), (r) => `${String(r.scriptBytes)}-byte tapscript, ${String((r.body as { chunks: number }).chunks)} body chunk(s)`),
  );

  server.registerTool(
    'commit_address',
    {
      title: 'Commit address',
      description:
        'P2TR commit address (BIP341 NUMS internal key, single inscription leaf) for the exact content and reveal public key. Requires contentBase64: the address commits to the bytes. Optional contentSha256/contentLength are cross-checked so a transcription error fails here instead of on chain. Fund this address with the quoted commitValue.',
      inputSchema: {
        network,
        revealPubkey,
        contentType,
        contentBase64: contentBase64.optional(),
        contentSha256: contentSha256.optional(),
        contentLength: contentLength.optional(),
        parentId: parentId.optional(),
        metadataBase64: metadataBase64.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('commit_address', () => commitAddressTool(args), (r) => `Commit address on ${String(r.network)}: ${String(r.address)}`),
  );

  server.registerTool(
    'explain_lanes',
    {
      title: 'Explain lanes and sizes',
      description:
        'Reference table for the Standard, Large and Full-Block lanes with real numbers: max weight and body size per lane, and weight/vsize/lane/fee for bodies from 1 byte to 3.96 MB, computed by the same exact estimator the quotes use.',
      inputSchema: { feeRate: feeRate.optional().describe('Fee rate for the fee column (default 2 sat/vB)') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('explain_lanes', () => explainLanes(args), (r) => lanesMarkdown(r as ReturnType<typeof explainLanes>)),
  );

  server.registerTool(
    'rescue_tx',
    {
      title: 'Self-rescue reveal',
      description:
        'Finalizes a half-signed 0x83 reveal PSBT ([commit] -> [child], commit input signed SIGHASH_SINGLE|ANYONECANPAY) into the self-rescue transaction: raw hex, txid, inscription id, weight, vsize and lane. Nothing is broadcast and the PSBT is never echoed. Use when the scribb.it service did not reveal in time; the inscription lands without parent provenance. A 0x81 (SIGHASH_ALL|ANYONECANPAY, the current @bsh/inscription default) PSBT is refused: rescue those locally with buildResignedRescue and the ephemeral key K_e. `network` is a label only; the PSBT carries scripts, not addresses.',
      inputSchema: {
        halfSignedPsbtBase64: z.string().min(1).max(6 * 1024 * 1024).describe('The half-signed reveal PSBT, base64'),
        network: network.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('rescue_tx', () => rescueTx(args), (r) => `Rescue tx ${String(r.txid)} (${String(r.weight)} WU); broadcast the hex yourself`),
  );

  server.registerResource(
    'lanes',
    'scribbit://docs/lanes',
    { title: 'Lanes and sizes', description: 'Standard / Large / Full-Block lane limits and a size table with real numbers', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lanesMarkdown() }] }),
  );

  server.registerResource(
    'security-model',
    'scribbit://docs/security-model',
    { title: 'Security model', description: 'Why reveals are signed with 0x83, what a service can and cannot change, self-rescue, and the known limitations', mimeType: 'text/markdown' },
    async (uri) => {
      const doc = await securityModelDoc();
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.text, _meta: { source: doc.source } }] };
    },
  );

  server.registerPrompt(
    'inscribe_this',
    {
      title: 'Inscribe this',
      description: 'Guides an agent through quote -> commit -> reveal with the scribb.it tools and the @bsh/inscription SDK, without ever handling the user\'s funds or keys server-side.',
      argsSchema: {
        contentType: z.string().optional().describe('MIME type of the content to inscribe'),
        network: z.string().optional().describe('mainnet | testnet | signet | regtest (default mainnet)'),
        parentId: z.string().optional().describe('Parent inscription id, if this is a child of a collection'),
      },
    },
    ({ contentType, network: net, parentId: parent }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: inscribePrompt({ contentType: contentType ?? '<content type>', network: net ?? 'mainnet', parentId: parent }),
          },
        },
      ],
    }),
  );

  return server;
}

export function inscribePrompt(a: { contentType: string; network: string; parentId?: string | undefined }): string {
  const parentLine = a.parentId ? `The inscription is a child of parent ${a.parentId}: pass parentId to every tool so the quote uses the parent layout.` : 'No parent: the quote is for the single-input layout.';
  return `I want to inscribe ${a.contentType} content on Bitcoin ${a.network} with scribb.it. ${parentLine}
Work through these steps, showing the numbers at each one, and stop before anything that spends funds:

1. Read scribbit://docs/lanes and call get_fees(network="${a.network}") to see the current market.
2. Call quote_inscription with the exact contentBase64 (or contentLength if you only know the size), contentType, parentId and the tier I choose.
   Report weight, vsize, lane, revealFee and commitValue. If the lane is "block", warn me that it needs a Libre Relay / Slipstream broadcaster. If it fails with too_large, tell me how much to shrink.
3. Generate an ephemeral reveal key pair with @bsh/inscription / @noble/curves in MY environment (never ask me for a private key), then call commit_address with the x-only public key, network, contentType, contentBase64, contentSha256 and parentId. Confirm the address and the commitValue to fund it with. Keep the private key for the reveal.
4. Once I confirm funding (txid + vout of the commit output), build the half-signed reveal in my environment with buildHalfSignedReveal({ network, revealPrivkey, content, commitOutpoint, commitValue, recipientAddress, postage }) from @bsh/inscription. Do not send the PSBT anywhere except the scribb.it service; it is a broadcastable transaction.
5. Explain the fallback: if the service does not reveal, the inscription can still land without parent provenance. With the default 0x81 reveal, keep K_e, content, commitOutpoint, commitValue, recipient and postage in my recovery bundle and re-sign a fresh reveal with buildResignedRescue in my environment; with a legacy 0x83 reveal, call rescue_tx with the half-signed PSBT and broadcast the returned hex myself. Read scribbit://docs/security-model and summarise what the service can and cannot change.`;
}
