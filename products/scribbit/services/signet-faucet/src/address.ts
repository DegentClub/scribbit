/**
 * Which addresses the faucet pays. Signet only: `tb1` bech32 (v0) / bech32m (v1+) with a valid checksum.
 *
 * A `tb1` address is the same on testnet and signet (shared HRP), so the network cannot be told apart from the
 * address; what the faucet CAN do is refuse everything that is certainly not signet, loudly: mainnet (`bc1`,
 * base58 `1…`/`3…`) with its own code so clients can explain it, regtest (`bcrt1`) as `wrong_network`.
 */
import { Address, NETWORK, TEST_NETWORK } from '@scure/btc-signer';

export type AddressVerdict =
  | { ok: true; address: string; type: string }
  | { ok: false; code: 'invalid_address' | 'mainnet_address_refused' | 'wrong_network'; message: string };

const REGTEST = { ...TEST_NETWORK, bech32: 'bcrt' };

function decodes(net: typeof NETWORK, a: string): { type: string } | null {
  try {
    return Address(net).decode(a) as { type: string };
  } catch {
    return null;
  }
}

export function checkSignetAddress(input: unknown): AddressVerdict {
  if (typeof input !== 'string') return { ok: false, code: 'invalid_address', message: 'address must be a string' };
  const raw = input.trim();
  if (raw.length < 14 || raw.length > 90) return { ok: false, code: 'invalid_address', message: 'address has an impossible length' };
  const lower = raw.toLowerCase();
  const bech32ish = /^(bc|tb|bcrt)1/.test(lower);
  // Bech32 is case-insensitive but must not be mixed-case (base58 is case-sensitive by design).
  if (bech32ish && raw !== lower && raw !== raw.toUpperCase()) return { ok: false, code: 'invalid_address', message: 'mixed-case bech32 address' };
  if (lower.startsWith('bc1') || (/^[13]/.test(raw) && decodes(NETWORK, raw))) {
    return { ok: false, code: 'mainnet_address_refused', message: 'This is a MAINNET address. The faucet only pays signet (tb1…) addresses; never mix real bitcoin with test coins.' };
  }
  if (lower.startsWith('bcrt1')) return { ok: false, code: 'wrong_network', message: 'This is a regtest address; the faucet pays signet (tb1…) addresses.' };
  if (!lower.startsWith('tb1')) {
    if (/^[mn2]/.test(raw) && decodes(TEST_NETWORK, raw)) return { ok: false, code: 'invalid_address', message: 'Legacy base58 test addresses are not supported; use a tb1… (SegWit or Taproot) address.' };
    return { ok: false, code: 'invalid_address', message: 'Not a signet address (expected tb1…).' };
  }
  const decoded = decodes(TEST_NETWORK, lower);
  if (!decoded) return { ok: false, code: 'invalid_address', message: 'Malformed tb1 address (bad checksum or program).' };
  if (!['wpkh', 'wsh', 'tr'].includes(decoded.type)) return { ok: false, code: 'invalid_address', message: `Unsupported address type ${decoded.type}.` };
  return { ok: true, address: lower, type: decoded.type };
}

/** Exported for tests: the regtest decoder, to show a bcrt1 address is well-formed yet refused. */
export const decodesOnRegtest = (a: string) => decodes(REGTEST, a) !== null;
