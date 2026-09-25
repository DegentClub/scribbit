import { useState } from 'react';
import { PLAYGROUND_VERSION, QUIZ, scoreQuiz, stepContent, type QuizResult } from '@bsh/scribbit-playground-kit';
import { Alert } from '@bsh/scribbit-mint/src/components/ui';
import { fmtBytes, fmtWeight } from '@bsh/scribbit-mint/src/lib/format';
import type { PlaygroundConfig } from '../config';
import { inscriptionUrl, txUrl, xrayUrl } from '../config';
import type { PlaygroundWallet, Services } from '../services/types';
import type { CommitResult, Plan, RevealResult } from '../lib/flow';
import { ExplainPanel, formatClock, OnChainCard, StepHeading, TxLink } from '../components/parts';

const STEP = stepContent('certificate');

export function CertificateStep({ services, config, wallet, plan, committed, revealed, elapsedSeconds, onRestart }: { services: Services; config: PlaygroundConfig; wallet: PlaygroundWallet; plan: Plan; committed: CommitResult; revealed: RevealResult; elapsedSeconds: number; onRestart: () => void }) {
  const within = elapsedSeconds <= config.goalSeconds;
  return (
    <div className="step-grid">
      <div className="stack">
        <StepHeading step={STEP} focus />
        <section className="card certificate" aria-labelledby="cert-h" data-testid="certificate">
          <div className="spread">
            <h2 id="cert-h">Certificate of a first inscription</h2>
            <span className="stamp">signet</span>
          </div>
          <p>
            {wallet.kind === 'throwaway' ? 'Your throwaway key' : wallet.name} wrote <strong>{plan.file.name}</strong> ({fmtBytes(plan.file.bytes.length)}, {plan.file.contentType}) into the Bitcoin signet chain in{' '}
            <strong data-testid="elapsed">{formatClock(elapsedSeconds)}</strong>
            {within ? ', inside the five-minute goal.' : '. The goal is five minutes; the next one will be faster.'}
          </p>
          <dl className="kv">
            <dt>Inscription id</dt>
            <dd data-testid="inscription-id">{revealed.inscriptionId}</dd>
            <dt>Reveal</dt>
            <dd>
              <TxLink href={txUrl(config, revealed.txid)} txid={revealed.txid} /> · {fmtWeight(revealed.weight)}
            </dd>
            <dt>Commit</dt>
            <dd>
              <TxLink href={txUrl(config, committed.txid)} txid={committed.txid} />
            </dd>
            <dt>Owner address</dt>
            <dd>{wallet.ordinals.address}</dd>
          </dl>
          <div className="row">
            <a className="btn btn--ghost btn--small" href={inscriptionUrl(config, revealed.inscriptionId)} target="_blank" rel="noreferrer noopener">
              View on the signet ord explorer ↗
            </a>
            <a className="btn btn--ghost btn--small" href={txUrl(config, revealed.txid)} target="_blank" rel="noreferrer noopener">
              Reveal on the signet explorer ↗
            </a>
            <a className="btn btn--ghost btn--small" href={xrayUrl(config, revealed.txid)} target="_blank" rel="noreferrer noopener">
              X-Ray the reveal ↗
            </a>
          </div>
          <p className="hint">Explorers list the reveal once they see it; ord servers index inscriptions from blocks, so the inscription page appears after the next signet block (about ten minutes on average).</p>
        </section>
        <Quiz services={services} />
        <OnChainCard
          step={STEP}
          items={[
            ['Reveal size', `${fmtWeight(revealed.weight)} (${revealed.vsize.toLocaleString('en-US')} vB)`],
            ['File bytes', `${plan.file.bytes.length.toLocaleString('en-US')} bytes in the witness`],
          ]}
        />
        <div>
          <button type="button" className="btn btn--ghost" onClick={onRestart}>
            Start over
          </button>
        </div>
      </div>
      <ExplainPanel step={STEP} />
    </div>
  );
}

export function Quiz({ services }: { services: Services }) {
  const [answers, setAnswers] = useState<Array<number | null>>(QUIZ.map(() => null));
  const [result, setResult] = useState<QuizResult | null>(null);
  const [sent, setSent] = useState(false);
  const check = async () => {
    const r = scoreQuiz(answers);
    setResult(r);
    if (services.analytics.enabled && !sent) {
      setSent(true);
      await services.analytics.send({ event: 'playground.quiz', version: PLAYGROUND_VERSION, passed: r.passed, score: r.score, total: r.total });
    }
  };
  return (
    <section className="card card--quiet" aria-labelledby="quiz-h">
      <h2 id="quiz-h">Explain-check: three quick questions</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        {QUIZ.map((q, qi) => (
          <fieldset key={q.id} className="quiz-q">
            <legend>
              {qi + 1}. {q.prompt}
            </legend>
            {q.options.map((o, oi) => (
              <label key={oi} className="opt">
                <input type="radio" name={`q-${q.id}`} checked={answers[qi] === oi} onChange={() => setAnswers((a) => a.map((x, i) => (i === qi ? oi : x)))} />
                <span>{o}</span>
              </label>
            ))}
            {result ? <p className={`small ${result.correct[qi] ? 'good-text' : 'bad-text'}`}>{result.correct[qi] ? '✓ Right. ' : '✗ Not quite. '}{q.why}</p> : null}
          </fieldset>
        ))}
        <div className="row">
          <button type="submit" className="btn" disabled={answers.some((a) => a === null)}>
            Check my answers
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {result ? (
          <Alert tone={result.passed ? 'good' : 'warn'} title={result.passed ? `${result.score} of ${result.total}: you can explain what you did.` : `${result.score} of ${result.total}: read the "In plain words" panels and try again.`} />
        ) : null}
      </div>
      <p className="hint" data-testid="analytics-note">
        {services.analytics.enabled
          ? services.mode === 'demo'
            ? 'Demo mode: the pass/fail result is recorded in this page only, never sent.'
            : 'Only pass/fail and the score are sent, anonymously: no address, no transaction id, no identifier.'
          : 'Nothing about your answers is sent anywhere.'}
      </p>
    </section>
  );
}
