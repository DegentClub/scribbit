import { useState } from 'react';
import { sha256Hex } from '@bsh/inscription';
import { stepContent } from '@bsh/scribbit-playground-kit';
import { CostTable, ErrorBox, Kv } from '@bsh/scribbit-mint/src/components/ui';
import { describeError } from '@bsh/scribbit-mint/src/lib/errors';
import { fmtBytes, fmtRate, fmtWeight, shortHex } from '@bsh/scribbit-mint/src/lib/format';
import { guessContentType } from '@bsh/scribbit-mint/src/lib/mime';
import type { PlaygroundConfig } from '../config';
import type { PlaygroundWallet, Services } from '../services/types';
import { POSTAGE, quoteFile, type PickedFile, type Plan } from '../lib/flow';
import { ExplainPanel, OnChainCard, StepHeading } from '../components/parts';

const STEP = stepContent('file');
const enc = (s: string) => Uint8Array.from(new TextEncoder().encode(s));

export const SAMPLES: ReadonlyArray<{ id: string; name: string; contentType: string; body: string; label: string }> = [
  { id: 'hello', name: 'hello.txt', contentType: 'text/plain;charset=utf-8', body: 'Hello from the scribb.it Signet Playground. My first inscription, on a test network.', label: 'A line of text' },
  {
    id: 'badge',
    name: 'badge.svg',
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#1d1a16"/><path d="M16 44 L40 20 M16 44 h14" stroke="#f5efe4" stroke-width="5" stroke-linecap="round"/><circle cx="46" cy="46" r="5" fill="#f7931a"/></svg>',
    label: 'A tiny SVG badge',
  },
];

export function pickSample(id: string): PickedFile {
  const s = SAMPLES.find((x) => x.id === id)!;
  const bytes = enc(s.body);
  return { name: s.name, bytes, contentType: s.contentType, sha256: sha256Hex(bytes), sample: true };
}

export function FileStep({ services, config, wallet, onPlanned }: { services: Services; config: PlaygroundConfig; wallet: PlaygroundWallet; onPlanned: (p: Plan) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const quote = async (file: PickedFile) => {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const feeRate = await services.chain.getFeeRate();
      setPlan(await quoteFile(services, { wallet, file, feeRate }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > config.maxFileBytes) {
      setPlan(null);
      setError({ message: `${f.name} is ${fmtBytes(f.size)}; the playground takes files up to ${fmtBytes(config.maxFileBytes)}.`, hint: 'Pick a smaller file or one of the samples. Bigger inscriptions work the same way on the real mint.' });
      return;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    await quote({ name: f.name, bytes, contentType: guessContentType(bytes, f.name, f.type), sha256: sha256Hex(bytes), sample: false });
  };

  return (
    <div className="step-grid">
      <div className="stack">
        <StepHeading step={STEP} focus />
        <section className="card" aria-labelledby="file-h">
          <h2 id="file-h">Choose what to write</h2>
          <div className="row" role="group" aria-label="Samples">
            {SAMPLES.map((s) => (
              <button key={s.id} type="button" className="btn btn--ghost" disabled={busy} onClick={() => quote(pickSample(s.id))}>
                {s.label}
              </button>
            ))}
          </div>
          <div>
            <label htmlFor="pg-file">…or your own file (up to {fmtBytes(config.maxFileBytes)})</label>
            <input id="pg-file" type="file" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          <ErrorBox error={error} onDismiss={() => setError(null)} />
          {busy ? <p className="small" aria-live="polite">Computing the exact quote…</p> : null}
          {plan ? <QuoteView plan={plan} /> : null}
          <div>
            <button type="button" className="btn" disabled={!plan || busy} onClick={() => plan && onPlanned(plan)}>
              Continue: commit and reveal
            </button>
          </div>
        </section>
        <OnChainCard step={STEP} />
      </div>
      <ExplainPanel step={STEP} />
    </div>
  );
}

export function QuoteView({ plan }: { plan: Plan }) {
  const q = plan.quote;
  return (
    <div className="stack" data-testid="quote">
      <Kv
        items={[
          ['File', `${plan.file.name} · ${fmtBytes(plan.file.bytes.length)}`],
          ['Content type', plan.file.contentType],
          ['SHA-256', <span key="h" title={plan.file.sha256}>{shortHex(plan.file.sha256, 12)}</span>],
          ['Reveal weight', fmtWeight(q.weight)],
          ['Reveal vsize', `${q.vsize.toLocaleString('en-US')} vB`],
          ['Lane', q.lane === 'standard' ? 'standard (≤ 400,000 WU: any node relays it)' : String(q.lane)],
          ['Fee rate', fmtRate(plan.feeRate)],
        ]}
      />
      <CostTable
        caption="What this inscription costs in signet sats"
        rows={[
          { label: 'Reveal fee', sats: q.revealFee, note: `${q.vsize.toLocaleString('en-US')} vB × ${fmtRate(plan.feeRate)}` },
          { label: 'Postage', sats: POSTAGE, note: 'Stays with your inscription, at your address' },
          { label: 'Commit fee', sats: plan.funding.selection.fee, note: `${plan.funding.selection.vsize} vB funding transaction` },
        ]}
      />
      <p className="hint">Signet sats, which have no value. The weight is exact: the tests compare it with the signed transaction.</p>
    </div>
  );
}
