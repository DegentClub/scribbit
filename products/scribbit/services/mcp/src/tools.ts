/**
 * Tool implementations: pure functions over @bsh/inscription. The only I/O is the injected fee provider
 * (`get_fees`, and `quote_inscription` when no `feeRate` is given). Nothing here signs, stores or broadcasts.
 */
import {
  buildInscriptionScript,
  buildRescueReveal,
  commitAddress,
  encodeParentId,
  estimateRevealWeight,
  inscriptionIdFromReveal,
  inscriptionScriptLength,
  laneFor,
  LIMITS,
  NUMS_INTERNAL_KEY,
  quoteReveal,
  sha256Hex,
  vsizeFromWeight,
  type InscriptionContent,
  type Lane,
  type Network,
} from '@bsh/inscription';
import type { FeeProvider, FeesResponse } from '@bsh/scribbit-fee-oracle';
import { Asker, loadIndex, LEVELS, type AskRequest, type AskResult } from '@bsh/blockspace-tutor-kb';
import {
  isNetwork,
  NETWORKS,
  normalizePsbtBase64,
  parseNetwork,
  parseXOnlyPubkey,
  PLACEHOLDER_P2TR,
  recipientScriptFor,
  resolveContent,
  toHex,
  type ContentInput,
} from './content.js';
import { invalid, ToolError } from './errors.js';
import { explainStep, STEP_IDS, UnknownStepError, type StepExplanation } from '@bsh/scribbit-playground-kit';
import { MAX_CONTENT_BYTES } from './limits.js';

/** Injected ports. Everything is optional: without a fee provider the tools are fully offline. */
export interface ScribbitMcpPorts {
  /** Fee provider per network. Missing network => `get_fees` fails with `fees_unavailable`, quotes need `feeRate`. */
  fees?: Partial<Record<Network, FeeProvider>>;
  /** Called for unexpected (non-ToolError) failures, with the tool name; nothing else is logged. */
  onUnexpected?: (tool: string, error: unknown) => void;
  /** Ask Blockspace answering engine for `ask_blockspace`. Default: a cached extractive (offline) asker. */
  asker?: Asker;
}

let defaultAsker: Asker | undefined;
/** The shared asker: the injected one, or a lazily-built extractive (offline) asker over the committed index. */
export function getAsker(ports: ScribbitMcpPorts): Asker {
  if (ports.asker) return ports.asker;
  defaultAsker ??= new Asker({ index: loadIndex() });
  return defaultAsker;
}

export const TIERS = ['slow', 'normal', 'fast'] as const;
export type Tier = (typeof TIERS)[number];

export interface LayoutFacts {
  weight: number;
  vsize: number;
  lane: Lane | null;
}

export const layoutFacts = (weight: number): LayoutFacts => ({ weight, vsize: vsizeFromWeight(weight), lane: laneFor(weight) });

const bodyChunks = (len: number) => Math.ceil(len / LIMITS.MAX_SCRIPT_ELEMENT_SIZE);

export const LIMIT_FACTS = Object.freeze({
  standardMaxWeight: LIMITS.MAX_STANDARD_TX_WEIGHT,
  blockMaxWeight: LIMITS.BLOCK_LANE_MAX_TX_WEIGHT,
  maxPushBytes: LIMITS.MAX_SCRIPT_ELEMENT_SIZE,
  dustP2tr: Number(LIMITS.DUST_P2TR),
  defaultPostage: Number(LIMITS.DEFAULT_POSTAGE),
  maxContentBytes: MAX_CONTENT_BYTES,
});

// ---------------------------------------------------------------------------------------------- get_fees

export interface GetFeesInput {
  network?: string | undefined;
}

export async function getFees(input: GetFeesInput, ports: ScribbitMcpPorts): Promise<FeesResponse> {
  const network = parseNetwork(input.network);
  const provider = ports.fees?.[network];
  if (!provider) throw new ToolError('fees_unavailable', `no fee source is configured for ${network}; pass feeRate explicitly to quote_inscription`, { network });
  try {
    return await provider.getFees();
  } catch (e) {
    throw new ToolError('fees_unavailable', `fee source for ${network} failed: ${(e as Error).message}`, { network });
  }
}

