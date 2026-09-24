import { useState, type ReactNode } from 'react';
import type { FeeSnapshot } from '../services/types';
import { fmtBtc, fmtRate, fmtSats } from '../lib/format';
import { parseFeeRate } from '../lib/format';

export function Alert({ tone, title, children }: { tone: 'bad' | 'warn' | 'good' | 'info'; title: string; children?: ReactNode }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <p className="alert__title">{title}</p>
      {children ? <div className="alert__body">{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ error, onDismiss }: { error: { message: string; hint: string } | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <Alert tone="bad" title="That did not work">
      <p className="break">{error.message}</p>
      <p>
        <strong>What to do:</strong> {error.hint}
      </p>
      {onDismiss ? (
        <button type="button" className="btn btn--ghost btn--small" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </Alert>
  );
}

export interface CostRow {
  label: string;
  sats: bigint | number;
  note?: string;
}

/** The honest cost table: every line in sats and BTC, a total, nothing hidden. */
export function CostTable({ rows, caption }: { rows: CostRow[]; caption: string }) {
  const total = rows.reduce((s, r) => s + BigInt(r.sats), 0n);
  return (
    <table className="costs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col" className="num">
            sats
          </th>
          <th scope="col" className="num">
            BTC
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row" style={{ fontWeight: 400 }}>
              {r.label}
              {r.note ? <div className="hint">{r.note}</div> : null}
            </th>
            <td className="num">{BigInt(r.sats).toLocaleString('en-US')}</td>
            <td className="num">{fmtBtc(r.sats).replace(' BTC', '')}</td>
          </tr>
        ))}
        <tr className="total">
          <th scope="row">Total you pay</th>
          <td className="num" data-testid="total-sats">
            {total.toLocaleString('en-US')}
          </td>
          <td className="num">{fmtBtc(total).replace(' BTC', '')}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** Fee picker: the oracle's tiers plus a custom rate. `block` adds the block-lane recommendation. */
export function FeePicker({ fees, value, onChange, block = false, id = 'fee' }: { fees: FeeSnapshot | null; value: number | null; onChange: (rate: number | null) => void; block?: boolean; id?: string }) {
  const tiers: Array<[string, number]> = fees ? [['slow', fees.standard.slow], ['normal', fees.standard.normal], ['fast', fees.standard.fast], ...(block ? [['block lane', fees.block.recommended] as [string, number]] : [])] : [];
  const [custom, setCustom] = useState('');
  const isTier = tiers.some(([, r]) => r === value);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="label" id={`${id}-label`}>
        Fee rate
      </span>
      <div className="seg" role="group" aria-labelledby={`${id}-label`}>
        {tiers.map(([name, rate]) => (
          <button key={name} type="button" aria-pressed={value === rate} onClick={() => onChange(rate)}>
            {name} · {rate}
          </button>
        ))}
      </div>
      <div className="row">
        <label htmlFor={`${id}-custom`} className="sr-only">
          Custom fee rate (sat/vB)
        </label>
        <input id={`${id}-custom`} type="text" inputMode="decimal" placeholder="custom sat/vB" style={{ maxWidth: 160 }} value={isTier ? custom : custom || (value?.toString() ?? '')} onChange={(e) => {
          setCustom(e.target.value);
          onChange(parseFeeRate(e.target.value));
        }} />
        <span className="small muted">{value ? `using ${fmtRate(value)}` : 'enter a rate'}</span>
      </div>
      {fees === null ? <p className="hint">Live fees are unavailable right now: type a rate (check mempool.space if unsure).</p> : fees.stale ? <p className="hint">Fees are stale (sources failing): double-check the rate.</p> : fees.minFeeRate && value !== null && value < fees.minFeeRate ? <p className="field-error">Below the network minimum of {fmtRate(fees.minFeeRate)}: it would not relay.</p> : null}
    </div>
  );
}

export function Kv({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Explainer({ title, steps }: { title: string; steps: ReactNode[] }) {
  return (
    <details className="card card--quiet explainer">
      <summary>{title}</summary>
      <ol style={{ marginTop: 12 }}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

export const sats = fmtSats;
