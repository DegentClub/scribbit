import { useEffect, useRef, useState } from 'react';
import { expectedHashes, stepContent } from '@bsh/scribbit-playground-kit';
import { Alert } from '@bsh/scribbit-mint/src/components/ui';
import { fmtSats } from '@bsh/scribbit-mint/src/lib/format';
import type { PlaygroundConfig } from '../config';
import { addressUrl, txUrl } from '../config';
import { FaucetError, type PlaygroundWallet, type Services } from '../services/types';
import type { PowSolver } from '../lib/pow';
import { Copy, ExplainPanel, OnChainCard, Progress, StepHeading, TxLink } from '../components/parts';

const STEP = stepContent('coins');

export interface Funding {
  via: 'faucet' | 'existing';
  txid: string | null;
  amountSats: number;
  balanceSats: number;
}

type Phase = { kind: 'idle' } | { kind: 'challenge' } | { kind: 'work'; hashes: number; fraction: number; difficulty: number } | { kind: 'drip' } | { kind: 'wait'; txid: string; amountSats: number } | { kind: 'error'; title: string; body: string; retry: boolean };

/** Plain-language text for every faucet refusal code in the contract (and the client-side ones). */
export function faucetMessage(e: unknown): { title: string; body: string; retry: boolean } {
  if (!(e instanceof FaucetError)) return { title: 'That did not work', body: String((e as Error)?.message ?? e), retry: true };
  const wait = e.retryAfterSeconds ? ` Try again in about ${humanDuration(e.retryAfterSeconds)}.` : '';
  switch (e.code) {
    case 'faucet_empty':
      return { title: 'The faucet is empty right now', body: 'Its signet wallet ran dry and an operator has to refill it. Nothing was sent. You can use any other signet faucet with the address above, then check your balance.', retry: true };
    case 'address_rate_limited':
      return { title: 'This address already got test coins today', body: `Each address gets one drip per day.${wait} Or make a new throwaway key in step 1.`, retry: false };
    case 'ip_rate_limited':
    case 'rate_limited':
      return { title: 'Too many requests from your network', body: `The faucet limits drips per network to stay fair.${wait}`, retry: true };
    case 'budget_exhausted':
      return { title: "Today's faucet budget is spent", body: `The faucet gives away a fixed amount per day and resets at 00:00 UTC.${wait} You can use any other signet faucet with the address above.`, retry: false };
    case 'faucet_disabled':
      return { title: 'No faucet on this page', body: 'This deployment has no faucet switched on. Send signet coins to the address above from any signet faucet, then check your balance.', retry: false };
    case 'challenge_expired':
    case 'challenge_used':
    case 'challenge_unknown':
    case 'pow_invalid':
      return { title: 'The puzzle did not count', body: 'The faucet did not accept this proof of work (it expired or was already used). Try again: a new puzzle is fetched.', retry: true };
    case 'mainnet_address_refused':
    case 'wrong_network':
    case 'invalid_address':
      return { title: 'The faucet refused this address', body: e.message, retry: false };
    case 'wallet_unavailable':
    case 'unreachable':
      return { title: 'The faucet did not answer', body: 'Nothing was sent. Wait a moment and try again.', retry: true };
    default:
      return { title: 'The faucet said no', body: `${e.message} (${e.code})`, retry: true };
  }
}

