import { base64, bech32, bech32m, hex } from '@scure/base';
import { afterEach } from 'vitest';

/** A checksum-valid segwit address with a deterministic program. */
export function segwitAddr(hrp: 'bc' | 'tb' | 'bcrt', version: 0 | 1, programLen: number, fill = 7): string {
  const program = new Uint8Array(programLen).fill(fill);
  const coder = version === 0 ? bech32 : bech32m;
  return coder.encode(hrp, [version, ...bech32.toWords(program)]);
}

export const ADDR = {
  main: {
    p2tr: segwitAddr('bc', 1, 32, 1),
    p2wpkh: segwitAddr('bc', 0, 20, 2),
    p2sh: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    p2pkh: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
  },
  test: {
    p2tr: segwitAddr('tb', 1, 32, 3),
    p2wpkh: segwitAddr('tb', 0, 20, 4),
    p2sh: '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc',
    p2pkh: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
  },
  regtest: {
    p2tr: segwitAddr('bcrt', 1, 32, 5),
    p2wpkh: segwitAddr('bcrt', 0, 20, 6),
  },
} as const;

export const PUBKEY_A = '02' + '11'.repeat(32);
export const PUBKEY_B = '03' + '22'.repeat(32);

/** Unsigned / signed PSBT fixtures (valid magic; body is opaque to the kit). */
export const UNSIGNED_HEX = '70736274ff01000a02000000000000000000';
export const SIGNED_HEX = '70736274ff01000a02000000000000000000aabbcc';
export const UNSIGNED_B64 = base64.encode(hex.decode(UNSIGNED_HEX));
export const SIGNED_B64 = base64.encode(hex.decode(SIGNED_HEX));

export interface Call {
  method: string;
  args: unknown[];
}

/** Records every call made on a fake provider. */
export class Recorder {
  calls: Call[] = [];
  record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  last(method: string): Call | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }
}

type Win = Record<string, unknown>;
export const win = (): Win => window as unknown as Win;

const INJECTED = ['unisat', 'okxwallet', 'XverseProviders', 'LeatherProvider', 'magicEden', 'xcpwallet', 'HorizonWalletProvider', 'btc_providers'];
export function cleanWindow(): void {
  for (const k of INJECTED) delete win()[k];
}
afterEach(cleanWindow);

/** A provider error shaped like EIP-1193 (UniSat/OKX). */
export function eip1193Rejection(): Error & { code: number } {
  return Object.assign(new Error('User rejected the request.'), { code: 4001 });
}
