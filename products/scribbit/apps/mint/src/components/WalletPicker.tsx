import { useState } from 'react';
import type { Network } from '@bsh/inscription';
import type { Services, WalletId, WalletSession } from '../services/types';
import { capabilityBadges, isUnverified, planRevealSigning, UNVERIFIED_COPY } from '../lib/walletRouting';
import { describeError } from '../lib/errors';
import { ErrorBox, Kv } from './ui';
import { shortHex } from '../lib/format';
import { hex } from '@scure/base';

/** All seven wallets, install links, capability badges. `only` narrows the list (counters: XCP + Horizon first). */
export function WalletPicker({ services, network, wallet, onConnected, onDisconnect, prefer }: { services: Services; network: Network; wallet: WalletSession | null; onConnected: (w: WalletSession) => void; onDisconnect: () => void; prefer?: WalletId[] }) {
  const [busy, setBusy] = useState<WalletId | null>(null);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const options = services.wallets.list();
  const ordered = prefer ? [...options].sort((a, b) => Number(prefer.includes(b.id)) - Number(prefer.includes(a.id))) : options;

  if (wallet) {
    return (
      <div className="stack">
        <div className="spread">
          <p style={{ margin: 0 }}>
            <strong>Connected: {wallet.name}</strong>
          </p>
          <button type="button" className="btn btn--ghost btn--small" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
        <Kv
          items={[
            ['Inscriptions to', <span className="break" key="o">{wallet.ordinals.address}</span>],
            ['Pays from', <span className="break" key="p">{wallet.payment.address}</span>],
            ['Leaf key', leafKeyText(wallet)],
          ]}
        />
        <div className="badges" aria-label="Wallet capabilities">
          {capabilityBadges(wallet.capabilities).map((b) => (
            <span key={b.label} className={`badge ${badgeClass(b.ok)}`}>
              {b.ok === 'unknown' && !b.label.includes('unknown') ? `${b.label}?` : b.label}
            </span>
          ))}
        </div>
        {isUnverified(wallet.id, wallet.capabilities) ? (
          <p className="hint warn-text">
            <strong>Reveal signing {UNVERIFIED_COPY}.</strong> {wallet.name}'s script-path signing is assumed from its documentation, not proven against the extension.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="stack">
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      <div className="wallets">
        {ordered.map((o) => (
          <div className="wallet" key={o.id}>
            <div className="spread">
              <strong>{o.name}</strong>
              <span className="small muted">{o.installed ? 'detected' : 'not installed'}</span>
            </div>
            <div className="badges">
              {capabilityBadges(o.capabilities)
                .slice(0, 2)
                .map((b) => (
                  <span key={b.label} className={`badge ${badgeClass(b.ok)}`}>
                    {b.ok === false ? 'no ' : ''}
                    {b.label}
                    {b.ok === 'unknown' ? '?' : ''}
                  </span>
                ))}
            </div>
            {o.unverified ? <span className="small warn-text">{UNVERIFIED_COPY}</span> : null}
            {o.installed ? (
              <button
                type="button"
                className="btn btn--small"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(o.id);
                  setError(null);
                  try {
                    onConnected(await services.wallets.connect(o.id, network));
                  } catch (e) {
                    setError(describeError(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === o.id ? 'Waiting for wallet…' : `Connect ${o.name}`}
              </button>
            ) : (
              <a className="small" href={o.installUrl} target="_blank" rel="noreferrer noopener">
                Install {o.name} ↗
              </a>
            )}
          </div>
        ))}
      </div>
      <p className="hint">You need a Taproot (bc1p…) address for the inscription and a SegWit or Taproot address to pay from. Your wallet signs every transaction; this site never sees a key.</p>
    </div>
  );
}

const badgeClass = (ok: boolean | 'unknown') => (ok === true ? 'badge--ok' : ok === 'unknown' ? 'badge--unknown' : 'badge--no');

function leafKeyText(wallet: WalletSession): string {
  try {
    const plan = planRevealSigning(wallet);
    return plan.leafKeyKind === 'output' ? `taproot output key ${shortHex(hex.encode(plan.leafPubkey))}${plan.sighash === 'all' ? ' (SIGHASH_ALL)' : ''}` : `internal key ${shortHex(hex.encode(plan.leafPubkey))} (signed untweaked)`;
  } catch {
    return 'cannot sign reveals';
  }
}
