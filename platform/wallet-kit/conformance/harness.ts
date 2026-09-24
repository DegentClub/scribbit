/**
 * Conformance harness: loads @bsh/wallet-kit in a REAL browser page and drives one adapter through the
 * steps a product needs (detect → connect → addresses → signMessage → signPsbt → pushTx dry-run →
 * disconnect), rendering a results table and exposing everything on `window.__walletKitHarness` so
 * Playwright (fake providers) and a human (real extensions, see MANUAL-MATRIX.md) run the same code.
 *
 * Bundled by `conformance/build.ts` (esbuild, IIFE) into `conformance/dist/harness.js`.
 */
import {
  ADAPTERS,
  createWalletKit,
  addressMatchesNetwork,
  detectAddressNetwork,
  isWalletError,
  type ConnectedWallet,
  type MessageSignatureType,
  type Network,
  type WalletId,
  type WalletKit,
} from '../src/index.js';
import { FIXTURES, SIGN_MESSAGE } from './fixtures.js';

export type StepName = 'detect' | 'connect' | 'addresses' | 'signMessage' | 'signPsbt' | 'pushTx' | 'disconnect';
export type StepStatus = 'pass' | 'fail' | 'skip';

export interface StepResult {
  wallet: WalletId;
  step: StepName;
  status: StepStatus;
  detail: string;
  ms: number;
  /** Stable error code when the step failed with a WalletError. */
  code?: string;
}

export interface RunOptions {
  network?: Network;
  /** Override the fixture PSBT (base64). Real extensions need a PSBT that spends THEIR payment address. */
  psbtBase64?: string;
  /** Override the fixture raw transaction (hex) for the pushTx step. */
  rawTxHex?: string;
  /** Actually call `pushTx`. Default false: the step only reports the capability (dry run). */
  pushTx?: boolean;
  signMessageType?: MessageSignatureType;
  /** Sighash types requested for the PSBT input (default [0x81]). */
  sighashTypes?: number[];
  /** Stop after the first failing step (default true: later steps depend on connect). */
  stopOnFail?: boolean;
}

export interface HarnessEvent {
  at: number;
  event: string;
  payload: unknown;
}

export interface WalletKitHarness {
  readonly version: string;
  readonly wallets: readonly WalletId[];
  readonly results: StepResult[];
  readonly events: HarnessEvent[];
  readonly kit: WalletKit | null;
  run(wallet: WalletId, opts?: RunOptions): Promise<StepResult[]>;
  runAll(opts?: RunOptions): Promise<StepResult[]>;
  /** Wallets `detect()` reports as installed right now. */
  detect(): WalletId[];
  clear(): void;
}

const HARNESS_VERSION = '1';
const DEFAULT_NETWORK: Network = 'signet';

function describeError(e: unknown): { detail: string; code?: string } {
  if (isWalletError(e)) return { detail: `${e.code}: ${e.message}`, code: e.code };
  if (e instanceof Error) return { detail: `${e.name}: ${e.message}` };
  return { detail: String(e) };
}

function fixtureFor(network: Network) {
  return network === 'mainnet' ? FIXTURES.mainnet : FIXTURES.signet;
}

