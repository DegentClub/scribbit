/** Helpers shared by the adapters. Not exported from the package root. */
import { addressMatchesNetwork, detectAddressType } from './address.js';
import { UnsupportedNetworkError, WalletError, toWalletError } from './errors.js';
import { taprootOutputKeyOf } from './taproot.js';
import type { AddressPurpose, ConnectedWallet, Network, SignPsbtOptions, WalletAccount, WalletId } from './types.js';

/** The page's global object, or undefined outside a browser. Read at call time so tests can inject providers. */
export function browserWindow(): Record<string, unknown> | undefined {
  const w = (globalThis as { window?: unknown }).window;
  return typeof w === 'object' && w !== null ? (w as Record<string, unknown>) : undefined;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function account(address: string, publicKey: string, purpose: AddressPurpose): WalletAccount {
  return { address, publicKey, purpose, addressType: detectAddressType(address) };
}

/** `{ taprootOutputKey }` for a p2tr ordinals account, `{}` otherwise (spread into a ConnectedWallet). */
export function withTaprootOutputKey(ordinals: WalletAccount): { taprootOutputKey?: string } {
  const key = ordinals.addressType === 'p2tr' ? taprootOutputKeyOf(ordinals) : undefined;
  return key ? { taprootOutputKey: key } : {};
}

/** Throws UnsupportedNetworkError unless every account's address belongs to `network`. */
export function assertAccountsOnNetwork(id: WalletId, network: Network, accounts: WalletAccount[]): void {
  for (const a of accounts) {
    if (!addressMatchesNetwork(a.address, network)) {
      throw new UnsupportedNetworkError(
        id,
        network,
        `${id} returned ${a.address}, which is not a ${network} address. Switch the wallet to ${network} and connect again.`,
      );
    }
  }
}

export function assertNetworkSupported(id: WalletId, network: Network, supported: readonly Network[]): void {
  if (!supported.includes(network)) {
    throw new UnsupportedNetworkError(id, network, `${id} does not support ${network} (supported: ${supported.join(', ')}).`);
  }
}

/**
 * Validate `inputsToSign` against the connected accounts. Rejecting an address
 * the wallet does not own here gives a clear error instead of a wallet that
 * silently skips the input (or, for index-only wallets, signs the wrong one).
 */
export function validateInputsToSign(id: WalletId, opts: SignPsbtOptions, owned: WalletAccount[]): void {
  if (!opts || !Array.isArray(opts.inputsToSign) || opts.inputsToSign.length === 0) {
    throw new WalletError('INVALID_REQUEST', 'signPsbt: inputsToSign must list at least one input.', { walletId: id });
  }
  const seen = new Set<number>();
  const addrs = new Set(owned.map((a) => a.address));
  for (const input of opts.inputsToSign) {
    if (!Number.isInteger(input.index) || input.index < 0) {
      throw new WalletError('INVALID_REQUEST', `signPsbt: invalid input index ${String(input.index)}.`, { walletId: id });
    }
    if (seen.has(input.index)) {
      throw new WalletError('INVALID_REQUEST', `signPsbt: input ${input.index} listed twice.`, { walletId: id });
    }
    seen.add(input.index);
    if (!addrs.has(input.address)) {
      throw new WalletError(
        'ADDRESS_NOT_IN_WALLET',
        `signPsbt: input ${input.index} is assigned to ${input.address}, which is not a connected ${id} address.`,
        { walletId: id },
      );
    }
  }
}

export function assertOwnAddress(id: WalletId, address: string, owned: WalletAccount[]): WalletAccount {
  const a = owned.find((x) => x.address === address);
  if (!a) {
    throw new WalletError('ADDRESS_NOT_IN_WALLET', `${address} is not a connected ${id} address.`, { walletId: id });
  }
  return a;
}

/** Group inputs by address → indexes (the sats-connect / Horizon `signInputs` shape). */
export function signInputsMap(opts: SignPsbtOptions): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const i of opts.inputsToSign) (out[i.address] ??= []).push(i.index);
  return out;
}

/** Wrap a provider call so every failure surfaces as a WalletError subclass. */
export async function guard<T>(id: WalletId, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toWalletError(e, id);
  }
}

/**
 * JSON-RPC style `request(method, params)` as spoken by sats-connect providers
 * (Xverse, Magic Eden) and Leather. Handles every failure shape seen in the wild:
 * resolved `{ result }`, resolved `{ error }` (sats-connect providers resolve
 * errors as envelopes), rejected `{ error: {code,message} }` (Leather), and
 * plain thrown errors.
 */
export interface RpcProvider {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** JSON-RPC METHOD_NOT_FOUND. */
export const METHOD_NOT_FOUND = -32601;

export class RpcError extends Error {
  constructor(
    readonly code: number | string | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function rpcErrorFrom(err: unknown): RpcError {
  if (isObject(err)) {
    const code = typeof err.code === 'number' || typeof err.code === 'string' ? err.code : undefined;
    const message = typeof err.message === 'string' ? err.message : 'Wallet request failed';
    return new RpcError(code, message, err.data);
  }
  return new RpcError(undefined, typeof err === 'string' ? err : 'Wallet request failed');
}

export async function rpcRequest<T>(p: RpcProvider, method: string, params?: unknown): Promise<T> {
  let res: unknown;
  try {
    res = await p.request(method, params);
  } catch (thrown) {
    if (isObject(thrown) && 'error' in thrown && thrown.error != null) throw rpcErrorFrom(thrown.error);
    throw thrown;
  }
  if (isObject(res)) {
    if ('error' in res && res.error != null) throw rpcErrorFrom(res.error);
    if (res.status === 'error') throw rpcErrorFrom(res.error ?? res);
    if ('result' in res) return res.result as T;
  }
  return res as T;
}

export function isMethodNotFound(e: unknown): boolean {
  return (
    isObject(e) &&
    (e.code === METHOD_NOT_FOUND || (typeof e.message === 'string' && /method not (found|supported)|unsupported method/i.test(e.message)))
  );
}

/** Best-effort call: failures are swallowed (used for disconnect). */
export async function quietly(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    /* best effort */
  }
}

export type WalletBase = Omit<ConnectedWallet, 'signPsbt' | 'signMessage' | 'disconnect' | 'pushTx' | 'onAccountsChanged'>;
