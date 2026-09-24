/**
 * Which key goes in the leaf, and what the wallet is asked to do, per wallet capability. This is the one
 * place the app reasons about wallet differences; everything else takes a `RevealSigningPlan`.
 *
 * - `tweakedLeafKey`: the leaf names the taproot OUTPUT key (the bc1p witness program) and the wallet signs
 *   with its default (tweaked) key. XCP Wallet verifies the leaf against exactly this key.
 * - otherwise: the leaf names the untweaked internal x-only key and the wallet is asked to `disableTweak`
 *   (UniSat/OKX `disableTweakSigner`).
 * - `tapscript: false`: the wallet cannot sign a script-path input at all: the reveal is refused before
 *   the commit is funded (a commit nobody can reveal would strand the funds).
 */
import { hex } from '@scure/base';
import { Address, NETWORK, TEST_NETWORK } from '@scure/btc-signer';
import type { WalletCapabilities, WalletId, WalletSession } from '../services/types';
import { UserFacingError } from './errors';

export interface RevealSigningPlan {
  /** 32-byte x-only key named by the leaf. */
  leafPubkey: Uint8Array;
  leafKeyKind: 'output' | 'internal';
  /** Sighash the wallet is asked for on the reveal input. XCP Wallet refuses SIGHASH_DEFAULT. */
  sighash: 'default' | 'all';
  inputToSign: { index: number; address: string; disableTweak?: boolean };
  /** Where the signed reveal goes: the wallet's own relay or Esplora through the mint API. */
  broadcastVia: 'wallet' | 'esplora';
}

/** x-only taproot output key of a bc1p address (the 32-byte witness program), or null. */
export function taprootOutputKey(address: string): Uint8Array | null {
  try {
    const a = address.toLowerCase();
    const net = a.startsWith('bcrt1') ? { ...TEST_NETWORK, bech32: 'bcrt' } : a.startsWith('tb1') ? TEST_NETWORK : NETWORK;
    const decoded = Address(net).decode(address) as { type: string; pubkey?: Uint8Array };
    return decoded.type === 'tr' && decoded.pubkey?.length === 32 ? decoded.pubkey : null;
  } catch {
    return null;
  }
}

export function xOnlyFromReported(publicKeyHex: string): Uint8Array | null {
  try {
    const b = hex.decode(publicKeyHex);
    if (b.length === 32) return b;
    if (b.length === 33) return b.slice(1);
    return null;
  } catch {
    return null;
  }
}

/**
 * Wallets whose tapscript signing the kit README marks VERIFIED (counters.fun reference code). Every other
 * wallet's reveal path is ASSUMED: the UI says "unverified on this wallet: test on signet first".
 */
export const VERIFIED_TAPSCRIPT: ReadonlySet<WalletId> = new Set(['xcp', 'horizon']);

export function isUnverified(id: WalletId, caps: WalletCapabilities): boolean {
  return !VERIFIED_TAPSCRIPT.has(id) || caps.tapscript === 'unknown' || caps.tweakedLeafKey === 'unknown';
}

export const UNVERIFIED_COPY = 'unverified on this wallet: test on signet first';

/**
 * Leaf-key choice when the kit reports `tweakedLeafKey: 'unknown'` (OKX, Magic Eden, Leather: ASSUMED in the
 * kit README). The untweaked internal key with `disableTweak` is the bitcoinjs-family default and what OKX's
 * UniSat-compatible `disableTweakSigner` selects explicitly.
 */
const UNKNOWN_LEAF_KEY: 'internal' | 'output' = 'internal';

export const WALLET_NAMES: Record<WalletId, string> = {
  unisat: 'UniSat',
  okx: 'OKX Wallet',
  xverse: 'Xverse',
  magiceden: 'Magic Eden',
  leather: 'Leather',
  xcp: 'XCP Wallet',
  horizon: 'Horizon Wallet',
};

export const INSTALL_URLS: Record<WalletId, string> = {
  unisat: 'https://unisat.io/download',
  okx: 'https://www.okx.com/web3',
  xverse: 'https://www.xverse.app/download',
  magiceden: 'https://wallet.magiceden.io/',
  leather: 'https://leather.io/install-extension',
  xcp: 'https://www.xcpwallet.com/',
  horizon: 'https://horizonwallet.io/',
};

/** Which key and options a reveal needs for this wallet session. Throws a user-facing error when it cannot be done. */
export function planRevealSigning(wallet: Pick<WalletSession, 'id' | 'name' | 'ordinals' | 'capabilities' | 'taprootOutputKey' | 'pushTx'>, inputIndex = 0): RevealSigningPlan {
  const caps = wallet.capabilities;
  if (caps.tapscript === false) {
    throw new UserFacingError(`${wallet.name} cannot sign a tapscript (script-path) input, which every reveal is.`, 'Connect UniSat, Xverse, OKX, Leather, Magic Eden, XCP Wallet or Horizon instead. Nothing was funded.');
  }
  if (wallet.ordinals.addressType !== 'p2tr') {
    throw new UserFacingError(`The inscription address ${wallet.ordinals.address} is not a Taproot (bc1p…) address.`, 'Switch the wallet to a Taproot account for ordinals and reconnect.');
  }
  const broadcastVia: RevealSigningPlan['broadcastVia'] = caps.broadcast && wallet.pushTx !== undefined ? 'wallet' : 'esplora';
  const tweaked = caps.tweakedLeafKey === 'unknown' ? UNKNOWN_LEAF_KEY === 'output' : caps.tweakedLeafKey;
  if (tweaked) {
    const key = (wallet.taprootOutputKey && xOnlyFromReported(wallet.taprootOutputKey)) ?? taprootOutputKey(wallet.ordinals.address);
    if (!key) throw new UserFacingError('Could not derive the taproot output key from the inscription address.', 'Reconnect the wallet; if it persists, choose another Taproot account.');
    // XCP Wallet refuses SIGHASH_DEFAULT (0x00): ask it for SIGHASH_ALL (0x01), same digest, 65-byte signature.
    return { leafPubkey: key, leafKeyKind: 'output', sighash: wallet.id === 'xcp' ? 'all' : 'default', inputToSign: { index: inputIndex, address: wallet.ordinals.address }, broadcastVia };
  }
  const key = xOnlyFromReported(wallet.ordinals.publicKey);
  if (!key) throw new UserFacingError(`${wallet.name} did not report a usable public key for the inscription address.`, 'Reconnect the wallet. The reveal needs the account public key to name it in the inscription script.');
  return { leafPubkey: key, leafKeyKind: 'internal', sighash: 'default', inputToSign: { index: inputIndex, address: wallet.ordinals.address, disableTweak: true }, broadcastVia };
}

/** Capability badges shown in the wallet picker. */
export function capabilityBadges(c: WalletCapabilities): Array<{ label: string; ok: boolean | 'unknown' }> {
  return [
    { label: 'can sign tapscript', ok: c.tapscript },
    { label: 'broadcasts', ok: c.broadcast },
    { label: 'BIP-322', ok: c.bip322 },
    { label: c.tweakedLeafKey === 'unknown' ? 'leaf key unknown' : c.tweakedLeafKey ? 'tweaked leaf key' : 'internal leaf key', ok: c.tweakedLeafKey === 'unknown' ? 'unknown' : true },
  ];
}