export function createHarness(root: Document | null): WalletKitHarness {
  const results: StepResult[] = [];
  const events: HarnessEvent[] = [];
  let kit: WalletKit | null = null;

  const render = () => {
    const tbody = root?.querySelector<HTMLElement>('#results tbody');
    if (!tbody) return;
    tbody.replaceChildren(
      ...results.map((r) => {
        const tr = root!.createElement('tr');
        tr.dataset.wallet = r.wallet;
        tr.dataset.step = r.step;
        tr.dataset.status = r.status;
        for (const cell of [r.wallet, r.step, r.status, r.detail, `${r.ms}`]) {
          const td = root!.createElement('td');
          td.textContent = cell;
          tr.appendChild(td);
        }
        return tr;
      }),
    );
    const summary = root?.querySelector<HTMLElement>('#summary');
    if (summary) {
      const pass = results.filter((r) => r.status === 'pass').length;
      const fail = results.filter((r) => r.status === 'fail').length;
      summary.textContent = `${pass} passed, ${fail} failed, ${results.length - pass - fail} skipped`;
    }
  };

  async function step<T>(wallet: WalletId, name: StepName, fn: () => Promise<{ detail: string; value?: T; skip?: boolean }>): Promise<T | undefined> {
    const t0 = performance.now();
    try {
      const out = await fn();
      results.push({ wallet, step: name, status: out.skip ? 'skip' : 'pass', detail: out.detail, ms: Math.round(performance.now() - t0) });
      render();
      return out.value;
    } catch (e) {
      const { detail, code } = describeError(e);
      results.push({ wallet, step: name, status: 'fail', detail, ms: Math.round(performance.now() - t0), ...(code ? { code } : {}) });
      render();
      throw e;
    }
  }

  async function run(wallet: WalletId, opts: RunOptions = {}): Promise<StepResult[]> {
    const network = opts.network ?? DEFAULT_NETWORK;
    const fixture = fixtureFor(network);
    const psbt = opts.psbtBase64 ?? fixture.psbtBase64;
    const rawTx = opts.rawTxHex ?? fixture.rawTxHex;
    const stopOnFail = opts.stopOnFail ?? true;
    const before = results.length;

    kit = createWalletKit({ network });
    for (const ev of ['connect', 'disconnect', 'accountsChanged', 'error'] as const) {
      kit.on(ev, (payload) => events.push({ at: Date.now(), event: ev, payload: ev === 'connect' ? (payload as ConnectedWallet).id : payload }));
    }

    try {
      await step(wallet, 'detect', async () => {
        const adapter = ADAPTERS.find((a) => a.id === wallet);
        if (!adapter) throw new Error(`unknown wallet ${wallet}`);
        const installed = kit!.detect().map((a) => a.id);
        if (!installed.includes(wallet)) throw new Error(`${adapter.name} is not injected in this page (detect() → ${installed.join(', ') || 'none'})`);
        return { detail: `installed; networks ${adapter.networks.join(',')}` };
      });

      const w = await step<ConnectedWallet>(wallet, 'connect', async () => {
        const c = await kit!.connect(wallet);
        return { detail: `connected on ${c.network}`, value: c };
      });
      if (!w) return results.slice(before);

      await step(wallet, 'addresses', async () => {
        const checks: string[] = [];
        for (const acct of [w.ordinals, w.payment]) {
          if (!addressMatchesNetwork(acct.address, network))
            throw new Error(`${acct.purpose} address ${acct.address} is ${detectAddressNetwork(acct.address) ?? 'unrecognised'}, expected ${network}`);
          if (!/^[0-9a-f]{64,66}$/i.test(acct.publicKey)) throw new Error(`${acct.purpose} publicKey is not 32/33-byte hex: "${acct.publicKey}"`);
          checks.push(`${acct.purpose}=${acct.addressType}`);
        }
        if (kit!.current?.id !== wallet) throw new Error('kit.current is not the connected wallet');
        return { detail: checks.join(' ') };
      });

      await step(wallet, 'signMessage', async () => {
        const sig = await w.signMessage(SIGN_MESSAGE, w.payment.address, opts.signMessageType ?? 'bip322-simple');
        if (typeof sig !== 'string' || sig.length < 8) throw new Error(`signature looks wrong: "${String(sig)}"`);
        return { detail: `${opts.signMessageType ?? 'bip322-simple'} signature ${sig.length} chars` };
      });

      await step(wallet, 'signPsbt', async () => {
        const res = await w.signPsbt(psbt, { inputsToSign: [{ index: 0, address: w.payment.address, sighashTypes: opts.sighashTypes ?? [0x81] }] });
        if (!res.psbtBase64.startsWith('cHNidP')) throw new Error('returned PSBT has no magic');
        return { detail: `signed PSBT ${res.psbtBase64.length} chars${res.txid ? `, txid ${res.txid}` : ''}` };
      });

      await step(wallet, 'pushTx', async () => {
        if (typeof w.pushTx !== 'function') return { detail: 'no pushTx capability (broadcast via signPsbt { broadcast: true })', skip: true };
        if (!opts.pushTx) return { detail: 'capability present; dry run (pass pushTx: true to broadcast)', skip: true };
        const txid = await w.pushTx(rawTx);
        return { detail: `broadcast txid ${txid}` };
      });

      await step(wallet, 'disconnect', async () => {
        await kit!.disconnect();
        if (kit!.current !== null) throw new Error('kit.current still set after disconnect');
        const last = events.filter((e) => e.event === 'disconnect').at(-1);
        return { detail: `disconnected (${JSON.stringify(last?.payload)})` };
      });
    } catch (e) {
      if (!stopOnFail) throw e;
      // The failing step already recorded itself; mark the rest as skipped for a complete table.
      const done = new Set(results.slice(before).map((r) => r.step));
      for (const s of ['detect', 'connect', 'addresses', 'signMessage', 'signPsbt', 'pushTx', 'disconnect'] as StepName[]) {
        if (!done.has(s)) results.push({ wallet, step: s, status: 'skip', detail: 'skipped after failure', ms: 0 });
      }
      render();
    }
    return results.slice(before);
  }

  return {
    version: HARNESS_VERSION,
    wallets: ADAPTERS.map((a) => a.id),
    results,
    events,
    get kit() {
      return kit;
    },
    run,
    async runAll(opts) {
      const out: StepResult[] = [];
      for (const w of createWalletKit({ network: opts?.network ?? DEFAULT_NETWORK }).detect()) out.push(...(await run(w.id, opts)));
      return out;
    },
    detect: () => createWalletKit({ network: DEFAULT_NETWORK }).detect().map((a) => a.id),
    clear() {
      results.length = 0;
      events.length = 0;
      render();
    },
  };
}

