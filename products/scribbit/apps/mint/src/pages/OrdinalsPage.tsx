import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AppConfig } from '../config';
import type { Services, WalletSession } from '../services/types';
import { initialOrdinalsState, ordinalsReducer, ORDINALS_STEPS, type ContentItem, type OrdinalsStep } from '../flows/ordinals/state';
import { pendingRecord, prepareCommit, quoteItem, rescueFromPending, revealFromPending, signAndBroadcastCommit, signAndBroadcastReveal } from '../flows/ordinals/effects';
import { clearPendingOrdinals, loadPendingOrdinals, type KeyValueStore } from '../lib/pending';
import { describeError } from '../lib/errors';
import { guessContentType, CONTENT_TYPE_RE } from '../lib/mime';
import { fmtBytes, fmtRate, fmtSats, fmtWeight, shortHex } from '../lib/format';
import { blockspaceInscriptionUrl, ordinalsContentUrl, ordinalsInscriptionUrl, txUrl } from '../lib/explorers';
import { planRevealSigning } from '../lib/walletRouting';
import { Alert, CostTable, ErrorBox, Explainer, FeePicker, Kv } from '../components/ui';
import { WalletPicker } from '../components/WalletPicker';

const STEP_LABEL: Record<OrdinalsStep, string> = { connect: 'Connect', content: 'Content', quote: 'Quote', commit: 'Commit', reveal: 'Reveal', done: 'Done' };
const MAX_BYTES = 3_900_000;
let nextId = 0;

