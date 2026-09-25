/**
 * Nonce store port. A SIWB nonce is issued by the server with the challenge and may be consumed
 * exactly once before it expires. Adapters must make `consume` atomic (Redis: a Lua script or
 * `SET used NX` + TTL; Postgres: `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING`).
 */
export type NonceConsumeResult = 'ok' | 'unknown' | 'expired' | 'replayed';

export interface NonceRecord {
  nonce: string;
  /** Epoch ms after which the nonce can no longer be consumed. */
  expiresAt: number;
  /** Binding data checked at consume time (the challenge's domain and address). */
  domain: string;
  address: string;
}

export interface NonceStore {
  /** Record a freshly issued nonce. Must reject (throw) a nonce that already exists. */
  issue(record: NonceRecord): Promise<void>;
  /**
   * Atomically mark the nonce used. Returns 'ok' only the first time, for an issued, unexpired
   * nonce whose binding matches.
   */
  consume(nonce: string, binding: { domain: string; address: string }, now: number): Promise<NonceConsumeResult>;
}

interface Entry extends NonceRecord {
  used: boolean;
}

/**
 * In-memory adapter (single process: tests, dev, regtest). Used nonces are remembered until they
 * expire (after which they would be rejected as expired anyway) plus `retainMs`, so replays are
 * reported as 'replayed' rather than 'unknown'.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly opts: { maxEntries?: number; retainMs?: number } = {}) {}

  get size(): number {
    return this.entries.size;
  }

  async issue(record: NonceRecord): Promise<void> {
    // Do NOT sweep on the wall clock here: consume() is driven by an injected `now`, so a
    // wall-clock sweep in issue() would drop entries a caller with a test/fixed clock still
    // treats as live (identity finding 041). Memory is bounded by maxEntries below and by the
    // clock-consistent sweep in consume().
    if (this.entries.has(record.nonce)) throw new Error('nonce already issued');
    const max = this.opts.maxEntries ?? 100_000;
    if (this.entries.size >= max) throw new Error('nonce store full');
    this.entries.set(record.nonce, { ...record, used: false });
  }

  async consume(nonce: string, binding: { domain: string; address: string }, now: number): Promise<NonceConsumeResult> {
    const e = this.entries.get(nonce);
    if (!e) return 'unknown';
    if (e.used) return 'replayed';
    if (e.domain !== binding.domain || e.address !== binding.address) return 'unknown';
    if (now >= e.expiresAt) return 'expired';
    e.used = true; // single-threaded JS: check-and-set is atomic
    return 'ok';
  }

  /** Drop entries that can no longer be consumed. */
  sweep(now: number): void {
    const retain = this.opts.retainMs ?? 60_000;
    for (const [k, e] of this.entries) if (now >= e.expiresAt + retain) this.entries.delete(k);
  }
}
