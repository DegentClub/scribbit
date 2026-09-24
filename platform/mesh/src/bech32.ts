// A small bech32 / bech32m (BIP 173 / BIP 350) codec, enough to check that a
// `btc:` invoice destination is a well-formed segwit address for its network.
// Scribbit extension: nothing in the FlashyOS material validates btc addresses.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;
export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;
export const BECH32_MAX_LENGTH = 90;

export type Bech32Encoding = 'bech32' | 'bech32m';

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ GENERATOR[i]!) >>> 0;
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string): number[] => [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function createChecksum(hrp: string, data: readonly number[], encoding: Bech32Encoding): number[] {
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ (encoding === 'bech32' ? BECH32_CONST : BECH32M_CONST);
  return [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
}

export interface Bech32Decoded {
  hrp: string;
  /** 5-bit groups, checksum removed. */
  data: number[];
  encoding: Bech32Encoding;
}

/** Decodes and checks the checksum; null for anything malformed (length, case, charset, separator, checksum). */
export function decodeBech32(text: string): Bech32Decoded | null {
  if (typeof text !== 'string' || text.length > BECH32_MAX_LENGTH) return null;
  const lower = text.toLowerCase();
  if (text !== lower && text !== text.toUpperCase()) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 33 || code > 126) return null;
  }
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) return null;
    data.push(v);
  }
  const pm = polymod([...hrpExpand(hrp), ...data]);
  const encoding: Bech32Encoding | null = pm === BECH32_CONST ? 'bech32' : pm === BECH32M_CONST ? 'bech32m' : null;
  if (!encoding) return null;
  return { hrp, data: data.slice(0, -6), encoding };
}

export function encodeBech32(hrp: string, data: readonly number[], encoding: Bech32Encoding): string {
  const combined = [...data, ...createChecksum(hrp, data, encoding)];
  return `${hrp}1${combined.map((d) => CHARSET[d]!).join('')}`;
}

/** Regroups bits (8→5 with padding for encoding, 5→8 without for decoding); null when the input does not regroup cleanly. */
export function convertBits(data: Iterable<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

export interface SegwitAddress {
  hrp: string;
  version: number;
  program: Uint8Array;
  encoding: Bech32Encoding;
}

/** BIP 173/350 segwit address rules for the expected hrp (`bc`, `tb`, `bcrt`); null when it is not one. */
export function decodeSegwitAddress(expectedHrp: string, address: string): SegwitAddress | null {
  const dec = decodeBech32(address);
  if (!dec || dec.hrp !== expectedHrp || dec.data.length < 1) return null;
  const version = dec.data[0]!;
  if (version > 16) return null;
  const program = convertBits(dec.data.slice(1), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  if (version === 0 && dec.encoding !== 'bech32') return null;
  if (version !== 0 && dec.encoding !== 'bech32m') return null;
  return { hrp: dec.hrp, version, program: Uint8Array.from(program), encoding: dec.encoding };
}

export function encodeSegwitAddress(hrp: string, version: number, program: Uint8Array): string {
  if (version < 0 || version > 16) throw new RangeError('witness version is 0..16');
  const grouped = convertBits(program, 8, 5, true);
  if (!grouped) throw new TypeError('program does not regroup');
  const encoded = encodeBech32(hrp, [version, ...grouped], version === 0 ? 'bech32' : 'bech32m');
  if (!decodeSegwitAddress(hrp, encoded)) throw new TypeError('program length is not valid for this witness version');
  return encoded;
}
