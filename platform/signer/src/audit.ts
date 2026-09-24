/**
 * Structured audit records: one per decision the signer makes, allow or deny, success or failure.
 * Records carry everything an operator needs to reconstruct WHAT was signed for WHOM under WHICH policy,
 * and never key material, PSBT bodies or signatures (a digest and a txid are enough to correlate).
 */

export type AuditDecision = 'allow' | 'deny' | 'error';

export interface AuditRecord {
  id: string;
  /** ISO 8601. */
  at: string;
  kind: 'taproot-keypath' | 'schnorr-digest' | 'pubkey';
  keyId: string;
  principal: string;
  decision: AuditDecision;
  /** Policy name + reason for denials; error code + message for errors. */
  reason?: string;
  requestId?: string;
  durationMs: number;
  /** Non-secret facts about the request; the shape depends on `kind`. */
  details: Record<string, unknown>;
}

export interface AuditLog {
  append(record: AuditRecord): void | Promise<void>;
}

export interface AuditQuery {
  keyId?: string;
  decision?: AuditDecision;
  principal?: string;
  limit?: number;
}

/** Bounded ring buffer (newest first on `list`). Enough for the admin endpoint; ship the JSONL sink to your log pipeline too. */
export class InMemoryAuditLog implements AuditLog {
  private readonly records: AuditRecord[] = [];
  constructor(private readonly capacity = 10_000) {}

  append(record: AuditRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
  }

  list(q: AuditQuery = {}): AuditRecord[] {
    const limit = Math.max(1, Math.min(q.limit ?? 100, 1_000));
    const out: AuditRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.records[i]!;
      if (q.keyId && r.keyId !== q.keyId) continue;
      if (q.decision && r.decision !== q.decision) continue;
      if (q.principal && r.principal !== q.principal) continue;
      out.push(r);
    }
    return out;
  }

  get size(): number {
    return this.records.length;
  }
}

/** One JSON object per line to any writer (stdout, a file stream, a log shipper). */
export class JsonLinesAuditLog implements AuditLog {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}
  append(record: AuditRecord): void {
    this.write(JSON.stringify({ msg: 'signer.audit', ...record }));
  }
}

/** Fan out to several sinks; a failing sink never blocks the decision path. */
export class MultiAuditLog implements AuditLog {
  constructor(private readonly sinks: readonly AuditLog[]) {}
  async append(record: AuditRecord): Promise<void> {
    await Promise.all(
      this.sinks.map(async (s) => {
        try {
          await s.append(record);
        } catch {
          /* a broken sink must not break signing; the other sinks still have the record */
        }
      }),
    );
  }
}