export function OrdinalsPage({ app, services, store }: { app: AppConfig; services: Services; store: KeyValueStore | null }) {
  const [state, dispatch] = useReducer(ordinalsReducer, undefined, () => initialOrdinalsState(app.network, loadPendingOrdinals(store)));
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const item: ContentItem | undefined = state.items[state.current];

  useEffect(() => {
    let alive = true;
    services.chain
      .getFees()
      .then((f) => alive && dispatch({ type: 'FEES_LOADED', fees: f }))
      .catch(() => alive && dispatch({ type: 'FEES_LOADED', fees: null }));
    return () => {
      alive = false;
    };
  }, [services]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [state.step]);

  const run = useCallback(async (what: string, fn: () => Promise<void> | void) => {
    dispatch({ type: 'BUSY', what });
    dispatch({ type: 'ERROR', error: null });
    try {
      await fn();
    } catch (e) {
      dispatch({ type: 'ERROR', error: describeError(e) });
    } finally {
      dispatch({ type: 'BUSY', what: null });
    }
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const items: ContentItem[] = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (bytes.length > MAX_BYTES) {
          dispatch({ type: 'ERROR', error: { message: `${f.name} is ${fmtBytes(bytes.length)}, over the ${fmtBytes(MAX_BYTES)} a single block can carry.`, hint: 'Compress it or split it; the largest standard inscription is about 390 KB, a block-sized one about 3.9 MB.' } });
          continue;
        }
        items.push({ id: `f${++nextId}`, fileName: f.name, bytes, contentType: guessContentType(bytes, f.name, f.type), sha256: services.inscription.sha256Hex(bytes), size: bytes.length });
      }
      if (items.length) dispatch({ type: 'ITEMS_ADDED', items });
    },
    [services],
  );

  const addText = () => {
    const bytes = Uint8Array.from(new TextEncoder().encode(text));
    if (!bytes.length) return;
    dispatch({ type: 'ITEMS_ADDED', items: [{ id: `t${++nextId}`, fileName: 'text.txt', bytes, contentType: 'text/plain;charset=utf-8', sha256: services.inscription.sha256Hex(bytes), size: bytes.length }] });
    setText('');
  };

  const doQuote = () =>
    run('Quoting', async () => {
      if (!state.wallet || !item || state.feeRate === null) return;
      const q = quoteItem(services, { network: app.network, wallet: state.wallet, item, options: state.options, feeRate: state.feeRate });
      dispatch({ type: 'QUOTED', quote: q });
      // Fetch UTXOs now so the funding fee is known before the user commits.
      const { commit, reveal } = await prepareCommit(services, { network: app.network, wallet: state.wallet, item, options: state.options, quote: q });
      dispatch({ type: 'QUOTED', quote: { ...q, fundingFee: commit.fundingFee, fundingVsize: null } });
      dispatch({ type: 'COMMIT_PREPARED', commit, reveal });
      dispatch({ type: 'GO', step: 'quote' });
    });

  const doCommit = () =>
    run('Waiting for your wallet to sign the commit', async () => {
      if (!state.wallet || !item || !state.quote || !state.commit) return;
      const pending = pendingRecord({ network: app.network, wallet: state.wallet, item, options: state.options, quote: state.quote, commit: state.commit });
      const txid = await signAndBroadcastCommit(services, store, { wallet: state.wallet, commit: state.commit, pending });
      dispatch({ type: 'COMMIT_BROADCAST', txid, pending });
    });

  const doReveal = (mode: 'reveal' | 'rescue' = 'reveal') =>
    run(mode === 'rescue' ? 'Rebuilding and signing the rescue reveal' : 'Waiting for your wallet to sign the reveal', async () => {
      if (!state.wallet) throw Object.assign(new Error('Connect the wallet that made the commit.'), {});
      let reveal = state.reveal;
      if (state.pending) {
        if (state.pending.ordinalsAddress !== state.wallet.ordinals.address) throw new Error(`This commit belongs to ${state.pending.ordinalsAddress}; connect that account to sign its reveal.`);
        const plan = planRevealSigning(state.wallet);
        reveal = mode === 'rescue' ? rescueFromPending(services, state.pending, plan.sighash) : (reveal?.psbtBase64 ? reveal : revealFromPending(services, state.pending, plan.sighash));
      }
      if (!reveal) return;
      const r = await signAndBroadcastReveal(services, store, { wallet: state.wallet, reveal });
      dispatch({ type: 'REVEAL_SIGNED', reveal: { ...reveal, txid: r.txid, hex: r.hex, weight: r.weight, broadcastVia: r.broadcastVia } });
      dispatch({ type: 'REVEAL_BROADCAST', txid: r.txid, inscriptionId: r.inscriptionId });
    });

  const resume = () => {
    if (!state.pending) return;
    try {
      const reveal = state.wallet ? revealFromPending(services, state.pending, planRevealSigning(state.wallet).sighash) : { psbtBase64: '' };
      dispatch({ type: 'RESUME_PENDING', pending: state.pending, reveal, wallet: state.wallet });
    } catch (e) {
      dispatch({ type: 'ERROR', error: describeError(e) });
    }
  };

  const costRows = useMemo(() => {
    if (!state.quote) return [];
    const q = state.quote.quote;
    return [
      { label: 'Reveal fee', sats: q.revealFee, note: `${fmtWeight(q.weight)} · ${q.vsize.toLocaleString('en-US')} vB × ${fmtRate(state.quote.feeRate)}` },
      { label: 'Postage (stays with your inscription)', sats: state.options.postage },
      { label: 'Commit transaction fee', sats: state.quote.fundingFee ?? 0, note: state.quote.fundingFee === null ? 'estimated after your coins are read' : 'the funding transaction itself' },
      { label: 'scribb.it service fee', sats: 0, note: 'none' },
    ];
  }, [state.quote, state.options.postage]);

  const stepIndex = ORDINALS_STEPS.indexOf(state.step);
  const batch = state.items.length > 1;

  return (
    <div className="page">
      <header>
        <p className="card__kicker">/ordinals</p>
        <h1 ref={headingRef} tabIndex={-1}>
          Inscribe anything
        </h1>
        <p className="lede">Any file or text, written to Bitcoin as an Ordinals inscription. You see the exact bytes, the exact weight and the exact cost before your wallet signs anything.</p>
      </header>

      <ol className="steps" aria-label="Progress">
        {ORDINALS_STEPS.map((s, i) => (
          <li key={s} aria-current={s === state.step ? 'step' : undefined} className={i < stepIndex ? 'is-done' : undefined}>
            {i + 1}. {STEP_LABEL[s]}
          </li>
        ))}
      </ol>

      {state.pending && state.step !== 'reveal' && state.step !== 'done' ? (
        <Alert tone="warn" title="You have an unfinished inscription">
          <p>
            The commit <code>{shortHex(state.pending.commitTxid)}</code> for <strong>{state.pending.fileName}</strong> was broadcast but its reveal was not. Nothing is lost: only your wallet's key can open it, and the reveal can be signed again at any time.
          </p>
          <div className="row">
            <button type="button" className="btn btn--small" onClick={resume}>
              Resume: sign the reveal
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => (clearPendingOrdinals(store), dispatch({ type: 'PENDING_CLEARED' }))}>
              Forget it (I finished elsewhere)
            </button>
          </div>
        </Alert>
      ) : null}

      <ErrorBox error={state.error} onDismiss={() => dispatch({ type: 'ERROR', error: null })} />
      {state.busy ? (
        <p role="status" className="small">
          <span className="mono">⧗</span> {state.busy}…
        </p>
      ) : null}

      <div className="grid-2">
        <div className="stack">
          <section className="card" aria-labelledby="sec-wallet">
            <p className="card__kicker">1 · Connect</p>
            <h2 id="sec-wallet">Your wallet</h2>
            <WalletPicker services={services} network={app.network} wallet={state.wallet} onConnected={(w: WalletSession) => dispatch({ type: 'WALLET_CONNECTED', wallet: w })} onDisconnect={() => dispatch({ type: 'WALLET_DISCONNECTED' })} />
          </section>

          {state.wallet && state.step !== 'reveal' && state.step !== 'done' ? (
            <section className="card" aria-labelledby="sec-content">
              <p className="card__kicker">2 · Content</p>
              <h2 id="sec-content">What to write</h2>
              <div
                className={`drop ${over ? 'is-over' : ''}`}
                onDragOver={(e) => (e.preventDefault(), setOver(true))}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  void addFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <p style={{ margin: 0 }}>Drop files here, or</p>
                <label htmlFor="file-input" className="btn btn--small" style={{ display: 'inline-block', marginTop: 8 }}>
                  Choose files
                </label>
                <input id="file-input" type="file" multiple aria-label="Choose files to inscribe" className="sr-only" onChange={(e) => void addFiles(Array.from(e.target.files ?? []))} />
              </div>
              <div>
                <label htmlFor="paste-text">…or paste text</label>
                <textarea id="paste-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="gm, Bitcoin." />
                <button type="button" className="btn btn--ghost btn--small" style={{ marginTop: 6 }} disabled={!text} onClick={addText}>
                  Add text
                </button>
              </div>
              {state.items.length ? (
                <ul className="files" aria-label="Files to inscribe">
                  {state.items.map((it, i) => (
                    <li className="file" key={it.id}>
                      <Thumb item={it} />
                      <div style={{ minWidth: 0 }}>
                        <strong className="break">{it.fileName}</strong>
                        {batch ? <span className="small muted"> · #{i + 1}</span> : null}
                        <div className="small mono">{fmtBytes(it.size)} · sha256 {shortHex(it.sha256, 6)}</div>
                        <label htmlFor={`ct-${it.id}`} className="sr-only">
                          Content type for {it.fileName}
                        </label>
                        <input id={`ct-${it.id}`} type="text" value={it.contentType} onChange={(e) => dispatch({ type: 'ITEM_TYPE_CHANGED', id: it.id, contentType: e.target.value })} style={{ marginTop: 4, padding: '4px 8px' }} />
                        {!CONTENT_TYPE_RE.test(it.contentType) ? <div className="field-error">Not a valid MIME type.</div> : null}
                      </div>
                      <button type="button" className="btn btn--ghost btn--small" aria-label={`Remove ${it.fileName}`} onClick={() => dispatch({ type: 'ITEM_REMOVED', id: it.id })} disabled={i < state.current}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <details>
                <summary>Options: parent, metadata, postage</summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div>
                    <label htmlFor="parent">Parent inscription id (optional)</label>
                    <input id="parent" type="text" placeholder="…i0" value={state.options.parentId} onChange={(e) => dispatch({ type: 'OPTIONS_CHANGED', options: { parentId: e.target.value } })} />
                    <p className="hint">Recorded in the envelope (tag 3). Proving provenance on chain also needs the parent spent in the reveal, which this page does not do yet: the tag alone is a claim, not proof.</p>
                  </div>
                  <div>
                    <label htmlFor="meta">Metadata JSON (optional, stored as CBOR)</label>
                    <textarea id="meta" value={state.options.metadataJson} onChange={(e) => dispatch({ type: 'OPTIONS_CHANGED', options: { metadataJson: e.target.value } })} placeholder='{"title": "…"}' />
                  </div>
                  <div>
                    <label htmlFor="postage">Postage (sats that carry the inscription)</label>
                    <input id="postage" type="number" min={330} value={state.options.postage.toString()} onChange={(e) => dispatch({ type: 'OPTIONS_CHANGED', options: { postage: BigInt(Math.max(330, Number(e.target.value) || 546)) } })} />
                  </div>
                </div>
              </details>
              <FeePicker fees={state.fees} value={state.feeRate} onChange={(r) => dispatch({ type: 'FEE_RATE_CHANGED', feeRate: r })} block />
              <button type="button" className="btn" disabled={!item || state.feeRate === null || !!state.busy || !CONTENT_TYPE_RE.test(item?.contentType ?? '')} onClick={doQuote}>
                {batch ? `Quote #${state.current + 1} of ${state.items.length}` : 'Get exact quote'}
              </button>
            </section>
          ) : null}

          {state.quote && state.commit && (state.step === 'quote' || state.step === 'commit') && item ? (
            <section className="card" aria-labelledby="sec-quote">
              <p className="card__kicker">3 · Quote → 4 · Commit</p>
              <h2 id="sec-quote">The bill, to the sat</h2>
              <p className="small">
                Lane:{' '}
                <strong>
                  {state.quote.quote.lane === 'standard' ? 'Standard (≤ 400,000 WU, relays normally)' : state.quote.quote.lane === 'block' ? 'Non-standard (block-sized: needs a direct-to-miner relay)' : 'Too big for any block'}
                </strong>
              </p>
              {state.quote.quote.lane !== 'standard' ? (
                <Alert tone="warn" title="This reveal is over the 400,000 WU standard relay limit">
                  <p>Ordinary nodes will not relay it at any fee rate. It must be submitted to a miner that accepts non-standard transactions (Libre Relay / Slipstream). Do not fund it unless you have that route.</p>
                </Alert>
              ) : null}
              <CostTable caption="Cost of this inscription" rows={costRows} />
              <Kv
                items={[
                  ['Commit address', <span className="break" key="c">{state.quote.commitAddress}</span>],
                  ['Commit value', fmtSats(state.quote.quote.commitValue)],
                  ['Funding txid', <span className="break" key="t">{state.commit.txid}</span>],
                  ['Leaf key', `${state.quote.plan.leafKeyKind === 'output' ? 'taproot output key' : 'internal key (untweaked)'}`],
                ]}
              />
              <p className="small muted">
                Your wallet will sign the funding transaction <strong>without broadcasting it</strong>. This page checks the signed transaction still has txid <code>{shortHex(state.commit.txid)}</code> (the reveal is built against it), then broadcasts it.
              </p>
              <button type="button" className="btn" disabled={!!state.busy || state.quote.quote.lane === null} onClick={doCommit}>
                Sign commit with {state.wallet?.name}
              </button>
            </section>
          ) : null}

          {state.step === 'reveal' ? (
            <section className="card" aria-labelledby="sec-reveal">
              <p className="card__kicker">5 · Reveal</p>
              <h2 id="sec-reveal">Reveal the inscription</h2>
              <CommitStatus services={services} txid={state.commit?.broadcastTxid ?? state.pending?.commitTxid ?? ''} app={app} />
              {!state.wallet ? <p>Connect the wallet that made the commit ({state.pending?.ordinalsAddress}) to sign the reveal.</p> : null}
              <p className="small">The reveal spends the commit through the inscription script, which names your wallet's key. Your wallet signs one tapscript input; this page verifies the signature before broadcasting.</p>
              <div className="row">
                <button type="button" className="btn" disabled={!state.wallet || !!state.busy} onClick={() => doReveal('reveal')}>
                  Sign reveal with {state.wallet?.name ?? 'your wallet'}
                </button>
                <button type="button" className="btn btn--ghost" disabled={!state.wallet || !!state.busy} onClick={() => doReveal('rescue')}>
                  Stuck commit? Re-sign the reveal
                </button>
              </div>
            </section>
          ) : null}

          {state.step === 'done' ? <DoneCard app={app} services={services} state={state} onNext={() => dispatch({ type: 'NEXT_ITEM' })} onRestart={() => dispatch({ type: 'RESTART' })} onConfirmed={(id) => dispatch({ type: 'ITEM_CONFIRMED', inscriptionId: id })} /> : null}
        </div>

        <aside className="stack">
          {batch ? (
            <div className="card card--quiet">
              <p className="card__kicker">Batch</p>
              <p className="small">
                {state.done.length} of {state.items.length} inscribed. Sequential: one commit and reveal at a time, so there is only ever one pending mint.
              </p>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={state.items.length} aria-valuenow={state.done.length} aria-label="Batch progress">
                <span style={{ width: `${(100 * state.done.length) / state.items.length}%` }} />
              </div>
            </div>
          ) : null}
          <Explainer
            title="How it works"
            steps={[
              'Your content goes into an ord envelope: a tapscript that names your wallet key. Its hash commits to a taproot address.',
              'Commit: your wallet pays that address from its own coins. We check the signed transaction is exactly the one quoted, then broadcast it.',
              'Reveal: your wallet signs the spend of that address; the envelope lands in the witness and the inscription goes to your Taproot address with the postage.',
              'No key ever leaves your wallet. If the reveal is interrupted, the commit is still yours: re-sign the reveal any time from this page.',
              'Weight is exact (tests prove it equals the signed transaction). ≤ 400,000 WU relays normally; above that it needs a miner that takes non-standard transactions.',
            ]}
          />
        </aside>
      </div>
    </div>
  );
}

function Thumb({ item }: { item: ContentItem }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item.contentType.startsWith('image/') || typeof URL.createObjectURL !== 'function') return;
    const u = URL.createObjectURL(new Blob([item.bytes.slice()], { type: item.contentType }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [item]);
  return url ? <img className="file__thumb" src={url} alt={`Preview of ${item.fileName} from the exact bytes`} /> : <div className="file__thumb" aria-hidden="true">{item.contentType.split('/')[1]?.slice(0, 6) ?? 'file'}</div>;
}

function CommitStatus({ services, txid, app }: { services: Services; txid: string; app: AppConfig }) {
  const [status, setStatus] = useState<'unknown' | 'mempool' | 'confirmed'>('unknown');
  useEffect(() => {
    if (!txid) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await services.chain.getTx(txid);
        if (alive) setStatus(s ? (s.confirmed ? 'confirmed' : 'mempool') : 'unknown');
      } catch {
        /* keep last */
      }
    };
    void tick();
    const t = setInterval(tick, app.pollIntervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [services, txid, app.pollIntervalMs]);
  return (
    <p className="small">
      Commit <a href={txUrl(app, txid)} target="_blank" rel="noreferrer" className="mono">{shortHex(txid)}</a>: {status === 'confirmed' ? 'confirmed' : status === 'mempool' ? 'in the mempool' : 'not seen yet'}
    </p>
  );
}

function DoneCard({ app, services, state, onNext, onRestart, onConfirmed }: { app: AppConfig; services: Services; state: ReturnType<typeof initialOrdinalsState>; onNext: () => void; onRestart: () => void; onConfirmed: (id: string) => void }) {
  const last = state.done[state.done.length - 1]!;
  const [verify, setVerify] = useState<'idle' | 'waiting' | 'match' | 'mismatch'>('idle');
  const more = state.current + 1 < state.items.length;
  const check = async () => {
    setVerify('waiting');
    for (let i = 0; i < 60; i++) {
      const bytes = await services.chain.getInscriptionContent(last.inscriptionId).catch(() => null);
      if (bytes) {
        const ok = services.inscription.sha256Hex(bytes) === last.sha256;
        setVerify(ok ? 'match' : 'mismatch');
        if (ok) onConfirmed(last.inscriptionId);
        return;
      }
      await new Promise((r) => setTimeout(r, app.pollIntervalMs));
    }
    setVerify('idle');
  };
  return (
    <section className="card" aria-labelledby="sec-done">
      <p className="card__kicker">6 · Done</p>
      <div className="spread">
        <h2 id="sec-done">Written to Bitcoin</h2>
        <span className="stamp">on chain</span>
      </div>
      <Kv
        items={[
          ['Inscription', <span className="break" key="i">{last.inscriptionId}</span>],
          ['File', `${last.fileName} · ${last.contentType}`],
          ['SHA-256', <span className="break" key="h">{last.sha256}</span>],
          ['Commit', <a key="c" href={txUrl(app, last.commitTxid)} target="_blank" rel="noreferrer">{shortHex(last.commitTxid)}</a>],
          ['Reveal', <a key="r" href={txUrl(app, last.revealTxid)} target="_blank" rel="noreferrer">{shortHex(last.revealTxid)}</a>],
        ]}
      />
      <div className="row">
        <a href={ordinalsInscriptionUrl(app, last.inscriptionId)} target="_blank" rel="noreferrer">
          View on ordinals.com ↗
        </a>
        <a href={blockspaceInscriptionUrl(app, last.inscriptionId)} target="_blank" rel="noreferrer">
          View on explore.block.space ↗
        </a>
      </div>
      <div className="row">
        <button type="button" className="btn btn--ghost btn--small" onClick={check} disabled={verify === 'waiting'}>
          Verify bytes
        </button>
        <span role="status" className="small">
          {verify === 'waiting' ? 'Waiting for the indexer to serve the content…' : verify === 'match' ? '✓ On-chain bytes match the SHA-256 above' : verify === 'mismatch' ? '✗ On-chain bytes differ: contact support' : ''}
        </span>
      </div>
      {verify === 'match' ? (
        <p className="small">
          <a href={ordinalsContentUrl(app, last.inscriptionId)} target="_blank" rel="noreferrer">
            Open the raw on-chain content ↗
          </a>
        </p>
      ) : null}
      <div className="row">
        {more ? (
          <button type="button" className="btn" onClick={onNext}>
            Next file ({state.current + 2} of {state.items.length})
          </button>
        ) : (
          <button type="button" className="btn" onClick={onRestart}>
            Inscribe something else
          </button>
        )}
      </div>
    </section>
  );
}

