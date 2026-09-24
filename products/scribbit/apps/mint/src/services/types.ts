/**
 * Ports: every external interaction of the mint goes through one of these small interfaces. Real
 * adapters live in `./real/*` (wallet-kit, the mint API, @bsh/inscription, @bsh/scribbit-counters);
 * fakes live in `./fakes.ts` and power the tests and `?demo=1`.
 *
 * Money rule: nothing here ever holds a user's private key. The wallet signs every transaction; the
 * app only builds PSBTs, checks what came back, and broadcasts.
 */
import type { InscriptionContent, Network } from '@bsh/inscription';

// ---------------------------------------------------------------- wallet

/** wallet-kit's five plus the two Counterparty wallets (frozen sibling interface). */
export type WalletId = 'unisat' | 'xverse' | 'leather' | 'okx' | 'magiceden' | 'xcp' | 'horizon';
export type AddressType = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'unknown';

export interface WalletAccount {
  address: string;
  /** Hex as the wallet reports it: 33-byte compressed or 32-byte x-only. */
  publicKey: string;
  addressType: AddressType;
}

/** Mirrors @bsh/wallet-kit `WalletCapabilities` (`'unknown'` = no reference code; see the kit README). */
export interface WalletCapabilities {
  /** Can relay a signed transaction itself (`pushTx` or `broadcast: true`). Otherwise the app uses Esplora. */
  broadcast: boolean;
  /** Can prove address ownership with BIP-322. */
  bip322: boolean;
  /** Can sign a taproot script-path (tapscript) input: needed for every reveal. */
  tapscript: boolean | 'unknown';
  /**
   * Signs tapscript inputs with the TWEAKED output key (the bc1p witness program), so the leaf must name
   * that key. Otherwise the leaf names the untweaked internal key and the wallet is asked to `disableTweak`.
   */
  tweakedLeafKey: boolean | 'unknown';
}

export interface WalletOption {
  id: WalletId;
  name: string;
  installed: boolean;
  installUrl: string;
  capabilities: WalletCapabilities;
  /** The kit README marks this wallet's tapscript signing ASSUMED (no reference code): test on signet first. */
  unverified: boolean;
}

export interface InscriptionSignContext {
  /** The tapscript leaf, hex (XCP Wallet reads it to approve a commit). */
  envelopeScriptHex: string;
  commitAddress: string;
}

export interface SignPsbtRequest {
  inputsToSign: Array<{ index: number; address: string; disableTweak?: boolean }>;
  inscription?: InscriptionSignContext;
  finalize?: boolean;
  broadcast?: boolean;
}

export interface SignPsbtResult {
  psbtBase64: string;
  txid?: string;
}

export interface WalletSession {
  id: WalletId;
  name: string;
  network: Network;
  ordinals: WalletAccount;
  payment: WalletAccount;
  capabilities: WalletCapabilities;
  /** x-only tweaked output key of the ordinals address, hex, when it is taproot. */
  taprootOutputKey?: string;
  signPsbt(psbtBase64: string, req: SignPsbtRequest): Promise<SignPsbtResult>;
  pushTx?(hex: string): Promise<string>;
  disconnect(): Promise<void>;
}

export interface WalletService {
  list(): WalletOption[];
  connect(id: WalletId, network: Network): Promise<WalletSession>;
}

// ---------------------------------------------------------------- mint api (fees + esplora)

export interface FeeSnapshot {
  minFeeRate: number;
  standard: { slow: number; normal: number; fast: number };
  block: { min: number; recommended: number };
  fetchedAt: string;
  stale: boolean;
}

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export interface TxStatus {
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
}

