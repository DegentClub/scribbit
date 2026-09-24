/**
 * Taproot key helpers: which 32 bytes a wallet's p2tr account actually stands for.
 *
 * Wallets report a `publicKey` for a p2tr account that is (almost always) the BIP86 **internal**
 * key, compressed (33 bytes) or x-only (32). The address's witness program is that key
 * **tweaked** (BIP341, no script tree), and the two differ. An inscription leaf must name the one
 * the wallet will sign with (see `WalletCapabilities.tweakedLeafKey`), so both are exposed.
 */
import { hex } from '@scure/base';
import { utils } from '@scure/btc-signer';
import { segwitProgram } from './address.js';
import type { WalletAccount } from './types.js';

/** x-only (32-byte) form of a hex public key: strips the 02/03 prefix of a compressed key. */
export function xOnlyPubkey(publicKeyHex: string): Uint8Array | undefined {
  const clean = publicKeyHex.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean)) return undefined;
  const bytes = hex.decode(clean);
  if (bytes.length === 32) return bytes;
  if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) return bytes.subarray(1);
  return undefined;
}

/**
 * BIP86 taproot output key (x-only, hex) for an internal public key: `internal + H_TapTweak(internal)·G`,
 * no script tree. Undefined when the key is not a valid compressed/x-only key.
 */
export function deriveTaprootOutputKey(internalPublicKeyHex: string): string | undefined {
  const internal = xOnlyPubkey(internalPublicKeyHex);
  if (!internal) return undefined;
  try {
    return hex.encode(utils.taprootTweakPubkey(internal, new Uint8Array())[0]);
  } catch {
    return undefined;
  }
}

/** The 32-byte witness program of a p2tr address (the tweaked output key), hex, or undefined. */
export function taprootOutputKeyOfAddress(address: string): string | undefined {
  const sw = segwitProgram(address);
  return sw && sw.version === 1 && sw.program.length === 32 ? hex.encode(sw.program) : undefined;
}

/**
 * `ConnectedWallet.taprootOutputKey` for an account: the address's own program when it is p2tr
 * (authoritative: it is what the coins are locked to). When the wallet also reported a public
 * key, the BIP86 tweak of it is expected to match; a mismatch means the wallet reported something
 * other than the internal key (some report the tweaked key itself) and the address still wins.
 */
export function taprootOutputKeyOf(account: WalletAccount): string | undefined {
  return taprootOutputKeyOfAddress(account.address);
}