declare global {
  interface Window {
    __walletKitHarness: WalletKitHarness;
  }
}

// Browser entry: install the harness, wire the buttons, honour `?wallet=&network=&auto=1`.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const harness = createHarness(document);
  window.__walletKitHarness = harness;
  const q = new URLSearchParams(location.search);
  const network = (q.get('network') as Network | null) ?? DEFAULT_NETWORK;
  const optsFromPage = (): RunOptions => {
    const psbt = document.querySelector<HTMLTextAreaElement>('#psbt')?.value.trim();
    const pushTx = document.querySelector<HTMLInputElement>('#pushTx')?.checked ?? false;
    const net = (document.querySelector<HTMLSelectElement>('#network')?.value as Network | undefined) ?? network;
    return { network: net, ...(psbt ? { psbtBase64: psbt } : {}), pushTx };
  };
  const ready = () => {
    const sel = document.querySelector<HTMLSelectElement>('#network');
    if (sel) sel.value = network;
    const buttons = document.querySelector<HTMLElement>('#wallets');
    if (buttons) {
      for (const id of harness.wallets) {
        const b = document.createElement('button');
        b.textContent = id;
        b.dataset.wallet = id;
        b.addEventListener('click', () => void harness.run(id, optsFromPage()));
        buttons.appendChild(b);
      }
      const all = document.createElement('button');
      all.textContent = 'run all detected';
      all.id = 'run-all';
      all.addEventListener('click', () => void harness.runAll(optsFromPage()));
      buttons.appendChild(all);
    }
    const detected = document.querySelector<HTMLElement>('#detected');
    const refresh = () => {
      if (detected) detected.textContent = harness.detect().join(', ') || 'none (extensions inject late; click refresh)';
    };
    refresh();
    document.querySelector('#refresh')?.addEventListener('click', refresh);
    const auto = q.get('wallet') as WalletId | null;
    if (q.get('auto') === '1') void (auto ? harness.run(auto, { network }) : harness.runAll({ network }));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
}
