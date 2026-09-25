/**
 * What the wallet conformance matrix (DegentClub/specs conformance/wallets.yaml, snapshotted in
 * src/data/wallet-signet.json) says about each wallet ON SIGNET. Statuses are read from the snapshot; nothing
 * here hard-codes a wallet's status or a count.
 */
import snapshot from '../data/wallet-signet.json';
import { CAPABILITIES } from '@bsh/wallet-kit';
import type { WalletCapabilities } from '../services/types';

export type ConformanceStatus = 'verified' | 'assumed' | 'unsupported' | 'unknown';
export const STATUSES: readonly ConformanceStatus[] = ['verified', 'assumed', 'unsupported', 'unknown'];

export interface WalletSignetStatus {
  id: string;
  name: string;
  /** `network-signet` status. */
  signet: ConformanceStatus;
  /** Status of the tapscript leaf signing this playground needs from this wallet (tweaked or untweaked per wallet-kit). */
  leafSigning: ConformanceStatus;
  leafCapability: 'taproot-tweaked' | 'taproot-untweaked';
  note: string | null;
  /** Usable here at all: signet not `unsupported`. */
  usable: boolean;
  /** Proven end to end on signet: both statuses `verified`. */
  verified: boolean;
}

interface SnapshotWallet {
  id: string;
  name: string;
  results: Record<string, { status: string; note: string | null }>;
}

const asStatus = (s: string | undefined): ConformanceStatus => (STATUSES.includes(s as ConformanceStatus) ? (s as ConformanceStatus) : 'unknown');

export const CONFORMANCE_SOURCE = snapshot.source as { repo: string; path: string; asOf: string; walletKitCommit: string | null };

export function signetStatuses(): WalletSignetStatus[] {
  return (snapshot.wallets as SnapshotWallet[]).map((w) => {
    const caps = (CAPABILITIES as Record<string, WalletCapabilities | undefined>)[w.id];
    const leafCapability = caps?.tweakedLeafKey === true ? 'taproot-tweaked' : 'taproot-untweaked';
    const signet = asStatus(w.results['network-signet']?.status);
    const leafSigning = asStatus(w.results[leafCapability]?.status);
    return {
      id: w.id,
      name: w.name,
      signet,
      leafSigning,
      leafCapability,
      note: w.results['network-signet']?.note ?? null,
      usable: signet !== 'unsupported',
      verified: signet === 'verified' && leafSigning === 'verified',
    };
  });
}

export function statusFor(id: string): WalletSignetStatus | undefined {
  return signetStatuses().find((s) => s.id === id);
}

export const STATUS_COPY: Record<ConformanceStatus, string> = {
  verified: 'verified on a real wallet',
  assumed: 'assumed, not yet verified on a real wallet',
  unsupported: 'not supported',
  unknown: 'unknown: nothing settles it yet',
};

/** A one-line summary computed from the snapshot, e.g. "0 of 7 wallets verified on signet". */
export function summaryLine(list = signetStatuses()): string {
  const verified = list.filter((s) => s.verified).length;
  const unsupported = list.filter((s) => !s.usable).length;
  return `${verified} of ${list.length} wallets verified on signet; ${unsupported} not supported on signet (conformance matrix as of ${CONFORMANCE_SOURCE.asOf}).`;
}
