const SATS = 100_000_000n;

export function fmtSats(v: bigint | number): string {
  return `${BigInt(v).toLocaleString('en-US')} sats`;
}

export function fmtBtc(v: bigint | number): string {
  const n = BigInt(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / SATS;
  const frac = (abs % SATS).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac} BTC`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export function fmtRate(rate: number): string {
  return `${rate.toFixed(3).replace(/\.?0+$/, '')} sat/vB`;
}

export function fmtWeight(wu: number): string {
  return `${wu.toLocaleString('en-US')} WU`;
}

export function shortHex(h: string, n = 8): string {
  return h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-n)}`;
}

/** Raw Counterparty units → display units. */
export function fmtQty(raw: bigint, divisible: boolean): string {
  if (!divisible) return raw.toLocaleString('en-US');
  const whole = raw / SATS;
  const frac = (raw % SATS).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}

/** Display units → raw. Returns null for anything that is not a decimal number. */
export function parseUnitsToRaw(text: string, decimals: number): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  if ((m[2] ?? '').length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + (decimals ? BigInt(frac) : 0n);
}

export function parseFeeRate(text: string): number | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const v = Math.round(Number(t) * 1000) / 1000;
  if (!Number.isFinite(v) || v <= 0 || v > 10_000) return null;
  return v;
}
