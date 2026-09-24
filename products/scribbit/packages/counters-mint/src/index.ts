/**
 * @bsh/scribbit-counters — Bitcoin Counters mint engine.
 *
 * Framework-free: no React, no fetch at import time (fetch is injected into
 * the clients), Uint8Array/bigint only. See README.md for the model.
 */

// Types the app codes against
export type { MintKind, MintEstimate, EstimateMintArgs } from './estimate.js';
export type { ComposeResult } from './compose.js';
export type { CpClient, CpClientOptions, AssetInfo, OwnedAsset, ComposeType } from './cp.js';
export type { Network } from './network.js';
export type { Utxo, Outpoint, RevealSighash, CommitPsbt, CommitPsbtArgs, RevealPsbtArgs } from './psbt.js';
export type { CommitEnvelope } from './envelope.js';
export type { EncodedContent } from './content.js';
export type { FairminterParams } from './fairminter.js';
export type { Xcp69Launch, Xcp69Shape } from './xcp69.js';
export type { MintStage, MintPlan, MintPlanFacts, PendingMint, FairminterPreset } from './plan.js';
export type { KV } from './pending.js';
export type { AssetNameClass, AssetNameKind } from './assetnames.js';
export type { SlipstreamRates, Verdict, RevealRoute, RouteFit, SlipstreamClient, SlipstreamClientOptions, RatesResult, SubmitResult, RevealJob, JobPhase } from './slipstream.js';
export type { Raw } from './numeric.js';

// Counterparty client
export { createCpClient, CpError, CpNotFound, commonComposeParams, supplyParams } from './cp.js';

// Asset names
export { classifyAssetName, issuanceBurnXcp, randomNumericAsset } from './assetnames.js';

// Content
export { encodeContent, classifyMimeType, guessContentType } from './content.js';

// Envelope and keys
export { reKeyEnvelope, newRevealKey, revealKeyFromHex, xOnlyPubkey, commitEnvelope, detectOrdEnvelope, NUMS_INTERNAL_KEY, LEAF_VERSION } from './envelope.js';

// Transactions
export { buildCommitPsbt, buildRevealPsbt, buildPlainPsbt, finalize, unsignedRevealTxid, signRevealLocally, commitTopUp, revealWeightOf, revealOutputTotal, coreCommitOutput } from './psbt.js';

// Fees and sizes
export { estimateMint, STANDARD_WITNESS_LIMIT_WU } from './estimate.js';

// Fairminters
export { fairminterProblems, fairminterComposeParams } from './fairminter.js';
export { XCP69, XCP69_TEMPLATE, xcp69Params, xcp69Schedule, xcp69ComposeParams, matchesXcp69Template, isXcp69Conformant, XCP69_MIN_START_LEAD, XCP69_DEFAULT_START_LEAD } from './xcp69.js';

// Pending mints and the state machine
export { savePendingMint, loadPendingMint, clearPendingMint, memoryKV, PENDING_MINT_KEY } from './pending.js';
export { MINT_TRANSITIONS, canTransition } from './plan.js';

// Routing and Slipstream
export {
  routeFor,
  routeFitForWeight,
  meetsFloor,
  classify,
  parseRates,
  createSlipstreamClient,
  MAX_WEIGHT,
  STANDARD_MAX_WEIGHT,
  OversizedRevealError,
  NonStandardRevealError,
  BelowSlipstreamFloorError,
} from './slipstream.js';

// Numeric helpers for compose parameters and lossless API parsing
export { parseJsonLossless, big, toBigInt, quantityParam } from './numeric.js';
export { hexToBytes, bytesToHex } from './bytes.js';
