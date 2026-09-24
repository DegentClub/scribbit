import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { AppConfig } from '../config';
import type { AssetInfo, FairminterParams, MintKind, OwnedAsset, Services, WalletSession } from '../services/types';
import { countersReducer, initialCountersFlow, STAGE_ORDER, type CountersStage } from '../flows/counters/state';
import { finishReveal, mintCounter, preflight, type CountersForm, type PreflightFacts } from '../flows/counters/effects';
import { clearPendingCounters, loadPendingCounters, type KeyValueStore, type PendingCounters } from '../lib/pending';
import { describeError } from '../lib/errors';
import { guessContentType } from '../lib/mime';
import { fmtBytes, fmtQty, fmtRate, parseUnitsToRaw, shortHex } from '../lib/format';
import { countersFunUrl, countersGalleryUrl, slipstreamUrl, txUrl } from '../lib/explorers';
import { Alert, CostTable, ErrorBox, Explainer, FeePicker, Kv } from '../components/ui';
import { WalletPicker } from '../components/WalletPicker';

const STAGE_LABEL: Record<CountersStage, string> = {
  idle: 'Ready',
  checking: 'Checking',
  composing: 'Composing',
  'signing-commit': 'Sign commit',
  'broadcasting-commit': 'Broadcast commit',
  'signing-reveal': 'Sign reveal',
  'broadcasting-reveal': 'Broadcast reveal',
  done: 'Done',
};

const KIND_LABEL: Record<MintKind, string> = { counter: 'Counter', reinscription: 'Reinscription', fairminter: 'Fairminter' };

interface SaleFields {
  lotPrice: string;
  lotSize: string;
  hardCap: string;
  softCap: string;
  poolQuantity: string;
  maxMintPerAddress: string;
  window: string;
}
const XCP69_FIELDS: SaleFields = { lotPrice: '0.01', lotSize: '1000', hardCap: '100000000', softCap: '69000000', poolQuantity: '31000000', maxMintPerAddress: '1000000', window: '1000' };

function customParams(base: FairminterParams, f: SaleFields, startBlock: number): FairminterParams {
  const t = (v: string) => parseUnitsToRaw(v || '0', 8) ?? -1n;
  const window = Math.max(0, Number(f.window) || 0);
  return {
    ...base,
    lotPrice: parseUnitsToRaw(f.lotPrice || '0', 8) ?? -1n,
    lotSize: t(f.lotSize),
    hardCap: t(f.hardCap),
    softCap: t(f.softCap),
    poolQuantity: t(f.poolQuantity),
    maxMintPerAddress: t(f.maxMintPerAddress),
    maxMintPerTx: t(f.maxMintPerAddress),
    startBlock,
    softCapDeadlineBlock: t(f.softCap) > 0n ? startBlock + window : 0,
  };
}