export interface ChainApi {
  getFees(): Promise<FeeSnapshot>;
  getUtxos(address: string): Promise<Utxo[]>;
  /** null when the transaction is unknown to the backend (not in its mempool or chain). */
  getTx(txid: string): Promise<TxStatus | null>;
  broadcast(hex: string): Promise<string>;
  /** The inscribed bytes as the ord server serves them; null while not indexed yet. */
  getInscriptionContent(inscriptionId: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------- ordinals maths (@bsh/inscription)

export interface RevealQuote {
  weight: number;
  vsize: number;
  lane: 'standard' | 'block' | null;
  revealFee: bigint;
  commitValue: bigint;
}

export interface UnsignedReveal {
  psbtBase64: string;
  inputIndex: number;
  leafScriptHex: string;
  commitAddress: string;
}

export interface FinalizedTx {
  hex: string;
  txid: string;
  weight: number;
  vsize: number;
}

export interface InscriptionOps {
  sha256Hex(bytes: Uint8Array): string;
  /** Commit address for this leaf key + content. */
  commitAddress(leafPubkey: Uint8Array, content: InscriptionContent, network: Network): string;
  quote(args: { content: InscriptionContent; recipientAddress: string; network: Network; feeRate: number; postage: bigint }): RevealQuote;
  buildUnsignedReveal(args: {
    network: Network;
    leafPubkey: Uint8Array;
    content: InscriptionContent;
    commitOutpoint: { txid: string; vout: number };
    commitValue: bigint;
    recipientAddress: string;
    postage: bigint;
    sighash?: 'default' | 'all';
  }): UnsignedReveal;
  buildUnsignedRescue(args: {
    network: Network;
    leafPubkey: Uint8Array;
    content: InscriptionContent;
    commitOutpoint: { txid: string; vout: number };
    commitValue: bigint;
    recipientAddress: string;
    postage: bigint;
    sighash?: 'default' | 'all';
  }): { psbtBase64: string; inputIndex: number; fee: bigint };
  /** Verifies the wallet's leaf signature and assembles the raw transaction; throws with the reason. */
  finalizeWalletSignedReveal(psbtBase64: string): FinalizedTx;
}

// ---------------------------------------------------------------- counters (Counterparty node + engine)

export interface AssetInfo {
  asset: string;
  owner: string;
  divisible: boolean;
  locked: boolean;
  descriptionLocked: boolean;
  supply: bigint;
}

export interface OwnedAsset {
  asset: string;
  divisible: boolean;
  descriptionLocked: boolean;
  mimeType: string | null;
}

/** Counterparty Core v11 `compose/*` result with `encoding=taproot&verbose=true` (the fields the engine reads). */
export interface ComposeResult {
  rawtransaction?: string;
  envelope_script?: string;
  signed_reveal_rawtransaction?: string;
  btc_fee?: number;
  btc_change?: number;
  inputs_values?: number[];
  lock_scripts?: string[];
  signed_tx_estimated_size?: { vsize: number; adjusted_vsize: number; sigops_count: number };
  [k: string]: unknown;
}

export interface CpClient {
  /** null when nobody has issued it; throws when the node cannot be asked. */
  getAsset(name: string): Promise<AssetInfo | null>;
  /** Raw units (1 XCP = 1e8). */
  getBalance(address: string, asset: string): Promise<bigint>;
  getOwnedAssets(address: string): Promise<OwnedAsset[]>;
  getTip(): Promise<number>;
  compose(address: string, type: 'issuance' | 'fairminter', params: Record<string, string>): Promise<ComposeResult>;
  /** Relay through the node (`POST bitcoin/transactions`). */
  broadcast(hex: string): Promise<string>;
  /** Does the node know this txid? (a relay's "yes" is a claim; this is the check) */
  knowsTx(txid: string): Promise<boolean>;
}

export type MintKind = 'counter' | 'reinscription' | 'fairminter';
export type FairminterPreset = 'xcp69' | 'custom';

export interface FairminterParams {
  lotPrice: bigint;
  lotSize: bigint;
  hardCap: bigint;
  softCap: bigint;
  poolQuantity: bigint;
  maxMintPerTx: bigint;
  maxMintPerAddress: bigint;
  premintQuantity: bigint;
  mintedAssetCommission: number;
  burnPayment: boolean;
  lockQuantity: boolean;
  lockDescription: boolean;
  divisible: boolean;
  startBlock: number;
  endBlock: number;
  softCapDeadlineBlock: number;
  lpAsset?: string;
}

export type AssetNameKind = 'named' | 'numeric' | 'subasset';
export type AssetNameCheck = { ok: true; kind: AssetNameKind; parent?: string } | { ok: false; reason: string };

export interface CountersEstimate {
  revealWeight: number;
  revealVsize: number;
  revealFee: number;
  commitValue: number;
  revealOutputs: number;
  xcpBurn: bigint;
  standardRelay: boolean;
}

export interface CountersCommit {
  psbtBase64: string;
  commitValue: number;
  commitVout: number;
  inputsToSign: number[];
  commitAddress: string;
  /** The re-keyed leaf, hex: what XCP Wallet's inscription context wants. */
  leafHex: string;
  fee: number;
}

/**
 * The counters engine (pure, no I/O): name rules, sizing, envelope re-keying, PSBT surgery. Real adapter:
 * `@bsh/scribbit-counters`. Both the live app and demo mode use the real maths; only I/O is faked.
 */
export interface CountersKit {
  STANDARD_WITNESS_LIMIT_WU: number;
  checkAssetName(name: string): AssetNameCheck;
  randomNumericAsset(): string;
  /** Raw XCP burned to issue this name (0.5 XCP for a named asset). */
  issuanceBurnXcp(name: string): bigint;
  encodeContent(body: Uint8Array, mimeType: string): { description: string; classification: 'text' | 'binary' };
  estimate(args: { bytes: number; feeRate: number; kind: MintKind; assetName?: string; mimeType?: string; quantity?: bigint; fairminter?: FairminterParams }): CountersEstimate;
  xcp69Params(startBlock: number, lpAsset?: string): FairminterParams;
  /** XCP-69 must confirm before it starts: start = tip + lead (default 3). */
  xcp69Schedule(tip: number, lead?: number): { startBlock: number; deadlineBlock: number };
  /** Non-throwing route answer for a reveal weight. */
  routeFit(weight: number): 'public' | 'slipstream' | 'too-large';
  fairminterProblems(p: FairminterParams): string[];
  fairminterComposeParams(p: FairminterParams, asset: string): Record<string, string>;
  /** Exact weight of the SIGHASH_ALL reveal Core's compose implies (Core's + 1 WU). */
  revealWeightOf(compose: ComposeResult): number;
  commitTopUp(compose: ComposeResult, feeRate: number): number;
  buildCommitPsbt(args: { network: Network; compose: ComposeResult; leafKey32: Uint8Array; topUpSats: number }): CountersCommit;
  buildRevealPsbt(args: { network: Network; compose: ComposeResult; leafKey32: Uint8Array; commitOutpoint: { txid: string; vout: number }; commitValue: number; destinationAddress: string }): { psbtBase64: string; inputIndex: number };
  finalize(signedPsbtBase64: string): FinalizedTx;
  unsignedRevealTxid(psbtBase64: string): string;
}

// ---------------------------------------------------------------- bundle

export interface Services {
  mode: 'live' | 'demo';
  wallets: WalletService;
  chain: ChainApi;
  inscription: InscriptionOps;
  cp: CpClient;
  counters: CountersKit;
}
