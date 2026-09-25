import { useEffect, useState } from 'react';
import { STEPS } from '@bsh/scribbit-playground-kit';
import type { PlaygroundConfig } from './config';
import type { PlaygroundWallet, Services } from './services/types';
import type { CommitResult, Plan, RevealResult } from './lib/flow';
import { defaultSolver, type PowSolver } from './lib/pow';
import { sessionStore, type KeyValueStore } from './lib/throwaway';
import { jsonTwinData } from './twin';
import { Stepper, TestNetBanner, Timer } from './components/parts';
import { WalletStep } from './steps/WalletStep';
import { CoinsStep, type Funding } from './steps/CoinsStep';
import { FileStep } from './steps/FileStep';
import { InscribeStep } from './steps/InscribeStep';
import { CertificateStep } from './steps/CertificateStep';

export interface AppProps {
  config: PlaygroundConfig;
  services: Services;
  store?: KeyValueStore | null;
  solver?: PowSolver;
  now?: () => number;
  /** Test hook: faucet UTXO polling interval. */
  pollMs?: number;
}

interface State {
  step: number;
  wallet: PlaygroundWallet | null;
  funding: Funding | null;
  plan: Plan | null;
  committed: CommitResult | null;
  revealed: RevealResult | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const INITIAL: State = { step: 0, wallet: null, funding: null, plan: null, committed: null, revealed: null, startedAt: null, finishedAt: null };

export function App({ config, services, store = sessionStore(), solver = defaultSolver(), now = () => Date.now(), pollMs }: AppProps) {
  const [s, setS] = useState<State>(INITIAL);
  const set = (p: Partial<State>) => setS((cur) => ({ ...cur, ...p }));

  useEffect(() => {
    document.title = `${STEPS[s.step]!.title} · Signet Playground · scribb.it`;
  }, [s.step]);

  if (config.format === 'json') {
    return (
      <main id="main" className="page">
        <h1>Signet Playground (JSON)</h1>
        <pre className="json" data-testid="json-twin">
          {JSON.stringify(jsonTwinData(config), null, 2)}
        </pre>
      </main>
    );
  }

  const start = () => setS((cur) => (cur.startedAt === null ? { ...cur, startedAt: now() } : cur));
  const elapsed = s.startedAt === null ? 0 : ((s.finishedAt ?? now()) - s.startedAt) / 1000;

  return (
    <div className="frame">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <TestNetBanner demo={services.mode === 'demo'} />
      <header className="header">
        <a className="brand" href={config.base}>
          <span className="brand__mark">
            scribb<span className="brand__dot">.</span>it
          </span>
          <span className="brand__tag">signet playground</span>
        </a>
        <Timer startedAt={s.startedAt} finishedAt={s.finishedAt} goalSeconds={config.goalSeconds} now={now} />
        <div className="net">
          <span className="net__dot net__dot--test" aria-hidden="true" />
          <span>signet</span>
        </div>
      </header>
      <Stepper steps={STEPS} current={s.step} done={s.step} />
      <main id="main" className="page">
        {s.step === 0 ? <WalletStep services={services} config={config} store={store} onStart={start} onReady={(wallet) => set({ wallet, step: 1 })} /> : null}
        {s.step === 1 && s.wallet ? <CoinsStep services={services} config={config} wallet={s.wallet} solver={solver} {...(pollMs !== undefined ? { pollMs } : {})} onFunded={(funding) => set({ funding, step: 2 })} /> : null}
        {s.step === 2 && s.wallet ? <FileStep services={services} config={config} wallet={s.wallet} onPlanned={(plan) => set({ plan, step: 3 })} /> : null}
        {s.step === 3 && s.wallet && s.plan ? <InscribeStep services={services} config={config} wallet={s.wallet} plan={s.plan} onBack={() => set({ plan: null, step: 2 })} onDone={(committed, revealed) => set({ committed, revealed, step: 4, finishedAt: now() })} /> : null}
        {s.step === 4 && s.wallet && s.plan && s.committed && s.revealed ? (
          <CertificateStep services={services} config={config} wallet={s.wallet} plan={s.plan} committed={s.committed} revealed={s.revealed} elapsedSeconds={elapsed} onRestart={() => setS(INITIAL)} />
        ) : null}
      </main>
      <footer className="footer">
        <p>
          scribb.it Signet Playground · everything here happens on <strong>signet</strong>, a test network · keys stay in your browser ·{' '}
          <a href={`${config.base}playground.json`}>playground.json</a> · <a href={`${config.base}llms.txt`}>llms.txt</a>
          {services.mode === 'demo' ? ' · demo mode (offline)' : ''}
        </p>
      </footer>
    </div>
  );
}