// -------------------------------------------------------------------------------------- quote_inscription

export interface QuoteInput extends ContentInput {
  network?: string | undefined;
  feeRate?: number | undefined;
  tier?: string | undefined;
  recipientAddress?: string | undefined;
  postage?: number | undefined;
}

export interface QuoteResult extends Record<string, unknown> {
  network: Network;
  contentType: string;
  bodyBytes: number;
  metadataBytes: number;
  parentId: string | null;
  exactContent: boolean;
  contentSha256: string | null;
  recipient: string;
  envelope: { scriptBytes: number; bodyChunks: number };
  reveal: { layout: 'parent' | 'single' } & LayoutFacts;
  rescue: LayoutFacts | null;
  feeRate: number;
  feeSource: { kind: 'input' } | { kind: 'oracle'; pick: string; fetchedAt: string; stale: boolean };
  feeMarket?: { minFeeRate: number; standard: FeesResponse['standard']; block: FeesResponse['block'] };
  fees: { revealFee: number; postage: number; commitValue: number };
  rescueEffectiveFeeRate?: number;
  limits: typeof LIMIT_FACTS;
  warnings: string[];
}

export async function quoteInscription(input: QuoteInput, ports: ScribbitMcpPorts): Promise<QuoteResult> {
  const network = parseNetwork(input.network);
  const tier = input.tier ?? 'normal';
  if (!(TIERS as readonly string[]).includes(tier)) throw invalid(`tier must be one of ${TIERS.join(', ')}`, { field: 'tier' });
  if (input.feeRate !== undefined && !(Number.isFinite(input.feeRate) && input.feeRate > 0)) throw invalid('feeRate must be a positive number (sat/vB)', { field: 'feeRate' });
  const postageN = input.postage ?? Number(LIMITS.DEFAULT_POSTAGE);
  if (!Number.isSafeInteger(postageN) || postageN < 0) throw invalid('postage must be a whole number of sats', { field: 'postage' });
  const postage = BigInt(postageN);
  if (postage < LIMITS.DUST_P2TR) throw invalid(`postage ${postageN} is below the P2TR dust limit (${LIMITS.DUST_P2TR} sats)`, { field: 'postage' });

  const recipient = recipientScriptFor(input.recipientAddress, network);
  const { content, exact, contentSha256 } = resolveContent(input);
  const withParent = content.parentId !== undefined;
  const reveal = layoutFacts(estimateRevealWeight({ content, withParent, recipientScript: recipient.script }));
  const rescue = withParent ? layoutFacts(estimateRevealWeight({ content, withParent: false, recipientScript: recipient.script })) : null;

  const base = {
    network,
    contentType: content.contentType,
    bodyBytes: content.body.length,
    metadataBytes: content.metadata?.length ?? 0,
    parentId: content.parentId ?? null,
    exactContent: exact,
    contentSha256,
    recipient: recipient.kind,
    envelope: { scriptBytes: inscriptionScriptLength(content), bodyChunks: bodyChunks(content.body.length) },
    reveal: { layout: withParent ? ('parent' as const) : ('single' as const), ...reveal },
    rescue,
    limits: LIMIT_FACTS,
  };
  if (reveal.lane === null)
    throw new ToolError(
      'too_large',
      `reveal weight ${reveal.weight} WU exceeds the block lane limit (${LIMITS.BLOCK_LANE_MAX_TX_WEIGHT} WU); shrink the body by at least ${reveal.weight - LIMITS.BLOCK_LANE_MAX_TX_WEIGHT} bytes`,
      base,
    );

  const warnings: string[] = [];
  let feeRate: number;
  let feeSource: QuoteResult['feeSource'];
  let fees: FeesResponse | null = null;
  if (input.feeRate !== undefined) {
    feeRate = input.feeRate;
    feeSource = { kind: 'input' };
    if (feeRate < 1) warnings.push(`fee rate ${feeRate} sat/vB is below the default 1 sat/vB min relay; most nodes will not relay it`);
  } else {
    const provider = ports.fees?.[network];
    if (!provider) throw new ToolError('fee_rate_required', `no fee source is configured for ${network}; pass feeRate (sat/vB)`, { network });
    try {
      fees = await provider.getFees();
    } catch (e) {
      throw new ToolError('fees_unavailable', `fee source for ${network} failed: ${(e as Error).message}`, { network });
    }
    const pick = reveal.lane === 'block' ? 'block.recommended' : `standard.${tier}`;
    feeRate = reveal.lane === 'block' ? fees.block.recommended : fees.standard[tier as Tier];
    feeSource = { kind: 'oracle', pick, fetchedAt: fees.fetchedAt, stale: fees.stale };
    if (fees.stale) warnings.push('fee data is stale (every upstream refresh failed); double-check before paying');
  }
  if (reveal.lane === 'block') warnings.push('block lane: the reveal is non-standard (> 400,000 WU) and needs a Libre Relay / Slipstream broadcaster');
  if (!exact) warnings.push('size-only quote: pass contentBase64 for the exact bytes before deriving a commit address');

  const q = quoteReveal({ revealWeight: reveal.weight, feeRate, postage });
  return {
    ...base,
    feeRate,
    feeSource,
    ...(fees ? { feeMarket: { minFeeRate: fees.minFeeRate, standard: fees.standard, block: fees.block } } : {}),
    fees: { revealFee: Number(q.revealFee), postage: postageN, commitValue: Number(q.commitValue) },
    ...(rescue ? { rescueEffectiveFeeRate: Math.floor((Number(q.revealFee) / rescue.vsize) * 1000) / 1000 } : {}),
    warnings,
  };
}

