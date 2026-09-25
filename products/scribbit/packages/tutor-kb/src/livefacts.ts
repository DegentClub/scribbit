/**
 * Live chain facts (current fee estimate, tip height) come through a port so tests use a fake and the tutor
 * works with it disabled. Every fact carries a timestamp and a source label; the tutor never presents a live
 * number without them. Off by default at the service (`LIVE_FACTS=off`).
 */
export interface LiveFact {
  label: string;
  value: string;
  /** ISO-8601 time the fact was observed. */
  observedAt: string;
  /** Human-readable source of the fact (e.g. "mempool.space (signet)"). Never an internal hostname. */
  source: string;
}

export interface LiveFactsPort {
  /** Return whatever live facts are available for the network, or an empty array. Must not throw for the caller. */
  facts(network: string): Promise<LiveFact[]>;
}

/** A deterministic fake for tests and offline demos: fixed numbers, clearly labelled as illustrative. */
export class FakeLiveFacts implements LiveFactsPort {
  constructor(
    private readonly data: LiveFact[] = [
      { label: 'Recommended fee rate', value: '4 sat/vB', observedAt: '2026-09-25T00:00:00.000Z', source: 'fixture (illustrative)' },
      { label: 'Chain tip height', value: '870000', observedAt: '2026-09-25T00:00:00.000Z', source: 'fixture (illustrative)' },
    ],
  ) {}
  facts(_network: string): Promise<LiveFact[]> {
    return Promise.resolve(this.data);
  }
}

/** A port that returns nothing — the explicit "disabled" state. */
export class NoLiveFacts implements LiveFactsPort {
  facts(): Promise<LiveFact[]> {
    return Promise.resolve([]);
  }
}
