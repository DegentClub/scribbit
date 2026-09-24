/**
 * The faucet's abuse limits, all in memory (one process; a restart forgets them, which is acceptable for test
 * coins and is written down in the RUNBOOK):
 *
 *   ChallengeStore  single-use, expiring proof-of-work nonces
 *   DripLimiter     token buckets per address and per IP (check both, then take both: no half-spent state)
 *   DailyBudget     a global sats budget per UTC day, reserved before sending and released if the send fails
 */
import { randomBytes } from 'node:crypto';

// ------------------------------------------------------------------------------------------------ challenges

export interface Challenge {
  nonce: string;
  difficulty: number;
  issuedAt: number;
  expiresAt: number;
}

export type ConsumeResult = { ok: true; challenge: Challenge } | { ok: false; code: 'challenge_unknown' | 'challenge_expired' | 'challenge_used' };

interface Entry extends Challenge {
  used: boolean;
}

export class ChallengeStore {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly opts: { difficulty: number; ttlMs: number; maxOutstanding?: number; random?: (n: number) => Uint8Array },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  issue(now: number): Challenge {
    this.sweep(now);
    const max = this.opts.maxOutstanding ?? 50_000;
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const bytes = (this.opts.random ?? ((n) => new Uint8Array(randomBytes(n))))(16);
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const c: Entry = { nonce, difficulty: this.opts.difficulty, issuedAt: now, expiresAt: now + this.opts.ttlMs, used: false };
    this.entries.set(nonce, c);
    return { nonce: c.nonce, difficulty: c.difficulty, issuedAt: c.issuedAt, expiresAt: c.expiresAt };
  }

  /**
   * Spend a nonce. The FIRST attempt that names it consumes it, whether or not its proof of work turns out to be
   * valid: a nonce can never be tried twice. Used nonces are remembered until they expire, so a replay gets
   * `challenge_used` rather than `challenge_unknown`.
   */
  consume(nonce: string, now: number): ConsumeResult {
    const e = this.entries.get(nonce);
    if (!e) return { ok: false, code: 'challenge_unknown' };
    if (now >= e.expiresAt) {
      this.entries.delete(nonce);
      return { ok: false, code: 'challenge_expired' };
    }
    if (e.used) return { ok: false, code: 'challenge_used' };
    e.used = true;
    return { ok: true, challenge: { nonce: e.nonce, difficulty: e.difficulty, issuedAt: e.issuedAt, expiresAt: e.expiresAt } };
  }

  private sweep(now: number): void {
    // Expired entries are only kept to answer "expired" precisely; after a grace period they are dropped.
    const grace = this.opts.ttlMs;
    for (const [k, e] of this.entries) if (now >= e.expiresAt + grace) this.entries.delete(k);
  }
}

// ------------------------------------------------------------------------------------------------ drip buckets

interface Bucket {
  tokens: number;
  ts: number;
}

/** Token bucket per key: `capacity` drips, refilled evenly over `windowMs`. */
export class DripLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    private readonly maxKeys = 200_000,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.refillPerMs = capacity / windowMs;
  }

  private current(key: string, now: number): Bucket {
    const b = this.buckets.get(key);
    if (!b) return { tokens: this.capacity, ts: now };
    return { tokens: Math.min(this.capacity, b.tokens + Math.max(0, now - b.ts) * this.refillPerMs), ts: now };
  }

  /** ms until one drip is available for `key` (0 = now). Does not take. */
  retryAfterMs(key: string, now: number): number {
    const b = this.current(key, now);
    return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / this.refillPerMs);
  }

  take(key: string, now: number): boolean {
    const b = this.current(key, now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    this.buckets.set(key, b);
    return true;
  }

  /** Give back a drip taken for a send that failed. */
  refund(key: string, now: number): void {
    const b = this.current(key, now);
    b.tokens = Math.min(this.capacity, b.tokens + 1);
    this.buckets.set(key, b);
  }
}

// ------------------------------------------------------------------------------------------------ daily budget

const DAY_MS = 86_400_000;
const utcDay = (now: number) => Math.floor(now / DAY_MS);

export class DailyBudget {
  private day = -1;
  private spent = 0;
  constructor(readonly limitSats: number) {
    if (!Number.isSafeInteger(limitSats) || limitSats < 1) throw new Error('limitSats must be a positive integer');
  }

  private roll(now: number): void {
    const d = utcDay(now);
    if (d !== this.day) {
      this.day = d;
      this.spent = 0;
    }
  }

  remaining(now: number): number {
    this.roll(now);
    return Math.max(0, this.limitSats - this.spent);
  }

  /** Start of the next UTC day, as epoch ms. */
  resetsAt(now: number): number {
    return (utcDay(now) + 1) * DAY_MS;
  }

  reserve(sats: number, now: number): boolean {
    this.roll(now);
    if (this.spent + sats > this.limitSats) return false;
    this.spent += sats;
    return true;
  }

  release(sats: number, now: number): void {
    this.roll(now);
    this.spent = Math.max(0, this.spent - sats);
  }
}
