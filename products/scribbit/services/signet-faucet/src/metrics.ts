/** Prometheus text exposition (format 0.0.4). No label identifies a person: results only. */
export const DRIP_RESULTS = [
  'ok',
  'bad_request',
  'invalid_address',
  'mainnet_address_refused',
  'wrong_network',
  'challenge_unknown',
  'challenge_expired',
  'challenge_used',
  'pow_invalid',
  'address_rate_limited',
  'ip_rate_limited',
  'budget_exhausted',
  'faucet_disabled',
  'faucet_empty',
  'wallet_unavailable',
  'unsupported_media_type',
] as const;

export class FaucetMetrics {
  challengesIssued = 0;
  satsSent = 0;
  readonly drips = new Map<string, number>(DRIP_RESULTS.map((r) => [r, 0]));

  drip(result: string): void {
    this.drips.set(result, (this.drips.get(result) ?? 0) + 1);
  }

  render(g: { budgetRemainingSats: number; budgetLimitSats: number; walletEnabled: boolean }): string {
    const lines = [
      '# HELP faucet_challenges_issued_total Proof-of-work challenges issued.',
      '# TYPE faucet_challenges_issued_total counter',
      `faucet_challenges_issued_total ${this.challengesIssued}`,
      '# HELP faucet_drips_total Drip attempts by result (ok or the error code).',
      '# TYPE faucet_drips_total counter',
      ...[...this.drips].map(([r, n]) => `faucet_drips_total{result="${r}"} ${n}`),
      '# HELP faucet_sats_sent_total Signet sats sent by successful drips.',
      '# TYPE faucet_sats_sent_total counter',
      `faucet_sats_sent_total ${this.satsSent}`,
      '# HELP faucet_budget_remaining_sats Sats left in today\'s (UTC) budget.',
      '# TYPE faucet_budget_remaining_sats gauge',
      `faucet_budget_remaining_sats ${g.budgetRemainingSats}`,
      '# HELP faucet_budget_limit_sats Daily budget.',
      '# TYPE faucet_budget_limit_sats gauge',
      `faucet_budget_limit_sats ${g.budgetLimitSats}`,
      '# HELP faucet_wallet_enabled 1 when a wallet adapter is configured.',
      '# TYPE faucet_wallet_enabled gauge',
      `faucet_wallet_enabled ${g.walletEnabled ? 1 : 0}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
