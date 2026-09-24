import { describe, expect, it } from 'vitest';
import { ChallengeStore, DailyBudget, DripLimiter } from '../src/index.js';

describe('ChallengeStore', () => {
  it('issues unique hex nonces; consume is single-use; expiry is exact; memory is bounded', () => {
    const s = new ChallengeStore({ difficulty: 10, ttlMs: 1000, maxOutstanding: 3 });
    const a = s.issue(0);
    const b = s.issue(0);
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(s.consume(a.nonce, 999)).toMatchObject({ ok: true });
    expect(s.consume(a.nonce, 999)).toEqual({ ok: false, code: 'challenge_used' });
    expect(s.consume(b.nonce, 1000)).toEqual({ ok: false, code: 'challenge_expired' });
    expect(s.consume('00'.repeat(16), 0)).toEqual({ ok: false, code: 'challenge_unknown' });
    for (let i = 0; i < 10; i++) s.issue(1);
    expect(s.size).toBeLessThanOrEqual(3);
    s.issue(5000);
    expect(s.size).toBeLessThanOrEqual(3);
  });
});

describe('DripLimiter', () => {
  it('capacity then refill over the window; retryAfter does not take; refund restores', () => {
    const l = new DripLimiter(2, 1000);
    expect(l.retryAfterMs('k', 0)).toBe(0);
    expect(l.take('k', 0)).toBe(true);
    expect(l.take('k', 0)).toBe(true);
    expect(l.take('k', 0)).toBe(false);
    expect(l.retryAfterMs('k', 0)).toBe(500);
    expect(l.retryAfterMs('k', 0)).toBe(500);
    expect(l.take('k', 500)).toBe(true);
    l.refund('k', 500);
    expect(l.take('k', 500)).toBe(true);
    expect(l.take('other', 0)).toBe(true);
    expect(() => new DripLimiter(0, 1000)).toThrow();
  });
});

describe('DailyBudget', () => {
  it('reserves within a UTC day, releases, and resets at midnight UTC', () => {
    const day = Date.UTC(2026, 8, 24);
    const b = new DailyBudget(100);
    expect(b.reserve(60, day + 1)).toBe(true);
    expect(b.reserve(60, day + 2)).toBe(false);
    expect(b.remaining(day + 3)).toBe(40);
    b.release(60, day + 4);
    expect(b.remaining(day + 5)).toBe(100);
    expect(b.reserve(100, day + 6)).toBe(true);
    expect(b.resetsAt(day + 6)).toBe(day + 86_400_000);
    expect(b.remaining(day + 86_400_000)).toBe(100);
  });
});
