import { useState } from 'react';
import { stepContent } from '@bsh/scribbit-playground-kit';
import { ErrorBox } from '@bsh/scribbit-mint/src/components/ui';
import { describeError } from '@bsh/scribbit-mint/src/lib/errors';
import type { PlaygroundConfig } from '../config';
import { addressUrl } from '../config';
import type { PlaygroundWallet, Services, WalletId } from '../services/types';
import { exportBackup, forgetThrowaway, generateThrowaway, loadThrowaway, saveThrowaway, throwawayWallet, type KeyValueStore } from '../lib/throwaway';
import { externalWallet } from '../lib/flow';
import { signetStatuses, STATUS_COPY, summaryLine, CONFORMANCE_SOURCE } from '../lib/walletStatus';
import { Copy, ExplainPanel, OnChainCard, StepHeading } from '../components/parts';

const STEP = stepContent('wallet');

export function WalletStep({ services, config, store, onReady, onStart }: { services: Services; config: PlaygroundConfig; store: KeyValueStore | null; onReady: (w: PlaygroundWallet) => void; onStart: () => void }) {
  const [existing, setExisting] = useState(() => loadThrowaway(store));
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const statuses = signetStatuses();
  const options = services.wallets.list();

  const pickThrowaway = (fresh: boolean) => {
    onStart();
    const rec = fresh || !existing ? generateThrowaway() : existing;
    saveThrowaway(store, rec);
    setExisting(rec);
    onReady(throwawayWallet(rec));
  };

  const connect = async (id: WalletId) => {
    onStart();
    setBusy(id);
    setError(null);
    try {
      const session = await services.wallets.connect(id, 'signet');
      onReady(externalWallet(session));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="step-grid">
      <div className="stack">
        <StepHeading step={STEP} focus={false} />
        <section className="card" aria-labelledby="throwaway-h">
          <h2 id="throwaway-h">Quickest: a throwaway test key</h2>
          <p>
            Your browser makes a fresh key and keeps it only in this tab (sessionStorage). Close the tab and it is gone. It is a <strong>signet</strong> key: it can only make <code>tb1p…</code> addresses.
          </p>
          <div className="row">
            {existing ? (
              <>
                <button type="button" className="btn" onClick={() => pickThrowaway(false)}>
                  Continue with this tab's test key
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => pickThrowaway(true)}>
                  Make a new one
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => pickThrowaway(true)}>
                Make a throwaway test key
              </button>
            )}
          </div>
          {existing ? <ThrowawayDetails record={existing} config={config} onForget={() => (forgetThrowaway(store), setExisting(null))} /> : null}
        </section>

        <section className="card card--quiet" aria-labelledby="real-h">
          <h2 id="real-h">Or: your own wallet, switched to signet</h2>
          <p className="small">{summaryLine(statuses)}</p>
          <ErrorBox error={error} onDismiss={() => setError(null)} />
          <ul className="wallets" aria-label="Wallets">
            {options.map((o) => {
              const st = statuses.find((s) => s.id === o.id);
              const usable = st?.usable ?? false;
              return (
                <li className="wallet" key={o.id}>
                  <div className="spread">
                    <strong>{o.name}</strong>
                    <span className="small muted">{o.installed ? 'detected' : 'not installed'}</span>
                  </div>
                  {st ? (
                    <p className={`small ${st.verified ? 'good-text' : 'warn-text'}`} data-testid={`status-${o.id}`}>
                      Signet: {STATUS_COPY[st.signet]}. Inscription signing ({st.leafCapability === 'taproot-tweaked' ? 'tweaked key' : 'internal key'}): {STATUS_COPY[st.leafSigning]}.
                    </p>
                  ) : (
                    <p className="small warn-text">Not in the conformance matrix: unknown on signet.</p>
                  )}
                  {!usable ? (
                    <span className="small muted">Not available on signet</span>
                  ) : o.installed ? (
                    <button type="button" className="btn btn--small" disabled={busy !== null} onClick={() => connect(o.id)}>
                      {busy === o.id ? 'Waiting for wallet…' : `Connect ${o.name}`}
                    </button>
                  ) : (
                    <a className="small" href={o.installUrl} target="_blank" rel="noreferrer noopener">
                      Install {o.name} ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="hint">
            Statuses come from the wallet conformance matrix ({CONFORMANCE_SOURCE.repo} <code>{CONFORMANCE_SOURCE.path}</code>, as of {CONFORMANCE_SOURCE.asOf}). "Assumed" means the code path is tested against a simulated wallet only. Switch your wallet to signet before connecting.
          </p>
        </section>
        <OnChainCard step={STEP} />
      </div>
      <ExplainPanel step={STEP} />
    </div>
  );
}

function ThrowawayDetails({ record, config, onForget }: { record: ReturnType<typeof generateThrowaway>; config: PlaygroundConfig; onForget: () => void }) {
  const w = throwawayWallet(record);
  const [show, setShow] = useState(false);
  const backup = show ? exportBackup(record) : null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small" style={{ margin: 0 }}>
        Address:{' '}
        <a className="mono break" href={addressUrl(config, w.ordinals.address)} target="_blank" rel="noreferrer noopener">
          {w.ordinals.address}
        </a>
      </p>
      <details onToggle={(e) => setShow((e.target as HTMLDetailsElement).open)}>
        <summary>Backup (optional)</summary>
        {backup ? (
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            <p className="small warn-text">Anyone with this can spend this key's signet coins. It is a TEST key: it is refused by mainnet software, and it should never receive real bitcoin.</p>
            <code className="break small" data-testid="backup-descriptor">{backup.descriptor}</code>
            <div className="row">
              <Copy text={backup.descriptor} label="Copy descriptor" />
            </div>
            <p className="hint">Import on signet with Bitcoin Core: <code>importdescriptors</code> after <code>getdescriptorinfo</code> adds the checksum.</p>
          </div>
        ) : null}
      </details>
      <div>
        <button type="button" className="btn btn--ghost btn--small" onClick={onForget}>
          Forget this key now
        </button>
      </div>
    </div>
  );
}
