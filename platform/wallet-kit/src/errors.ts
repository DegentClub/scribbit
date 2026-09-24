import type { AddressType, Network, WalletId } from './types.js';

/**
 * Stable machine-readable codes. UI and telemetry switch on `code`, never on
 * `message` or `instanceof` across bundles. Never rename a code; add new ones.
 */
export type WalletErrorCode =
  | 'WALLET_NOT_INSTALLED'
  | 'USER_REJECTED'
  | 'UNSUPPORTED_NETWORK'
  | 'UNSUPPORTED_ADDRESS_TYPE'
  | 'UNSUPPORTED_METHOD'
  | 'UNKNOWN_WALLET'
  | 'INVALID_PSBT'
  | 'INVALID_REQUEST'
  | 'ADDRESS_NOT_IN_WALLET'
  | 'NOT_CONNECTED'
  | 'WALLET_ERROR';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly walletId: WalletId | undefined;

  constructor(code: WalletErrorCode, message: string, opts: { walletId?: WalletId; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WalletError';
    this.code = code;
    this.walletId = opts.walletId;
  }
}

export class WalletNotInstalledError extends WalletError {
  declare readonly code: 'WALLET_NOT_INSTALLED';
  constructor(walletId: WalletId, message = `${walletId} wallet is not installed in this browser.`) {
    super('WALLET_NOT_INSTALLED', message, { walletId });
    this.name = 'WalletNotInstalledError';
  }
}

export class UserRejectedError extends WalletError {
  declare readonly code: 'USER_REJECTED';
  constructor(walletId?: WalletId, cause?: unknown, message = 'You cancelled the request in your wallet.') {
    super('USER_REJECTED', message, { ...(walletId ? { walletId } : {}), cause });
    this.name = 'UserRejectedError';
  }
}

export class UnsupportedNetworkError extends WalletError {
  declare readonly code: 'UNSUPPORTED_NETWORK';
  readonly network: Network;
  constructor(walletId: WalletId, network: Network, message?: string) {
    super('UNSUPPORTED_NETWORK', message ?? `${walletId} does not support ${network}, or is set to a different network.`, {
      walletId,
    });
    this.name = 'UnsupportedNetworkError';
    this.network = network;
  }
}

export class UnsupportedAddressTypeError extends WalletError {
  declare readonly code: 'UNSUPPORTED_ADDRESS_TYPE';
  readonly addressType: AddressType;
  readonly address: string;
  constructor(address: string, addressType: AddressType, message?: string) {
    super(
      'UNSUPPORTED_ADDRESS_TYPE',
      message ??
        `Address type ${addressType} is not supported here; switch your wallet to a native segwit (bc1q) or taproot (bc1p) account.`,
    );
    this.name = 'UnsupportedAddressTypeError';
    this.address = address;
    this.addressType = addressType;
  }
}

export class UnsupportedMethodError extends WalletError {
  declare readonly code: 'UNSUPPORTED_METHOD';
  constructor(walletId: WalletId, message: string) {
    super('UNSUPPORTED_METHOD', message, { walletId });
    this.name = 'UnsupportedMethodError';
  }
}

export function isWalletError(e: unknown): e is WalletError {
  return typeof e === 'object' && e !== null && e instanceof WalletError;
}

/** EIP-1193 user rejection (UniSat, OKX, Leather). */
const EIP1193_USER_REJECTED = 4001;
/** sats-connect RpcErrorCode.USER_REJECTION (Xverse, Magic Eden). */
const SATS_CONNECT_USER_REJECTION = -32000;

const REJECTION_TEXT = /user (rejected|denied|cancel+ed|canceled|declined)|rejected by (the )?user|request (was )?(rejected|cancel+ed)|cancel+ed by user|user_rejection/i;

function errorCode(e: unknown): number | string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const o = e as { code?: unknown; error?: unknown };
  if (typeof o.code === 'number' || typeof o.code === 'string') return o.code;
  if (typeof o.error === 'object' && o.error !== null) return errorCode(o.error);
  return undefined;
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (typeof e !== 'object' || e === null) return String(e);
  const o = e as { message?: unknown; error?: unknown };
  if (typeof o.message === 'string' && o.message) return o.message;
  if (typeof o.error === 'string') return o.error;
  if (typeof o.error === 'object' && o.error !== null) return errorMessage(o.error);
  return 'Unknown wallet error';
}

/** True for every user-rejection shape we know of across the supported wallets. */
export function isUserRejection(e: unknown): boolean {
  const code = errorCode(e);
  if (code === EIP1193_USER_REJECTED || code === SATS_CONNECT_USER_REJECTION || code === 'USER_REJECTION') return true;
  return REJECTION_TEXT.test(errorMessage(e));
}

/** Normalise anything a provider throws into a WalletError subclass. */
export function toWalletError(e: unknown, walletId: WalletId): WalletError {
  if (isWalletError(e)) return e;
  if (isUserRejection(e)) return new UserRejectedError(walletId, e);
  return new WalletError('WALLET_ERROR', `${walletId}: ${errorMessage(e)}`, { walletId, cause: e });
}