// ----------------------------------------------------------------------------------------- build_envelope

export interface EnvelopeInput extends ContentInput {
  revealPubkey?: string | undefined;
}

export interface EnvelopeResult extends Record<string, unknown> {
  contentType: string;
  bodyBytes: number;
  metadataBytes: number;
  parentId: string | null;
  parentTagHex: string | null;
  exactContent: boolean;
  revealPubkey: string;
  pubkeyPlaceholder: boolean;
  scriptBytes: number;
  overheadBytes: number;
  scriptSha256: string | null;
  body: { chunks: number; fullChunks: number; lastChunkBytes: number };
  metadata: { chunks: number };
  hexPreview: { head: string; tail: string; previewBytes: number };
}

export function buildEnvelope(input: EnvelopeInput): EnvelopeResult {
  const pubkey = input.revealPubkey !== undefined ? parseXOnlyPubkey(input.revealPubkey) : new Uint8Array(32);
  const { content, exact } = resolveContent(input);
  const script = buildInscriptionScript(pubkey, content);
  const chunks = bodyChunks(content.body.length);
  const metaLen = content.metadata?.length ?? 0;
  return {
    contentType: content.contentType,
    bodyBytes: content.body.length,
    metadataBytes: metaLen,
    parentId: content.parentId ?? null,
    parentTagHex: content.parentId ? toHex(encodeParentId(content.parentId)) : null,
    exactContent: exact,
    revealPubkey: toHex(pubkey),
    pubkeyPlaceholder: input.revealPubkey === undefined,
    scriptBytes: script.length,
    overheadBytes: script.length - content.body.length - metaLen,
    scriptSha256: exact && input.revealPubkey !== undefined ? sha256Hex(script) : null,
    body: {
      chunks,
      fullChunks: Math.floor(content.body.length / LIMITS.MAX_SCRIPT_ELEMENT_SIZE),
      lastChunkBytes: content.body.length % LIMITS.MAX_SCRIPT_ELEMENT_SIZE || (chunks ? LIMITS.MAX_SCRIPT_ELEMENT_SIZE : 0),
    },
    metadata: { chunks: bodyChunks(metaLen) },
    hexPreview: { head: toHex(script.subarray(0, 64)), tail: toHex(script.subarray(Math.max(0, script.length - 16))), previewBytes: Math.min(script.length, 80) },
  };
}

// ----------------------------------------------------------------------------------------- commit_address

export interface CommitAddressInput extends ContentInput {
  revealPubkey: string;
  network: string;
}

