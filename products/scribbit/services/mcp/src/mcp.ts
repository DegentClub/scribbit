/**
 * The MCP server: "scribb.it: write to Bitcoin". Tools, resources and prompts are declared ONCE in the registry
 * below (`TOOLS`, `RESOURCES`, `PROMPTS`) and registered on an `McpServer` from the official SDK; the HTTP
 * discovery document, the agent card and `/.well-known/mcp.json` read the same registry, so they cannot drift
 * from what `tools/list` answers. Transports (Streamable HTTP, stdio, in-memory for tests) are attached by the
 * caller. Construction is cheap and pure, so the HTTP app builds one per request (stateless mode) with the
 * caller's scopes in `ports.scopes`; every tool declares the scopes that may call it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { NETWORKS } from './content.js';
import { securityModelDoc } from './docs.js';
import { errorResult, guarded, okResult, ToolError } from './errors.js';
import { MAX_CONTENT_BYTES } from './limits.js';
import { createOrder, getOrder, getReceipt, MAX_OBSERVED_OUTPUTS, MAX_PAYEES, PAYEE_KINDS, reportFunding } from './orders.js';
import { CALCULATOR_SCOPES, FUNDING_REPORT_SCOPES, hasAnyScope, ORDER_READ_SCOPES, ORDER_WRITE_SCOPES, type McpScope } from './scopes.js';
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
export const SERVER_VERSION = '0.2.0';

export const INSTRUCTIONS = `scribb.it puts data on Bitcoin as ordinals inscriptions with exact costs up front and no custody of user keys or funds.
Quote flow: get_fees -> quote_inscription (exact weight/vsize/lane/fee) -> commit_address (fund it with commitValue).
Order flow (needs an mcp:order key): create_order turns the quote into a ledger order with a psbt payment intent and returns the
outputs your funding transaction must carry (the commit output plus one per payee) -> build and sign the funding PSBT in YOUR OWN
wallet, broadcast it yourself -> report_funding with the txid and every output (again once it confirms) -> build the half-signed
0x81 reveal with @bsh/inscription (buildHalfSignedReveal) in the user's environment and hand it to the scribb.it mint service, which
attaches the parent and broadcasts -> get_receipt. get_order reads state at any time. The server never sees a private key or a PSBT
and never broadcasts. Fallback: with the default 0x81 reveal the half-signed PSBT is not broadcastable alone; self-rescue is a fresh
transaction re-signed with the ephemeral key K_e (buildResignedRescue, locally). rescue_tx only finalizes legacy 0x83 PSBTs.
Every tool is deterministic and offline except get_fees / quote_inscription without feeRate (fee oracle) and the order tools (ledger).
Content up to 4 MiB as base64, or a length for size-only maths. Read scribbit://docs/lanes for the size table and
scribbit://docs/security-model before handling anyone's PSBT.`;

const network = z.enum(NETWORKS as [string, ...string[]]).describe('mainnet | testnet | signet | regtest');
const contentType = z.string().min(1).max(520).describe('MIME type of the inscription, e.g. "image/webp" or "text/plain;charset=utf-8"');
const contentBase64 = z.string().max(6 * 1024 * 1024).describe(`Exact content bytes, base64 (<= ${MAX_CONTENT_BYTES} bytes decoded)`);
const contentLength = z.number().int().min(0).max(MAX_CONTENT_BYTES).describe('Body size in bytes for a size-only calculation (when the bytes are not at hand)');
const contentSha256 = z.string().length(64).describe('Optional hex SHA-256 of the content; checked against contentBase64 when both are given');
const parentId = z.string().min(66).max(80).describe('Parent inscription id "<txid>i<index>" (adds the parent tag; the reveal then uses the parent layout)');
const metadataBase64 = z.string().max(2 * 1024 * 1024).describe('Optional CBOR metadata (ord tag 5), base64, <= 1 MiB decoded');
const revealPubkey = z.string().min(64).max(66).describe('32-byte x-only reveal public key (64 hex chars); a 33-byte compressed key is accepted and its x coordinate used');
const feeRate = z.number().positive().describe('Fee rate in sat/vB (fractional allowed)');
const orderId = z.string().min(5).max(80).describe('Ledger order id (ord_…) from create_order');
const scriptHex = z.string().min(2).max(1040).describe('scriptPubKey of the output, hex');

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  /** Any one of these lets a caller use the tool. */
  scopes: readonly McpScope[];
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>, ports: ScribbitMcpPorts) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** One line for the model, in front of the JSON. */
  summary?: (r: Record<string, unknown>) => string;
}

