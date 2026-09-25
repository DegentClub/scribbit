import { useState } from 'react';
import { stepContent } from '@bsh/scribbit-playground-kit';
import { Alert } from '@bsh/scribbit-mint/src/components/ui';
import { describeError } from '@bsh/scribbit-mint/src/lib/errors';
import { fmtSats, fmtWeight, shortHex } from '@bsh/scribbit-mint/src/lib/format';
import type { PlaygroundConfig } from '../config';
import { txUrl } from '../config';
import { BroadcastRejectedError, type PlaygroundWallet, type Services } from '../services/types';
import { commit, reveal, type CommitResult, type Plan, type RevealResult } from '../lib/flow';
import { ExplainPanel, OnChainCard, StepHeading, TxLink } from '../components/parts';

const STEP = stepContent('inscribe');

export function explainFailure(e: unknown): { title: string; body: string; hint: string } {
  if (e instanceof BroadcastRejectedError) {
    return {
      title: 'The signet node refused the transaction',
      body: e.reason,
      hint: /missingorspent|missing inputs/i.test(e.reason)
        ? 'A coin it spends is gone (already spent?). Go back to step 3 to rebuild the quote from your current coins.'
        : /fee/i.test(e.reason)
          ? 'The fee rate was too low for this node. Rebuild the quote in step 3.'
          : 'Nothing was lost: a refused transaction changes nothing on chain. Try again, or rebuild the quote in step 3.',
    };
  }
  const d = describeError(e);
  return { title: /cancel/i.test(d.message) ? 'Your wallet did not sign' : 'That did not work', body: d.message, hint: d.hint };
}

export function InscribeStep({ services, config, wallet, plan, onDone, onBack }: { services: Services; config: PlaygroundConfig; wallet: PlaygroundWallet; plan: Plan; onDone: (c: CommitResult, r: RevealResult) => void; onBack: () => void }) {
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState<'commit' | 'reveal' | null>(null);
  const [failure, setFailure] = useState<{ title: string; body: string; hint: string } | null>(null);
  const signer = wallet.kind === 'throwaway' ? 'your test key (in this page)' : wallet.name;
  const change = plan.funding.selection.outputs.find((o) => o.label === 'change');

  const doCommit = async () => {
    setBusy('commit');
    setFailure(null);
    try {
      setCommitted(await commit(services, wallet, plan));
    } catch (e) {
      setFailure(explainFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const doReveal = async () => {
    if (!committed) return;
    setBusy('reveal');
    setFailure(null);
    try {
      onDone(committed, await reveal(services, wallet, plan));
    } catch (e) {
      setFailure(explainFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="step-grid">
      <div className="stack">
        <StepHeading step={STEP} focus />
        <section className="card" aria-labelledby="commit-h">
          <h2 id="commit-h">1 · The commit</h2>
          <p className="small">
            Spends {plan.funding.selection.inputs.length} coin{plan.funding.selection.inputs.length === 1 ? '' : 's'} and sends <strong>{fmtSats(plan.quote.commitValue)}</strong> to the envelope address{' '}
            <span className="mono break">{shortHex(plan.commitAddress, 10)}</span>
            {change ? `, with ${fmtSats(change.value)} change back to you` : ''}. Fee {fmtSats(plan.funding.selection.fee)}.
          </p>
          {committed ? (
            <p className="small good-text">✓ Commit broadcast: <TxLink href={txUrl(config, committed.txid)} txid={committed.txid} /></p>
          ) : (
            <div>
              <button type="button" className="btn" disabled={busy !== null} onClick={doCommit}>
                {busy === 'commit' ? 'Signing…' : `Sign the commit with ${signer}`}
              </button>
            </div>
          )}
        </section>
        <section className={`card${committed ? '' : ' card--quiet'}`} aria-labelledby="reveal-h">
          <h2 id="reveal-h">2 · The reveal</h2>
          <p className="small">
            Spends the commit output by showing the envelope script (with your file) and a signature. {fmtWeight(plan.quote.weight)}, {plan.quote.vsize.toLocaleString('en-US')} vB, fee {fmtSats(plan.quote.revealFee)}; {fmtSats(546)} postage goes to your address with the inscription.
          </p>
          <div>
            <button type="button" className="btn" disabled={!committed || busy !== null} onClick={doReveal}>
              {busy === 'reveal' ? 'Signing…' : `Sign the reveal with ${signer}`}
            </button>
          </div>
        </section>
        {failure ? (
          <Alert tone="bad" title={failure.title}>
            <p className="break">{failure.body}</p>
            <p>
              <strong>What to do:</strong> {failure.hint}
            </p>
            {!committed ? (
              <button type="button" className="btn btn--ghost btn--small" onClick={onBack}>
                Back to step 3
              </button>
            ) : null}
          </Alert>
        ) : null}
        <OnChainCard
          step={STEP}
          items={
            committed
              ? [
                  ['Commit', <TxLink key="c" href={txUrl(config, committed.txid)} txid={committed.txid} />],
                  ['Commit size', `${committed.vsize} vB, fee ${fmtSats(committed.fee)}`],
                  ['Reveal', 'not yet: sign it above'],
                ]
              : [['Nothing broadcast yet', 'the PSBTs are built and waiting for your signature']]
          }
        />
      </div>
      <ExplainPanel step={STEP} />
    </div>
  );
}
