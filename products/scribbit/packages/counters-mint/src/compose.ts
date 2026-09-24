/**
 * What Counterparty Core v11 returns from `compose/*` with
 * `encoding=taproot&verbose=true`, as this engine consumes it
 * (`lib/api/composer.py`, `construct` / `compose_transaction`).
 *
 * Fields this library relies on:
 *
 * - `rawtransaction` — the unsigned COMMIT. Its outputs: the commit output at
 *   index 0 (found by identity, not position: see `coreCommitScript`) and
 *   Core's change. `buildCommitPsbt` reads the commit VALUE from it (and, when
 *   no UTXOs are given, reuses its inputs and change); `buildPlainPsbt` turns
 *   it into a PSBT unchanged.
 * - `envelope_script` — the tapscript leaf Core built around its ephemeral key.
 *   Re-keyed by `reKeyEnvelope`; its style is read by `detectOrdEnvelope`.
 * - `signed_reveal_rawtransaction` — Core's own reveal, signed with the
 *   discarded key. Its WITNESS is useless; its OUTPUTS (OP_RETURN `CNTRPRTY`,
 *   plus a 546-sat output for the ord wrapper) are consensus-relevant and are
 *   copied verbatim by `buildRevealPsbt`; its weight gives `revealWeightOf`.
 * - `lock_scripts` / `inputs_values` — prevouts of the commit's inputs, so the
 *   commit can be signed without a lookup (only with `verbose=true`).
 * - `btc_fee` / `btc_change` / `btc_in` / `btc_out` — Core's arithmetic for the
 *   commit; `btc_fee` is reported as the commit fee in a `MintPlan`.
 * - `signed_tx_estimated_size.adjusted_vsize` — what Core's fee was computed
 *   over (reported, never recomputed).
 * - `psbt` / `data` / `params` / `name` / `warnings` — verbose extras; `data`
 *   is `CNTRPRTY` + the message, useful for display only.
 */
export interface ComposeResult {
  rawtransaction?: string;
  psbt?: string;
  envelope_script?: string;
  signed_reveal_rawtransaction?: string;
  btc_fee?: number;
  btc_change?: number;
  btc_in?: number;
  btc_out?: number;
  inputs_values?: number[];
  lock_scripts?: string[];
  signed_tx_estimated_size?: { vsize: number; adjusted_vsize: number; sigops_count: number };
  data?: string;
  params?: Record<string, unknown>;
  name?: string;
  warnings?: string[];
  [k: string]: unknown;
}

/** The parts of a compose a commit/reveal pair needs, or a clear error. */
export function requireTaprootCompose(
  compose: ComposeResult,
): ComposeResult & { rawtransaction: string; envelope_script: string; signed_reveal_rawtransaction: string } {
  if (!compose.rawtransaction) throw new Error('Core returned no rawtransaction.');
  if (!compose.envelope_script || !compose.signed_reveal_rawtransaction) {
    throw new Error('Core returned no commit/reveal pair. The node must be v11+ with taproot envelopes enabled.');
  }
  return compose as ComposeResult & { rawtransaction: string; envelope_script: string; signed_reveal_rawtransaction: string };
}
