/**
 * Ports of the playground. Real adapters in `./real/*`, fakes in `./fakes.ts` (tests and `?demo=1`). The maths
 * (`InscriptionOps`, from the mint) is never faked; demo mode builds and signs real transactions.
 */
import type { InscriptionOps, SignPsbtRequest, SignPsbtResult, Utxo, WalletAccount, WalletCapabilities, WalletId, WalletService, WalletSession } from '@bsh/scribbit-mint/src/services/types';
import type { RevealSigningPlan } from '@bsh/scribbit-mint/src/lib/walletRouting';

export type { InscriptionOps, SignPsbtRequest, SignPsbtResult, Utxo, WalletAccount, WalletCapabilities, WalletId, WalletService, WalletSession, RevealSigningPlan };

// ------------------------------------------------------------------ faucet (contracts/openapi/scribbit-signet-faucet.yaml)

export interface FaucetChallenge {
  algorithm: 'sha256-leading-zero-bits/v1';
  nonce: string;
  difficulty: number;
  expiresAt: string;
  ttlSeconds: number;
  message: string;
}

export interface FaucetDrip {
  network: 'signet';
  address: string;
  amountSats: number;
  txid: string;
  explorerUrl?: string;
}

/** A refusal from the faucet: `code` is the contract's `Error.error.code`. */
export class FaucetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'FaucetError';
  }
}

export interface FaucetApi {
  /** False when no faucet URL is configured (live mode without a faucet). */
  readonly configured: boolean;
  challenge(): Promise<FaucetChallenge>;
  drip(req: { address: string; nonce: string; solution: string }): Promise<FaucetDrip>;
}

// ------------------------------------------------------------------ chain (Esplora-compatible signet API)

export class BroadcastRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`The signet node refused the transaction: ${reason}`);
    this.name = 'BroadcastRejectedError';
  }
}

export interface TxStatus {
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
}

export interface ChainApi {
  getUtxos(address: string): Promise<Utxo[]>;
  getTx(txid: string): Promise<TxStatus | null>;
  /** sat/vB for the next few blocks. */
  getFeeRate(): Promise<number>;
  /** The broadcaster port: relays a signed raw transaction, returns its txid. Throws BroadcastRejectedError. */
  broadcast(hex: string): Promise<string>;
}

// ------------------------------------------------------------------ analytics (optional, anonymous)

/** The ONLY thing the playground ever sends: no address, no txid, no id, no timestamp beyond the server's own. */
export interface QuizEvent {
  event: 'playground.quiz';
  version: string;
  passed: boolean;
  score: number;
  total: number;
}

export interface Analytics {
  readonly enabled: boolean;
  send(e: QuizEvent): Promise<void>;
}

// ------------------------------------------------------------------ the signer the flow talks to

/**
 * A wallet as the playground sees it: either the in-browser throwaway key or a real wallet via wallet-kit. One
 * address both pays and receives for the throwaway key; real wallets may have two.
 */
export interface PlaygroundWallet {
  kind: 'throwaway' | 'external';
  name: string;
  ordinals: WalletAccount;
  payment: WalletAccount;
  /** Which key the inscription leaf names and how the reveal input is signed. */
  plan: RevealSigningPlan;
  signPsbt(psbtBase64: string, req: SignPsbtRequest): Promise<SignPsbtResult>;
  /** The wallet-kit session, for real wallets. */
  session?: WalletSession;
}

export interface Services {
  mode: 'live' | 'demo';
  faucet: FaucetApi;
  chain: ChainApi;
  analytics: Analytics;
  wallets: WalletService;
  inscription: InscriptionOps;
}