function humanDuration(s: number): string {
  if (s < 90) return `${Math.ceil(s)} seconds`;
  if (s < 5400) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

export function CoinsStep({ services, config, wallet, solver, onFunded, pollMs = 1500 }: { services: Services; config: PlaygroundConfig; wallet: PlaygroundWallet; solver: PowSolver; onFunded: (f: Funding) => void; pollMs?: number }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [balance, setBalance] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  const address = wallet.payment.address;
  useEffect(() => () => void (alive.current = false), []);

  const readBalance = async () => (await services.chain.getUtxos(address)).reduce((s, u) => s + u.value, 0);

  const checkBalance = async () => {
    setChecking(true);
    try {
      const b = await readBalance();
      setBalance(b);
      if (b > 0) onFunded({ via: 'existing', txid: null, amountSats: 0, balanceSats: b });
    } catch (e) {
      setPhase({ kind: 'error', title: 'Could not read the balance', body: String((e as Error).message), retry: true });
    } finally {
      setChecking(false);
    }
  };

  const getCoins = async () => {
    setPhase({ kind: 'challenge' });
    try {
      const ch = await services.faucet.challenge();
      setPhase({ kind: 'work', hashes: 0, fraction: 0, difficulty: ch.difficulty });
      const { solution } = await solver({ nonce: ch.nonce, address: address.toLowerCase(), difficulty: ch.difficulty, onProgress: (p) => alive.current && setPhase({ kind: 'work', hashes: p.hashes, fraction: p.fraction, difficulty: ch.difficulty }) });
      setPhase({ kind: 'drip' });
      const drip = await services.faucet.drip({ address, nonce: ch.nonce, solution });
      setPhase({ kind: 'wait', txid: drip.txid, amountSats: drip.amountSats });
      // The drip is in the mempool; wait until the signet API lists the coin, then move on.
      for (let i = 0; i < 40 && alive.current; i++) {
        const utxos = await services.chain.getUtxos(address);
        if (utxos.some((u) => u.txid === drip.txid)) {
          const b = utxos.reduce((s, u) => s + u.value, 0);
          setBalance(b);
          onFunded({ via: 'faucet', txid: drip.txid, amountSats: drip.amountSats, balanceSats: b });
          return;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (alive.current) setPhase({ kind: 'error', title: 'The coin has not shown up yet', body: 'The faucet sent it, but the signet API does not list it yet. Check your balance in a moment.', retry: false });
    } catch (e) {
      if (alive.current) setPhase({ kind: 'error', ...faucetMessage(e) });
    }
  };

  const busy = phase.kind === 'challenge' || phase.kind === 'work' || phase.kind === 'drip' || phase.kind === 'wait';

  return (
    <div className="step-grid">
      <div className="stack">
        <StepHeading step={STEP} focus />
        <section className="card" aria-labelledby="coins-h">
          <h2 id="coins-h">Free signet sats</h2>
          <p className="small" style={{ margin: 0 }}>
            To: <span className="mono break">{address}</span> <Copy text={address} label="Copy" />
          </p>
          {services.faucet.configured ? (
            <div className="row">
              <button type="button" className="btn" onClick={getCoins} disabled={busy}>
                {phase.kind === 'idle' || phase.kind === 'error' ? 'Get free test coins' : 'Working…'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={checkBalance} disabled={busy || checking}>
                I already have signet coins
              </button>
            </div>
          ) : (
            <>
              <Alert tone="info" title="No faucet on this page">
                <p>Send a few thousand signet sats to the address above from any public signet faucet, then check your balance.</p>
              </Alert>
              <div>
                <button type="button" className="btn" onClick={checkBalance} disabled={checking}>
                  {checking ? 'Checking…' : 'Check my balance'}
                </button>
              </div>
            </>
          )}
          <div aria-live="polite" className="stack" style={{ gap: 8 }}>
            {phase.kind === 'challenge' ? <p className="small">Asking the faucet for a puzzle…</p> : null}
            {phase.kind === 'work' ? (
              <>
                <p className="small" style={{ margin: 0 }}>
                  Your browser is solving the puzzle: {phase.difficulty} leading zero bits, about {expectedHashes(phase.difficulty).toLocaleString('en-US')} hashes on average. Tried {phase.hashes.toLocaleString('en-US')}.
                </p>
                <Progress fraction={phase.fraction} label="Proof of work" />
              </>
            ) : null}
            {phase.kind === 'drip' ? <p className="small">Puzzle solved. Asking the faucet to send…</p> : null}
            {phase.kind === 'wait' ? <p className="small">Sent {fmtSats(phase.amountSats)}. Waiting for the signet API to list the coin…</p> : null}
            {balance !== null && balance === 0 ? <p className="small warn-text">No coins at this address yet.</p> : null}
          </div>
          {phase.kind === 'error' ? (
            <Alert tone="bad" title={phase.title}>
              <p>{phase.body}</p>
              {phase.retry ? (
                <button type="button" className="btn btn--ghost btn--small" onClick={getCoins}>
                  Try again
                </button>
              ) : null}
            </Alert>
          ) : null}
        </section>
        <OnChainCard step={STEP} items={phase.kind === 'wait' ? [['Faucet transaction', <TxLink key="t" href={txUrl(config, phase.txid)} txid={phase.txid} />], ['Amount', fmtSats(phase.amountSats)], ['Status', 'in the mempool (unconfirmed)']] : [['Your address', <a key="a" className="mono break" href={addressUrl(config, address)} target="_blank" rel="noreferrer noopener">{address}</a>]]} />
      </div>
      <ExplainPanel step={STEP} />
    </div>
  );
}