export interface CommitAddressResult extends Record<string, unknown> {
  network: Network;
  address: string;
  scriptPubKey: string;
  internalKey: string;
  revealPubkey: string;
  tapLeafHash: string;
  controlBlock: string;
  leafScriptBytes: number;
  contentType: string;
  bodyBytes: number;
  contentSha256: string;
  parentId: string | null;
  note: string;
}

export function commitAddressTool(input: CommitAddressInput): CommitAddressResult {
  if (!isNetwork(input.network)) throw new ToolError('unsupported_network', `unknown network "${input.network}"`, { supported: NETWORKS });
  const pubkey = parseXOnlyPubkey(input.revealPubkey);
  const { content, contentSha256 } = resolveContent(input, { requireExact: true });
  const c = commitAddress(pubkey, content, input.network);
  return {
    network: input.network,
    address: c.address,
    scriptPubKey: toHex(c.script),
    internalKey: toHex(NUMS_INTERNAL_KEY),
    revealPubkey: toHex(pubkey),
    tapLeafHash: toHex(c.tapLeafHash),
    controlBlock: toHex(c.controlBlock),
    leafScriptBytes: c.leafScript.length,
    contentType: content.contentType,
    bodyBytes: content.body.length,
    contentSha256: contentSha256!,
    parentId: content.parentId ?? null,
    note: 'The address commits to these exact bytes, content type, parent, metadata and reveal pubkey. Build the reveal with the same values or the commit output cannot be spent.',
  };
}

// ------------------------------------------------------------------------------------------ explain_lanes

export interface ExplainLanesInput {
  feeRate?: number | undefined;
}

export interface LaneRow {
  bodyBytes: number;
  withParent: LayoutFacts & { fee: number };
  rescue: LayoutFacts & { fee: number };
}

export interface ExplainLanesResult extends Record<string, unknown> {
  assumptions: { contentType: string; parentIndex: number; recipient: string; parentReturn: string; feeRate: number };
  lanes: Array<{ lane: Lane; maxTxWeight: number; maxVsize: number; broadcaster: string; maxBodyBytes: { withParent: number; rescue: number } }>;
  parentCostWeight: number;
  rows: LaneRow[];
  limits: typeof LIMIT_FACTS;
}

const TABLE_BODIES = [1, 1_000, 205_000, 390_000, 400_000, 1_000_000, 3_900_000, 3_960_000] as const;
const DOC_CONTENT_TYPE = 'image/webp';
/** Any 32-byte txid with index 0: the encoded parent tag is 32 bytes (trailing zero index trimmed). */
const DOC_PARENT_ID = `${'ab'.repeat(32)}i0`;

function docContent(bodyBytes: number): InscriptionContent {
  return { contentType: DOC_CONTENT_TYPE, body: new Uint8Array(bodyBytes), parentId: DOC_PARENT_ID };
}

/** Reveal weight for a body of `n` bytes under the documentation assumptions. */
export function docWeight(n: number, withParent: boolean): number {
  return estimateRevealWeight({ content: docContent(n), withParent, recipientScript: PLACEHOLDER_P2TR });
}