/** Typed declaration helper: the handler sees the zod-inferred arguments; the registry stores the erased spec. */
function tool<S extends z.ZodRawShape>(spec: Omit<ToolSpec, 'inputSchema' | 'run'> & { inputSchema: S; run: (args: z.infer<z.ZodObject<S>>, ports: ScribbitMcpPorts) => Promise<Record<string, unknown>> | Record<string, unknown> }): ToolSpec {
  return spec as unknown as ToolSpec;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

/** Every tool, in the order clients see them. */
export const TOOLS: readonly ToolSpec[] = [
  tool({
    name: 'get_fees',
    title: 'Current fee rates',
    description:
      'Aggregated Bitcoin fee rates (sat/vB) from the scribb.it fee oracle: standard tiers slow/normal/fast, the block-lane min/recommended rate, and the min relay floor. Reads the configured oracle; fails with fees_unavailable when none is configured for the network.',
    scopes: CALCULATOR_SCOPES,
    inputSchema: { network: network.optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    run: async (args, ports) => ({ ...(await getFees(args, ports)) }),
    summary: (r) => `Fees on ${String(r.network)} (sat/vB), fetched ${String(r.fetchedAt)}`,
  }),
  tool({
    name: 'quote_inscription',
    title: 'Quote an inscription',
    description:
      'Exact reveal weight, vsize, lane (standard | block) and fee for an inscription, plus the commit value to fund (fee + postage). Pass contentBase64 for the exact bytes or contentLength for a size-only quote. With parentId the quote is for the parent layout and the rescue layout (402 WU lighter) is included. Without feeRate the oracle rate is used (standard.<tier>, or block.recommended for block-lane reveals). Fails with too_large when nothing fits.',
    scopes: CALCULATOR_SCOPES,
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
    annotations: READ_ONLY,
    run: (args, ports) => quoteInscription(args, ports),
    summary: (r) => {
      const reveal = r.reveal as { weight: number; vsize: number; lane: string };
      const fees = r.fees as { revealFee: number; commitValue: number };
      return `${reveal.lane} lane: ${reveal.weight} WU / ${reveal.vsize} vB, reveal fee ${fees.revealFee} sats at ${String(r.feeRate)} sat/vB, fund the commit with ${fees.commitValue} sats`;
    },
  }),
  tool({
    name: 'build_envelope',
    title: 'Inspect the ord envelope',
    description:
      'Builds the ord inscription tapscript (byte-for-byte as ord emits it) and reports its size, body chunking (<= 520-byte pushes), overhead, and a hex preview (first 64 + last 16 bytes). Never returns the full script; use @bsh/inscription for that. A zero placeholder key is used unless revealPubkey is given.',
    scopes: CALCULATOR_SCOPES,
    inputSchema: {
      contentType,
      contentBase64: contentBase64.optional(),
      contentLength: contentLength.optional(),
      parentId: parentId.optional(),
      metadataBase64: metadataBase64.optional(),
      revealPubkey: revealPubkey.optional(),
    },
    annotations: READ_ONLY,
    run: (args) => buildEnvelope(args),
    summary: (r) => `${String(r.scriptBytes)}-byte tapscript, ${String((r.body as { chunks: number }).chunks)} body chunk(s)`,
  }),
  tool({
    name: 'commit_address',
    title: 'Commit address',
    description:
      'P2TR commit address (BIP341 NUMS internal key, single inscription leaf) for the exact content and reveal public key. Requires contentBase64: the address commits to the bytes. Optional contentSha256/contentLength are cross-checked so a transcription error fails here instead of on chain. Fund this address with the quoted commitValue (create_order lists it among the expected outputs).',
    scopes: CALCULATOR_SCOPES,
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
    annotations: READ_ONLY,
    run: (args) => commitAddressTool(args),
    summary: (r) => `Commit address on ${String(r.network)}: ${String(r.address)}`,
  }),
  tool({
    name: 'explain_lanes',
    title: 'Explain lanes and sizes',
    description:
      'Reference table for the Standard, Large and Full-Block lanes with real numbers: max weight and body size per lane, and weight/vsize/lane/fee for bodies from 1 byte to 3.96 MB, computed by the same exact estimator the quotes use.',
    scopes: CALCULATOR_SCOPES,
    inputSchema: { feeRate: feeRate.optional().describe('Fee rate for the fee column (default 2 sat/vB)') },
    annotations: READ_ONLY,
    run: (args) => explainLanes(args),
    summary: (r) => lanesMarkdown(r as ReturnType<typeof explainLanes>),
  }),
  tool({
    name: 'rescue_tx',
    title: 'Self-rescue reveal (legacy 0x83)',
    description:
      'Finalizes a half-signed LEGACY 0x83 reveal PSBT ([commit] -> [child], commit input signed SIGHASH_SINGLE|ANYONECANPAY) into the self-rescue transaction: raw hex, txid, inscription id, weight, vsize and lane. Nothing is broadcast and the PSBT is never echoed. The current @bsh/inscription default (ADR-0005) signs 0x81 (SIGHASH_ALL|ANYONECANPAY) and pre-commits the parent return, so that PSBT is not broadcastable alone and is refused here: rescue it locally with buildResignedRescue and the ephemeral key K_e (a fresh, fully signed [commit] -> [child] transaction). `network` is a label only; the PSBT carries scripts, not addresses.',
    scopes: CALCULATOR_SCOPES,
    inputSchema: {
      halfSignedPsbtBase64: z.string().min(1).max(6 * 1024 * 1024).describe('The half-signed reveal PSBT, base64'),
      network: network.optional(),
    },
    annotations: READ_ONLY,
    run: (args) => rescueTx(args),
    summary: (r) => `Rescue tx ${String(r.txid)} (${String(r.weight)} WU); broadcast the hex yourself`,
  }),
  tool({
    name: 'create_order',
    title: 'Create an order (quote -> ledger order + psbt payment intent)',
    description:
      `Turns a quote into a ledger order you can pay from your own wallet. Quotes the reveal exactly like quote_inscription (size-only: contentLength + contentSha256), builds one line item for the network cost (reveal fee + postage, paid to YOUR commit address from commit_address) plus one per payee (unitSats = floor(mintPriceSats x bps / 10000)), creates the order (product scribbit, customerRef = recipientAddress, metadata: contentSha256, network, quoteExpiresAt...) and a psbt payment intent, and returns the exact outputs (scriptHex + valueSats) your funding transaction must carry, the commit value, the total and the expiry. You (or your wallet) build, sign and broadcast the funding PSBT; this server never sees a key or a PSBT. Then call report_funding. Needs the mcp:order scope and a configured ledger. Up to ${MAX_PAYEES} payees, kinds ${PAYEE_KINDS.join(' | ')}.`,
    scopes: ORDER_WRITE_SCOPES,
    inputSchema: {
      network: network.optional(),
      contentType,
      contentSha256: contentSha256.describe('Hex SHA-256 of the exact content bytes (from quote_inscription / commit_address); stored on the order so the reveal can be checked against it'),
      contentLength,
      parentId: parentId.optional(),
      recipientAddress: z.string().min(10).max(100).describe('Where the inscription (child output) goes; also the order\'s customerRef'),
      commitAddress: z.string().min(10).max(100).describe('The P2TR commit address from commit_address for these exact bytes and your reveal pubkey'),
      feeRate: feeRate.optional(),
      tier: z.enum(TIERS).optional().describe('Standard-lane tier when using the oracle (default normal)'),
      postage: z.number().int().min(0).optional().describe('Child output value in sats (default 546, min 330)'),
      mintPriceSats: z.number().int().min(0).optional().describe('Price the payees\' basis points apply to; required when payees are given'),
      payees: z
        .array(
          z.object({
            kind: z.enum(PAYEE_KINDS as [string, ...string[]]).describe('artist | club | platform | other'),
            ref: z.string().min(1).max(128).describe('Opaque payee reference (artist id, club slug…), never PII'),
            address: z.string().min(10).max(100).describe('Payee address on the same network'),
            bps: z.number().int().min(1).max(10_000).describe('Basis points of mintPriceSats (all payees together <= 10000)'),
          }),
        )
        .max(MAX_PAYEES)
        .optional(),
      idempotencyKey: z.string().min(1).max(128).optional().describe('Reuse on retries: the same key returns the same order and payment instead of creating new ones'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
    run: (args, ports) => createOrder(args, ports),
    summary: (r) => `Order ${String(r.orderId)} / payment ${String(r.paymentId)}: fund ${String(r.totalSats)} sats across ${(r.expectedOutputs as unknown[]).length} output(s) (commit ${String(r.commitValueSats)} sats) before ${String(r.expiresAt)}`,
  }),
  tool({
    name: 'get_order',
    title: 'Read an order',
    description: 'The ledger order, its payment intent(s) with status and expected outputs, and every payout recorded so far. Needs mcp:quote, mcp:order or mcp:settle.',
    scopes: ORDER_READ_SCOPES,
    inputSchema: { orderId },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    run: (args, ports) => getOrder(args, ports),
    summary: (r) => {
      const s = r.status as { order: string; payment: string | null };
      return `Order ${String(r.orderId)} is ${s.order}${s.payment ? `, payment ${s.payment}` : ''}; ${(r.payouts as unknown[]).length} payout(s)`;
    },
  }),
  tool({
    name: 'report_funding',
    title: 'Report the funding transaction',
    description:
      `Tell the ledger which transaction funded the order: txid plus EVERY output of the transaction ({ scriptHex, valueSats } in vout order, at most ${MAX_OBSERVED_OUTPUTS}), how many confirmations it has and whether it still signals RBF. The ledger compares scripts (never addresses) against the order's expected outputs: pending while unconfirmed/replaceable or below the confirmation policy, paid/overpaid/underpaid at depth; payouts are recorded once paid. Report again as confirmations grow. Nothing is broadcast here. Needs mcp:order or mcp:settle.`,
    scopes: FUNDING_REPORT_SCOPES,
    inputSchema: {
      orderId,
      paymentId: z.string().min(5).max(80).optional().describe('Defaults to the order\'s open payment intent'),
      txid: z.string().length(64).describe('Transaction id, hex'),
      outputs: z.array(z.object({ scriptHex, valueSats: z.number().int().min(0) })).min(1).max(MAX_OBSERVED_OUTPUTS).describe('Every output of the transaction, in vout order'),
      confirmations: z.number().int().min(0).optional().describe('Default 0 (unconfirmed)'),
      rbfSignalled: z.boolean().optional().describe('BIP125 signalling while unconfirmed (default false)'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    run: (args, ports) => reportFunding(args, ports),
    summary: (r) => {
      const s = r.status as { order: string; payment: string };
      return `${String(r.txid)} for order ${String(r.orderId)}: payment ${s.payment}, order ${s.order}${r.applied ? '' : ` (not applied: ${String(r.reason)})`}`;
    },
  }),
  tool({
    name: 'get_receipt',
    title: 'Receipt',
    description: 'The ledger receipt for an order (line items, payments, payouts, totals) as JSON plus the plain-text rendering. Needs mcp:quote, mcp:order or mcp:settle.',
    scopes: ORDER_READ_SCOPES,
    inputSchema: { orderId },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    run: (args, ports) => getReceipt(args, ports),
    summary: (r) => String(r.text),
  }),
];

export interface ResourceSpec {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
}

export const RESOURCES: readonly ResourceSpec[] = [
  { name: 'lanes', uri: 'scribbit://docs/lanes', title: 'Lanes and sizes', description: 'Standard / Large / Full-Block lane limits and a size table with real numbers', mimeType: 'text/markdown' },
  {
    name: 'security-model',
    uri: 'scribbit://docs/security-model',
    title: 'Security model',
    description: 'Why reveals are signed 0x81 (SIGHASH_ALL|ANYONECANPAY) with the parent return pre-committed, what a service can and cannot change, the re-signed self-rescue with K_e, and the known limitations of the legacy 0x83 mode',
    mimeType: 'text/markdown',
  },
];

export const PROMPTS = [{ name: 'inscribe_this', title: 'Inscribe this', description: 'Guides an agent through fees -> quote -> create_order -> funding PSBT in the user\'s own wallet -> report_funding -> half-signed reveal to the mint service -> receipt, without ever handling the user\'s funds or keys server-side.' }] as const;

export const toolNames = (): string[] => TOOLS.map((t) => t.name);
export const toolScopes = (): Record<string, McpScope[]> => Object.fromEntries(TOOLS.map((t) => [t.name, [...t.scopes]]));
export const resourceUris = (): string[] => RESOURCES.map((r) => r.uri);
export const promptNames = (): string[] => PROMPTS.map((p) => p.name);

export function createScribbitMcpServer(ports: ScribbitMcpPorts = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const spec of TOOLS) {
    server.registerTool(spec.name, { title: spec.title, description: spec.description, inputSchema: spec.inputSchema, annotations: spec.annotations }, (args) =>
      guarded(
        async () => {
          if (!hasAnyScope(ports.scopes, spec.scopes))
            return errorResult(new ToolError('forbidden_scope', `${spec.name} needs an API key with one of the scopes: ${spec.scopes.join(', ')}`, { tool: spec.name, required: [...spec.scopes] }));
          const r = await spec.run(args as Record<string, unknown>, ports);
          return okResult(r, spec.summary?.(r));
        },
        (e) => ports.onUnexpected?.(spec.name, e),
      ),
    );
  }

  const [lanes, security] = RESOURCES as [ResourceSpec, ResourceSpec];
  server.registerResource(lanes.name, lanes.uri, { title: lanes.title, description: lanes.description, mimeType: lanes.mimeType }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: lanes.mimeType, text: lanesMarkdown() }],
  }));
  server.registerResource(security.name, security.uri, { title: security.title, description: security.description, mimeType: security.mimeType }, async (uri) => {
    const doc = await securityModelDoc();
    return { contents: [{ uri: uri.href, mimeType: security.mimeType, text: doc.text, _meta: { source: doc.source } }] };
  });

  const [inscribe] = PROMPTS;
  server.registerPrompt(
    inscribe.name,
    {
      title: inscribe.title,
      description: inscribe.description,
      argsSchema: {
        contentType: z.string().optional().describe('MIME type of the content to inscribe'),
        network: z.string().optional().describe('mainnet | testnet | signet | regtest (default mainnet)'),
        parentId: z.string().optional().describe('Parent inscription id, if this is a child of a collection'),
      },
    },
    ({ contentType: ct, network: net, parentId: parent }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: inscribePrompt({ contentType: ct ?? '<content type>', network: net ?? 'mainnet', parentId: parent }) } }],
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
3. Generate an ephemeral reveal key pair with @bsh/inscription / @noble/curves in MY environment (never ask me for a private key), then call commit_address with the x-only public key, network, contentType, contentBase64, contentSha256 and parentId. Confirm the address and the commitValue to fund it with. Keep the private key K_e for the reveal and the recovery bundle.
4. Call create_order with network, contentType, contentSha256, contentLength, parentId, recipientAddress (where the inscription goes), the commitAddress from step 3, the fee rate or tier, and any payees I name (kind, ref, address, bps of mintPriceSats). It returns orderId, paymentId, the exact expectedOutputs (scriptHex + valueSats: the commit output and one per payee), totalSats and expiresAt. Show them to me.
5. Build the funding PSBT in MY OWN wallet: one output per expectedOutput with exactly that script and value, my inputs, my change. Sign and broadcast it myself; never send the PSBT or a key to this server. Then call report_funding with orderId, the txid and EVERY output of the transaction ({ scriptHex, valueSats } in vout order); call it again once it has a confirmation so the ledger credits it and records the payouts.
6. Once the funding is credited, build the half-signed reveal in my environment with buildHalfSignedReveal({ network, revealPrivkey: K_e, content, commitOutpoint: { txid, vout: the commit output index }, commitValue, recipientAddress, postage, parentReturnAddress, parentValue }) from @bsh/inscription (0x81, the default) and hand it only to the scribb.it mint service, which attaches the parent and broadcasts. Then call get_receipt(orderId) and show me the receipt.
7. Explain the fallback: if the service does not reveal, the inscription can still land without parent provenance. With the default 0x81 reveal the half-signed PSBT cannot be broadcast alone: keep K_e, content, commitOutpoint, commitValue, recipient and postage in my recovery bundle and re-sign a fresh reveal with buildResignedRescue in my environment; only with a legacy 0x83 reveal is rescue_tx the path (call it with the half-signed PSBT and broadcast the returned hex myself). Read scribbit://docs/security-model and summarise what the service can and cannot change.`;
}
