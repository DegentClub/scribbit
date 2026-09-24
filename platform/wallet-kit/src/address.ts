import { base58, bech32, bech32m } from '@scure/base';
import { UnsupportedAddressTypeError } from './errors.js';
import type { AddressType, Network, WalletAccount } from './types.js';

/**
 * Which chain family an address belongs to. Testnet and signet share every
 * prefix, so they are indistinguishable from the address alone.
 */
export type AddressNetwork = 'mainnet' | 'testnet-or-signet' | 'regtest';

const SEGWIT_HRP: Record<string, AddressNetwork> = { bc: 'mainnet', tb: 'testnet-or-signet', bcrt: 'regtest' };

/** Base58 version bytes → (type, network). */
const BASE58_VERSION: Record<number, { type: AddressType; network: AddressNetwork }> = {
  0x00: { type: 'p2pkh', network: 'mainnet' },
  0x05: { type: 'p2sh-p2wpkh', network: 'mainnet' },
  0x6f: { type: 'p2pkh', network: 'testnet-or-signet' },
  0xc4: { type: 'p2sh-p2wpkh', network: 'testnet-or-signet' },
};

export interface AddressInfo {
  type: AddressType;
  network: AddressNetwork | undefined;
}

type Decoded = { prefix: string; words: number[] };
function decode(coder: typeof bech32, s: string): Decoded | undefined {
  return (coder.decodeUnsafe(s, 90) as Decoded | undefined) ?? undefined;
}

/** Witness version and program of a segwit address, or undefined when it is not one (or fails its checksum). */
export function segwitProgram(address: string): { version: number; program: Uint8Array } | undefined {
  const lower = address.trim().toLowerCase();
  if (address.trim() !== lower && address.trim() !== address.trim().toUpperCase()) return undefined;
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || !SEGWIT_HRP[lower.slice(0, sep)]) return undefined;
  const v0 = decode(bech32, lower);
  const v1plus = decode(bech32m, lower);
  const decoded = v0 && v0.words[0] === 0 ? v0 : v1plus && (v1plus.words[0] ?? 0) >= 1 ? v1plus : undefined;
  if (!decoded) return undefined;
  try {
    return { version: decoded.words[0]!, program: bech32.fromWords(decoded.words.slice(1)) };
  } catch {
    return undefined;
  }
}

function decodeSegwit(address: string): AddressInfo | undefined {
  const lower = address.toLowerCase();
  // Mixed case is invalid bech32 (BIP-173).
  if (address !== lower && address !== address.toUpperCase()) return undefined;
  const sep = lower.lastIndexOf('1');
  if (sep < 1) return undefined;
  const network = SEGWIT_HRP[lower.slice(0, sep)];
  if (!network) return undefined;
  // BIP-350: v0 must use bech32, v1+ must use bech32m. The wrong variant fails its checksum.
  const v0 = decode(bech32, lower);
  const v1plus = decode(bech32m, lower);
  const decoded = v0 && v0.words[0] === 0 ? v0 : v1plus && (v1plus.words[0] ?? 0) >= 1 ? v1plus : undefined;
  if (!decoded) return undefined;
  const version = decoded.words[0]!;
  let program: Uint8Array;
  try {
    program = bech32.fromWords(decoded.words.slice(1));
  } catch {
    return undefined;
  }
  if (version === 0 && program.length === 20) return { type: 'p2wpkh', network };
  if (version === 1 && program.length === 32) return { type: 'p2tr', network };
  // p2wsh (v0/32) and future versions are valid but not account types we support.
  return { type: 'unknown', network };
}

function decodeBase58(address: string): AddressInfo | undefined {
  if (address.length < 26 || address.length > 35) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    return undefined;
  }
  // version (1) + hash160 (20) + checksum (4). The checksum is not verified here
  // (it needs SHA-256); the classifier only reads addresses the wallet itself produced.
  if (bytes.length !== 25) return undefined;
  const v = BASE58_VERSION[bytes[0]!];
  return v ? { type: v.type, network: v.network } : undefined;
}

/**
 * Classify an address by its encoding and prefix:
 *
 * | prefix | type |
 * |---|---|
 * | `bc1p` / `tb1p` / `bcrt1p` (bech32m, 32-byte program) | `p2tr` |
 * | `bc1q` / `tb1q` / `bcrt1q` (bech32, 20-byte program) | `p2wpkh` |
 * | `3` / `2` (base58, P2SH version) | `p2sh-p2wpkh` (assumed nested segwit: the only P2SH account wallets hand out) |
 * | `1` / `m` / `n` (base58, P2PKH version) | `p2pkh` |
 * | anything else, bad checksum, p2wsh | `unknown` |
 */
export function getAddressInfo(address: string): AddressInfo {
  const a = address.trim();
  return decodeSegwit(a) ?? decodeBase58(a) ?? { type: 'unknown', network: undefined };
}

export function detectAddressType(address: string): AddressType {
  return getAddressInfo(address).type;
}

export function detectAddressNetwork(address: string): AddressNetwork | undefined {
  return getAddressInfo(address).network;
}

/** Whether an address can belong to the given network (testnet and signet share prefixes). */
export function addressMatchesNetwork(address: string, network: Network): boolean {
  const n = detectAddressNetwork(address);
  if (n === undefined) return false;
  if (network === 'mainnet') return n === 'mainnet';
  if (network === 'regtest') return n === 'regtest';
  return n === 'testnet-or-signet';
}

/** True for native segwit, nested segwit and taproot. */
export function isSegwit(type: AddressType): boolean {
  return type === 'p2tr' || type === 'p2wpkh' || type === 'p2sh-p2wpkh';
}

/**
 * The degent mint computes the funding txid from the *unsigned* transaction
 * (ADR-0002 §2 step 3) and pre-signs the reveal against it. That only holds when
 * every funding input is segwit: a legacy (p2pkh) scriptSig changes the txid on
 * signing. Call this before building the funding PSBT; it throws
 * {@link UnsupportedAddressTypeError} for p2pkh and for anything unrecognised.
 */
export function requireSegwitPayment(account: WalletAccount): WalletAccount {
  const type = account.addressType === 'unknown' ? detectAddressType(account.address) : account.addressType;
  if (!isSegwit(type)) {
    throw new UnsupportedAddressTypeError(
      account.address,
      type,
      type === 'p2pkh'
        ? 'Legacy (1…/m…/n…) payment addresses cannot fund a mint: the funding txid must be known before signing. Switch your wallet to a native segwit (bc1q) or taproot (bc1p) account.'
        : undefined,
    );
  }
  return account;
}