export function CountersPage({ app, services, store }: { app: AppConfig; services: Services; store: KeyValueStore | null }) {
  const kit = services.counters;
  const [flow, dispatch] = useReducer(countersReducer, undefined, () => initialCountersFlow(loadPendingCounters(store)));
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [fees, setFees] = useState<Awaited<ReturnType<Services['chain']['getFees']>> | null>(null);
  const [kind, setKind] = useState<MintKind>('counter');
  const [asset, setAsset] = useState('');
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [mimeType, setMimeType] = useState('');
  const [supply, setSupply] = useState('1');
  const [divisible, setDivisible] = useState(false);
  const [lockQuantity, setLockQuantity] = useState(true);
  const [ordWrapper, setOrdWrapper] = useState(false);
  const [preset, setPreset] = useState<'xcp69' | 'custom'>('xcp69');
  const [sale, setSale] = useState<SaleFields>(XCP69_FIELDS);
  const [feeRate, setFeeRate] = useState<number | null>(null);
  const [route, setRoute] = useState<'public' | 'slipstream'>('public');
  const [tip, setTip] = useState<number | null>(null);
  const [existing, setExisting] = useState<PreflightFacts['existing']>(undefined);
  const [xcpBalance, setXcpBalance] = useState<PreflightFacts['xcpBalance']>(null);
  const [btcAvailable, setBtcAvailable] = useState<PreflightFacts['btcAvailable']>(null);
  const [owned, setOwned] = useState<OwnedAsset[] | null>(null);

  useEffect(() => {
    services.chain.getFees().then((f) => {
      setFees(f);
      setFeeRate((r) => r ?? f.standard.normal);
    }, () => setFees(null));
    services.cp.getTip().then(setTip, () => setTip(null));
  }, [services]);

  // Name lookup (debounced).
  useEffect(() => {
    const name = asset.trim();
    setExisting(undefined);
    if (!name || !kit.checkAssetName(name).ok) return;
    let alive = true;
    const t = setTimeout(() => {
      services.cp.getAsset(name).then(
        (a: AssetInfo | null) => alive && setExisting(a),
        () => alive && setExisting('error'),
      );
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [asset, services, kit]);

  // Balances at the connected address.
  useEffect(() => {
    if (!wallet) return;
    let alive = true;
    const src = wallet.ordinals.address;
    services.cp.getBalance(src, 'XCP').then((b) => alive && setXcpBalance(b), () => alive && setXcpBalance('error'));
    services.chain.getUtxos(src).then((u) => alive && setBtcAvailable(u.reduce((s, x) => s + x.value, 0)), () => alive && setBtcAvailable('error'));
    services.cp.getOwnedAssets(src).then((o) => alive && setOwned(o), () => alive && setOwned([]));
    return () => {
      alive = false;
    };
  }, [wallet, services, flow.result]);

  const fairminter = useMemo<FairminterParams | null>(() => {
    if (kind !== 'fairminter' || tip === null) return null;
    const { startBlock } = kit.xcp69Schedule(tip);
    const base = kit.xcp69Params(startBlock);
    return preset === 'xcp69' ? base : customParams(base, sale, startBlock);
  }, [kind, tip, preset, sale, kit]);

  const form: CountersForm = {
    kind,
    asset,
    bytes: file?.bytes ?? null,
    mimeType,
    feeRate,
    quantity: (() => {
      const r = parseUnitsToRaw(supply || '0', divisible ? 8 : 0);
      return r ?? 0n;
    })(),
    divisible,
    lockQuantity,
    ordWrapper,
    preset,
    fairminter,
    route,
  };
  const pf = preflight(kit, form, { wallet, existing: asset.trim() ? existing : null, xcpBalance, btcAvailable });
  const fit = pf.estimate ? kit.routeFit(pf.estimate.revealWeight) : 'public';
  useEffect(() => {
    if (fit === 'public' && route === 'slipstream') setRoute('public');
  }, [fit, route]);

  const running = flow.stage !== 'idle' && flow.stage !== 'done';
  const deps = useMemo(() => ({ services, store, network: app.network, onStage: (s: CountersStage) => dispatch({ type: 'STAGE', stage: s }), onPending: (p: PendingCounters) => dispatch({ type: 'PENDING_SAVED', pending: p }) }), [services, store, app.network]);

  const mint = useCallback(async () => {
    if (!wallet) return;
    try {
      const result = await mintCounter(deps, wallet, form);
      dispatch({ type: 'DONE', result });
    } catch (e) {
      dispatch({ type: 'FAILED', error: describeError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, deps, JSON.stringify({ ...form, bytes: form.bytes?.length, quantity: form.quantity.toString(), fairminter: form.fairminter ? 'y' : 'n' })]);

  const resume = async () => {
    if (!wallet || !flow.pending) return;
    const p = flow.pending;
    try {
      const r = await finishReveal(deps, wallet, p);
      dispatch({ type: 'DONE', result: { kind: p.mintKind, asset: p.asset, commitTxid: p.commitTxid, revealTxid: r.txid, commitValue: p.commitValue, commitFee: 0, revealFee: p.commitValue, revealWeight: r.weight, route: p.route, ...(p.preset ? { preset: p.preset } : {}) } });
    } catch (e) {
      dispatch({ type: 'FAILED', error: describeError(e) });
    }
  };

  const est = pf.estimate;
  const costRows = est && feeRate
    ? [
        { label: 'Reveal fee (funded into the commit)', sats: est.revealFee, note: `${est.revealWeight.toLocaleString('en-US')} WU × ${fmtRate(feeRate)}` },
        ...(est.revealOutputs ? [{ label: 'Ord wrapper output (back to you)', sats: est.revealOutputs }] : []),
        { label: 'Commit transaction fee (estimated; Counterparty picks the coins)', sats: Math.ceil(155 * feeRate) },
        { label: 'scribb.it service fee', sats: 0, note: 'none' },
      ]
    : [];

  if (flow.result) {
    const r = flow.result;
    return (
      <div className="page">
        <section className="card" aria-labelledby="c-done">
          <p className="card__kicker">/counters · receipt</p>
          <div className="spread">
            <h1 id="c-done" tabIndex={-1}>
              {r.asset}
            </h1>
            <span className="stamp">{r.route === 'slipstream' ? 'signed · awaiting miner' : 'on chain'}</span>
          </div>
          <p className="lede">
            {KIND_LABEL[r.kind]} minted. The counter number is assigned by the indexer once the reveal confirms.
          </p>
          <Kv
            items={[
              ['Commit', <a key="c" href={txUrl(app, r.commitTxid)} target="_blank" rel="noreferrer" className="break">{r.commitTxid}</a>],
              ['Reveal', <a key="r" href={txUrl(app, r.revealTxid)} target="_blank" rel="noreferrer" className="break">{r.revealTxid}</a>],
              ['Reveal weight', `${r.revealWeight.toLocaleString('en-US')} WU`],
              ['Commit value', `${r.commitValue.toLocaleString('en-US')} sats`],
            ]}
          />
          <div className="row">
            <a href={countersGalleryUrl(app, r.asset)} target="_blank" rel="noreferrer">
              counters.gallery ↗
            </a>
            <a href={countersFunUrl(app, r.asset)} target="_blank" rel="noreferrer">
              counters.fun ↗
            </a>
            {r.route === 'slipstream' ? (
              <a href={slipstreamUrl(app)} target="_blank" rel="noreferrer">
                Slipstream ↗
              </a>
            ) : null}
          </div>
          <button type="button" className="btn" onClick={() => dispatch({ type: 'RESET' })}>
            Mint another
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <header>
        <p className="card__kicker">/counters</p>
        <h1 tabIndex={-1}>Mint a Bitcoin Counter</h1>
        <p className="lede">A Counterparty asset whose description is your file, carried in a taproot envelope and numbered gap-free by the counters index. Your wallet signs the commit and the reveal.</p>
      </header>

      {flow.pending ? (
        <Alert tone="warn" title="Unfinished mint">
          <p>
            <strong>{flow.pending.asset}</strong>: the commit <code>{shortHex(flow.pending.commitTxid)}</code> was broadcast but the reveal was not. Nothing is lost; sign the reveal again with the wallet that made it ({shortHex(flow.pending.source, 10)}).
          </p>
          <div className="row">
            <button type="button" className="btn btn--small" disabled={!wallet || running} onClick={resume}>
              Sign the reveal again
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => (clearPendingCounters(store), dispatch({ type: 'PENDING_CLEARED' }))}>
              Forget it
            </button>
          </div>
        </Alert>
      ) : null}
      <ErrorBox error={flow.error} />

      <div className="grid-2">
        <div className="stack">
          <section className="card" aria-labelledby="c-wallet">
            <p className="card__kicker">Wallet</p>
            <h2 id="c-wallet">Connect</h2>
            <WalletPicker services={services} network={app.network} wallet={wallet} prefer={['xcp', 'horizon']} onConnected={setWallet} onDisconnect={() => setWallet(null)} />
          </section>

          <section className="card" aria-labelledby="c-what">
            <p className="card__kicker">What</p>
            <h2 id="c-what">Kind</h2>
            <div className="seg" role="group" aria-label="Mint kind">
              {(['counter', 'reinscription', 'fairminter'] as MintKind[]).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <p className="hint">
              {kind === 'counter' ? 'A new asset whose description is the file.' : kind === 'reinscription' ? 'A new file on an asset you own (quantity 0; supply untouched).' : 'A fairminter deploy whose description is the file: the deploy itself is the counter.'}
            </p>

            <div>
              <label htmlFor="asset">Asset name</label>
              {kind === 'reinscription' && owned?.length ? (
                <select id="asset" className="input" value={asset} onChange={(e) => setAsset(e.target.value)}>
                  <option value="">Choose one of your assets…</option>
                  {owned.map((o) => (
                    <option key={o.asset} value={o.asset} disabled={o.descriptionLocked}>
                      {o.asset}
                      {o.descriptionLocked ? ' (locked)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input id="asset" type="text" autoComplete="off" spellCheck={false} placeholder={kind === 'reinscription' ? 'YOURASSET' : 'empty = a free numeric name'} value={asset} onChange={(e) => setAsset(e.target.value.toUpperCase().replace(/^A(?=\d)/, 'A'))} />
              )}
              <p className="hint">Named (4–12 letters, not starting with A) burns 0.5 XCP. Numeric (A…) and PARENT.child subassets are free.</p>
            </div>

            <div>
              <span className="label">File</span>
              <label htmlFor="c-file" className="btn btn--small" style={{ display: 'inline-block' }}>
                Choose file
              </label>
              <input
                id="c-file"
                type="file"
                className="sr-only"
                aria-label="Choose the counter's file"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const bytes = new Uint8Array(await f.arrayBuffer());
                  setFile({ name: f.name, bytes });
                  setMimeType(guessContentType(bytes, f.name, f.type).split(';')[0]!);
                }}
              />
              {file ? (
                <div className="small mono" style={{ marginTop: 6 }}>
                  {file.name} · {fmtBytes(file.bytes.length)}
                </div>
              ) : null}
              {file ? (
                <div style={{ marginTop: 6 }}>
                  <label htmlFor="c-mime">MIME type (committed forever)</label>
                  <input id="c-mime" type="text" value={mimeType} onChange={(e) => setMimeType(e.target.value)} />
                </div>
              ) : null}
            </div>

            {kind === 'counter' ? (
              <div className="row">
                <div style={{ flex: '1 1 140px' }}>
                  <label htmlFor="supply">Supply</label>
                  <input id="supply" type="text" inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value)} />
                </div>
                <label className="opt">
                  <input type="checkbox" checked={divisible} onChange={(e) => setDivisible(e.target.checked)} /> divisible
                </label>
                <label className="opt">
                  <input type="checkbox" checked={lockQuantity} onChange={(e) => setLockQuantity(e.target.checked)} /> lock supply
                </label>
              </div>
            ) : null}

            {kind === 'fairminter' ? (
              <div className="stack">
                <div className="seg" role="group" aria-label="Fairminter preset">
                  <button type="button" aria-pressed={preset === 'xcp69'} onClick={() => setPreset('xcp69')}>
                    XCP-69
                  </button>
                  <button type="button" aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}>
                    Custom
                  </button>
                </div>
                {preset === 'xcp69' ? (
                  <p className="small">xcp.fun's template: 0.01 XCP per 1,000; 100M hard cap; 69M soft cap; 31M + the raised XCP open the pool at soft cap, LP burned; 1M per address; 1,000-block window; supply and description locked.{fairminter ? ` Starts at block ${fairminter.startBlock.toLocaleString('en-US')}.` : ' Waiting for the chain tip…'}</p>
                ) : (
                  <div className="row">
                    {(Object.keys(XCP69_FIELDS) as Array<keyof SaleFields>).map((k) => (
                      <div key={k} style={{ flex: '1 1 140px' }}>
                        <label htmlFor={`sale-${k}`}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</label>
                        <input id={`sale-${k}`} type="text" value={sale[k]} onChange={(e) => setSale((s) => ({ ...s, [k]: e.target.value }))} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            <label className="opt">
              <input type="checkbox" checked={ordWrapper} onChange={(e) => setOrdWrapper(e.target.checked)} /> Also wrap in an ord envelope (numbered by ord indexers too; +546 sats output back to you)
            </label>

            <FeePicker id="c-fee" fees={fees} value={feeRate} onChange={setFeeRate} />

            {fit !== 'public' && est ? (
              <Alert tone="warn" title={fit === 'too-large' ? 'Too big for any route' : 'Over the 400,000 WU relay cap'}>
                {fit === 'too-large' ? (
                  <p>No relay or miner accepts a reveal this heavy. Use a smaller file.</p>
                ) : (
                  <>
                    <p>The public network will not carry this reveal at any fee rate. Slipstream submits it straight to a miner once the commit confirms.</p>
                    <label className="opt">
                      <input type="checkbox" checked={route === 'slipstream'} onChange={(e) => setRoute(e.target.checked ? 'slipstream' : 'public')} /> Use the Slipstream route
                    </label>
                  </>
                )}
              </Alert>
            ) : null}
          </section>
        </div>

        <aside className="stack">
          <section className="card" aria-labelledby="c-checks">
            <p className="card__kicker">Before you sign</p>
            <h2 id="c-checks">Pre-flight</h2>
            <ul className="checks" aria-label="Pre-flight checks">
              {pf.checks.map((c) => (
                <li key={c.id} className={`check check--${c.status}`} data-check={c.id} data-status={c.status}>
                  <span className="check__icon" aria-hidden="true">
                    {c.status === 'ok' ? '✓' : c.status === 'fail' ? '✗' : c.status === 'warn' ? '!' : c.status === 'skip' ? '–' : '…'}
                  </span>
                  <span>
                    <strong>{c.label}</strong>
                    <span className="sr-only"> ({c.status})</span>: <span className="break">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            {costRows.length ? <CostTable caption="Cost of this counter" rows={costRows} /> : null}
            {est && est.xcpBurn > 0n ? <p className="small">Plus {fmtQty(est.xcpBurn, true)} XCP burned for the name.</p> : null}
            <button type="button" className="btn" disabled={!pf.ready || running || !!flow.pending || fit === 'too-large'} onClick={mint}>
              {kind === 'fairminter' ? 'Deploy fairminter' : kind === 'reinscription' ? 'Reinscribe' : 'Mint counter'}
            </button>
            {!pf.ready && pf.blocker ? <p className="hint">{pf.blocker}</p> : flow.pending ? <p className="hint">Finish or forget the pending mint first.</p> : null}
            {flow.trail.length ? (
              <ol className="checks" aria-label="Mint progress">
                {STAGE_ORDER.filter((s) => s !== 'idle').map((s) => (
                  <li key={s} className={`check check--${flow.trail.includes(s) ? (s === flow.stage && running ? 'pending' : 'ok') : 'skip'}`}>
                    <span className="check__icon" aria-hidden="true">
                      {flow.trail.includes(s) ? (s === flow.stage && running ? '…' : '✓') : '·'}
                    </span>
                    <span>{STAGE_LABEL[s]}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
          <Explainer
            title="How it works"
            steps={[
              'Counterparty composes the issuance (or fairminter) with encoding=taproot: your file becomes the asset description inside a tapscript envelope.',
              'The envelope is re-keyed to your wallet key, so the commit can only be opened by you, and the commit address is recomputed here.',
              'Your wallet signs the commit (XCP Wallet sees the envelope; Horizon signs it as a plain PSBT). We check the txid, save the pending reveal, and broadcast.',
              'Your wallet signs the reveal. It carries the CNTRPRTY marker that makes it a counter; the index numbers it when it confirms.',
              'Over 400,000 WU the public network will not relay the reveal; the Slipstream route sends it straight to a miner after the commit is mined.',
            ]}
          />
        </aside>
      </div>
    </div>
  );
}
