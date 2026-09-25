import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY, type StepContent } from '@bsh/scribbit-playground-kit';
import { shortHex } from '@bsh/scribbit-mint/src/lib/format';

/** The persistent frame: a banner on every screen plus a coloured edge around the viewport. */
export function TestNetBanner({ demo }: { demo: boolean }) {
  return (
    <div className="testnet-banner" role="note" aria-label="Test network warning">
      <strong>TEST NETWORK</strong>
      <span>signet · coins here have no value · never send real bitcoin to these addresses</span>
      {demo ? <span className="testnet-banner__demo">DEMO: simulated faucet, wallet and chain; the transaction maths and signatures are real</span> : null}
    </div>
  );
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Elapsed time toward the goal. Ticks once a second; nothing animates, so reduced motion needs no special case. */
export function Timer({ startedAt, finishedAt, goalSeconds, now = () => Date.now() }: { startedAt: number | null; finishedAt: number | null; goalSeconds: number; now?: () => number }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (startedAt === null || finishedAt !== null) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt, finishedAt]);
  const elapsed = startedAt === null ? 0 : ((finishedAt ?? now()) - startedAt) / 1000;
  const over = elapsed > goalSeconds;
  const pct = Math.min(100, (elapsed / goalSeconds) * 100);
  return (
    <div className={`timer${over ? ' timer--over' : ''}`} data-testid="timer">
      <span className="timer__label">{startedAt === null ? 'Timer starts with step 1' : finishedAt !== null ? 'Finished in' : 'Elapsed'}</span>
      <span className="timer__clock mono" aria-label={`${formatClock(elapsed)} elapsed of a ${formatClock(goalSeconds)} goal`}>
        {formatClock(elapsed)} <span className="muted">/ {formatClock(goalSeconds)}</span>
      </span>
      <span className="timer__bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export function Stepper({ steps, current, done }: { steps: readonly StepContent[]; current: number; done: number }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.id} aria-current={i === current ? 'step' : undefined} className={i < done ? 'is-done' : undefined}>
          <span className="steps__n">{s.number}</span> <span className="steps__t">{s.title}</span>
        </li>
      ))}
    </ol>
  );
}

/** Plain-language explanation for a step, with its glossary terms (stable anchors `#term-<id>`). */
export function ExplainPanel({ step }: { step: StepContent }) {
  const terms = step.glossary.map((id) => GLOSSARY.find((g) => g.id === id)!).filter(Boolean);
  return (
    <aside className="card card--quiet explain" aria-labelledby={`explain-${step.id}`}>
      <p className="card__kicker" id={`explain-${step.id}`}>
        In plain words
      </p>
      {step.explanation.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {step.safety ? <p className="explain__safety">{step.safety}</p> : null}
      <details>
        <summary>Words used here ({terms.length})</summary>
        <dl className="glossary">
          {terms.map((g) => (
            <div key={g.id} id={`term-${g.id}`}>
              <dt>{g.term}</dt>
              <dd>{g.definition}</dd>
            </div>
          ))}
        </dl>
      </details>
    </aside>
  );
}

/** "What just happened on chain": the step's own facts, or the kit's sentence for steps with nothing on chain. */
export function OnChainCard({ step, items, children }: { step: StepContent; items?: Array<[string, ReactNode]> | null; children?: ReactNode }) {
  return (
    <section className="card onchain" aria-labelledby={`onchain-${step.id}`} data-testid={`onchain-${step.id}`}>
      <p className="card__kicker" id={`onchain-${step.id}`}>
        What just happened on chain
      </p>
      <p className="onchain__lead">{step.onChain}</p>
      {items?.length ? (
        <dl className="kv">
          {items.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </section>
  );
}

export function StepHeading({ step, focus }: { step: StepContent; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <header className="step-head">
      <p className="card__kicker">
        Step {step.number} of 5
      </p>
      <h1 ref={ref} tabIndex={-1} id={`step-${step.id}`}>
        {step.title}
      </h1>
      <p className="lede">{step.summary}</p>
    </header>
  );
}

export function TxLink({ href, txid }: { href: string; txid: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="mono break" title={txid}>
      {shortHex(txid, 10)} ↗
    </a>
  );
}

export function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--ghost btn--small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable: the text is on screen */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Progress({ fraction, label }: { fraction: number; label: string }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
    </div>
  );
}
