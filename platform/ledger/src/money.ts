/** Integer money helpers. Sats never leave integer arithmetic; BTC strings are only for provider APIs. */

export const SATS_PER_BTC = 100_000_000;
export const MAX_SATS = 2_100_000_000_000_000; // 21e6 BTC

export function assertSats(v: unknown, what = 'amount'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_SATS) throw new RangeError(`${what} must be an integer number of satoshis in [0, ${MAX_SATS}]`);
  return v;
}

/** `12345` → `"0.00012345"` (8 decimals, no exponent). */
export function satsToBtc(sats: number): string {
  assertSats(sats);
  const whole = Math.floor(sats / SATS_PER_BTC);
  const frac = sats % SATS_PER_BTC;
  return `${whole}.${String(frac).padStart(8, '0')}`;
}

/** `"0.00012345"` → `12345`. Rejects more than 8 decimals and non-numeric input (no float parsing). */
export function btcToSats(btc: string | number): number {
  const s = typeof btc === 'number' ? btc.toFixed(8) : btc.trim();
  const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m) throw new RangeError(`not a BTC amount: ${btc}`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(8, '0'));
  return assertSats(whole * SATS_PER_BTC + frac);
}

/**
 * Convert sats to fiat minor units (cents) at `minorPerBtc` (e.g. 6_500_000 = $65,000.00/BTC). Rounds half up.
 * Rates are integers to keep this exact; quote providers must round before handing us a rate.
 */
export function satsToFiatMinor(sats: number, minorPerBtc: number): number {
  assertSats(sats);
  if (!Number.isInteger(minorPerBtc) || minorPerBtc <= 0) throw new RangeError('rate must be a positive integer of minor units per BTC');
  const n = BigInt(sats) * BigInt(minorPerBtc);
  const d = BigInt(SATS_PER_BTC);
  return Number((n + d / 2n) / d);
}