/** Largest body (bytes) whose reveal weight stays within `maxWeight`. Weight is monotonic in body size. */
export function maxBodyFor(maxWeight: number, withParent: boolean): number {
  let lo = 0;
  let hi = MAX_CONTENT_BYTES;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (docWeight(mid, withParent) <= maxWeight) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function explainLanes(input: ExplainLanesInput = {}): ExplainLanesResult {
  const feeRate = input.feeRate ?? 2;
  if (!(Number.isFinite(feeRate) && feeRate > 0)) throw invalid('feeRate must be a positive number (sat/vB)', { field: 'feeRate' });
  const fee = (w: number) => Number(quoteReveal({ revealWeight: w, feeRate, postage: LIMITS.DEFAULT_POSTAGE }).revealFee);
  const rows: LaneRow[] = TABLE_BODIES.map((n) => {
    const wp = docWeight(n, true);
    const r = docWeight(n, false);
    return { bodyBytes: n, withParent: { ...layoutFacts(wp), fee: fee(wp) }, rescue: { ...layoutFacts(r), fee: fee(r) } };
  });
  return {
    assumptions: { contentType: DOC_CONTENT_TYPE, parentIndex: 0, recipient: 'p2tr', parentReturn: 'p2tr', feeRate },
    lanes: [
      {
        lane: 'standard',
        maxTxWeight: LIMITS.MAX_STANDARD_TX_WEIGHT,
        maxVsize: vsizeFromWeight(LIMITS.MAX_STANDARD_TX_WEIGHT),
        broadcaster: 'any Bitcoin node (standard policy)',
        maxBodyBytes: { withParent: maxBodyFor(LIMITS.MAX_STANDARD_TX_WEIGHT, true), rescue: maxBodyFor(LIMITS.MAX_STANDARD_TX_WEIGHT, false) },
      },
      {
        lane: 'block',
        maxTxWeight: LIMITS.BLOCK_LANE_MAX_TX_WEIGHT,
        maxVsize: vsizeFromWeight(LIMITS.BLOCK_LANE_MAX_TX_WEIGHT),
        broadcaster: 'Libre Relay / Slipstream (non-standard, block-sized)',
        maxBodyBytes: { withParent: maxBodyFor(LIMITS.BLOCK_LANE_MAX_TX_WEIGHT, true), rescue: maxBodyFor(LIMITS.BLOCK_LANE_MAX_TX_WEIGHT, false) },
      },
    ],
    parentCostWeight: docWeight(1, true) - docWeight(1, false),
    rows,
    limits: LIMIT_FACTS,
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Markdown rendering of `explainLanes` for the `scribbit://docs/lanes` resource. */
export function lanesMarkdown(r: ExplainLanesResult = explainLanes()): string {
  const [std, blk] = r.lanes;
  const lines = [
    '# scribb.it lanes: Standard, Large (block lane) and Full Block',
    '',
    'A reveal transaction is either **standard** (<= 400,000 WU, relayed by every node) or goes through the',
    '**block lane** (<= 3,990,000 WU, non-standard, relayed by Libre Relay / Slipstream and mined as most of a',
    'block). "Large" and "Full Block" are both block-lane reveals; a Full Block one uses nearly all 4,000,000 WU.',
    `Beyond ${fmt(LIMITS.BLOCK_LANE_MAX_TX_WEIGHT)} WU nothing fits: \`laneFor\` returns null and \`quote_inscription\` fails with \`too_large\`.`,
    '',
    '| Lane | Max tx weight | Max vsize | Max body (with parent) | Max body (rescue layout) | Broadcaster |',
    '|---|---:|---:|---:|---:|---|',
    ...r.lanes.map((l) => `| ${l.lane} | ${fmt(l.maxTxWeight)} WU | ${fmt(l.maxVsize)} vB | ${fmt(l.maxBodyBytes.withParent)} B | ${fmt(l.maxBodyBytes.rescue)} B | ${l.broadcaster} |`),
    '',
    `Real numbers computed by \`estimateRevealWeight\` (proven exact against signed transactions) for \`${r.assumptions.contentType}\`,`,
    `a parent id with index ${r.assumptions.parentIndex}, a P2TR recipient and a P2TR parent return, fee at ${r.assumptions.feeRate} sat/vB.`,
    `The rescue layout (no parent input) inscribes the same envelope and is exactly ${r.parentCostWeight} WU lighter.`,
    '',
    `| Body bytes | Weight with parent | vsize | Lane | Fee @ ${r.assumptions.feeRate} sat/vB | Weight, rescue | Lane |`,
    '|---:|---:|---:|---|---:|---:|---|',
    ...r.rows.map(
      (row) =>
        `| ${fmt(row.bodyBytes)} | ${fmt(row.withParent.weight)} | ${fmt(row.withParent.vsize)} | ${row.withParent.lane ?? 'none'} | ${fmt(row.withParent.fee)} | ${fmt(row.rescue.weight)} | ${row.rescue.lane ?? 'none'} |`,
    ),
    '',
    `Standard lane fits up to ${fmt(std!.maxBodyBytes.withParent)} body bytes with a parent; the block lane up to ${fmt(blk!.maxBodyBytes.withParent)}.`,
    'Fee = ceil(vsize x feeRate) sats; the commit output must carry fee + postage (default 546 sats).',
    'Block-lane reveals use the oracle\'s `block.recommended` rate; standard reveals use a `standard.<tier>` rate.',
  ];
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------------- rescue_tx

export interface RescueInput {
  halfSignedPsbtBase64: string;
  network?: string | undefined;
}

export interface RescueResult extends Record<string, unknown> {
  network: Network;
  txid: string;
  inscriptionId: string;
  weight: number;
  vsize: number;
  lane: Lane | null;
  hex: string;
  note: string;
}

export function rescueTx(input: RescueInput): RescueResult {
  const network = parseNetwork(input.network);
  const psbt = normalizePsbtBase64(input.halfSignedPsbtBase64);
  let r: ReturnType<typeof buildRescueReveal>;
  try {
    r = buildRescueReveal({ network, halfSignedPsbtBase64: psbt });
  } catch (e) {
    // The PSBT is never echoed back: it is a broadcastable, RBF-able transaction.
    throw new ToolError('invalid_psbt', `not a valid half-signed reveal PSBT: ${(e as Error).message}`);
  }
  return {
    network,
    txid: r.txid,
    inscriptionId: inscriptionIdFromReveal(r.txid),
    weight: r.weight,
    vsize: r.vsize,
    lane: laneFor(r.weight),
    hex: r.hex,
    note: 'Nothing was broadcast. Send `hex` with any node (`bitcoin-cli sendrawtransaction`); the inscription lands without on-chain parent provenance. Keep the PSBT confidential until broadcast.',
  };
}

// ------------------------------------------------------------------------------------- playground_explain_step

export interface ExplainStepInput {
  step: number | string;
}

export interface ExplainStepResult extends StepExplanation, Record<string, unknown> {
  steps: string[];
  faucet: string;
}

/**
 * The Signet Playground's explanation for one step, from @bsh/scribbit-playground-kit (the same text the app shows).
 * Deliberately there is no faucet tool: an agent should not spend a shared, rate-limited faucet budget on a
 * person's behalf (ADR-0009); the person solves the proof of work in their own browser.
 */
// ------------------------------------------------------------------------------------------- ask_blockspace

export interface AskBlockspaceInput {
  question: string;
  level?: string | undefined;
  includeLiveFacts?: boolean | undefined;
  network?: string | undefined;
}

export interface AskBlockspaceResult extends AskResult, Record<string, unknown> {}

/**
 * Retrieval-grounded answer to a blockspace question, sharing the Ask Blockspace knowledge base and guardrails
 * (@bsh/blockspace-tutor-kb) with the tutor service. Read-only; refuses price/keys/mainnet-signing; never
 * fabricates a citation. Uses the injected asker (extractive by default — no model, no network).
 */
export async function askBlockspace(input: AskBlockspaceInput, ports: ScribbitMcpPorts): Promise<AskBlockspaceResult> {
  if (typeof input.question !== 'string' || input.question.trim() === '') throw invalid('question must be a non-empty string', { field: 'question' });
  if (input.level !== undefined && !(LEVELS as readonly string[]).includes(input.level)) throw invalid(`level must be one of ${LEVELS.join(', ')}`, { field: 'level' });
  const req: AskRequest = { question: input.question };
  if (input.level) req.level = input.level as AskRequest['level'];
  if (input.includeLiveFacts) req.includeLiveFacts = true;
  if (input.network) req.network = input.network;
  return { ...(await getAsker(ports).ask(req)) } as AskBlockspaceResult;
}

export function playgroundExplainStep(input: ExplainStepInput): ExplainStepResult {
  try {
    return {
      ...explainStep(input.step),
      steps: [...STEP_IDS],
      faucet: 'The playground faucet is used from the page itself (a proof of work in the visitor\'s browser). This server exposes no faucet tool on purpose.',
    };
  } catch (e) {
    if (e instanceof UnknownStepError) throw invalid(e.message, { field: 'step', allowed: [1, 2, 3, 4, 5, ...STEP_IDS] });
    throw e;
  }
}
