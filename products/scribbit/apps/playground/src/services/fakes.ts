/**
 * Fakes for every I/O port (tests and `?demo=1`), honest where it matters:
 *   - the fake faucet issues real challenges and VERIFIES the proof of work with the same kit as the service;
 *   - the fake chain keeps a UTXO set: a drip creates a coin, a broadcast must spend known coins and creates the
 *     transaction's outputs, so the funding PSBT, the txid check and the reveal all run against real bytes;
 *   - the fake wallets are the mint's (real keys, real signatures).
 * Nothing leaves the page.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { POW_ALGORITHM, POW_PREFIX, verifyPow } from '@bsh/scribbit-playground-kit';
import { createFakeWallets, type FakeWalletOptions } from '@bsh/scribbit-mint/src/services/fakes';
import { createRealInscription } from '@bsh/scribbit-mint/src/services/real/inscription';
import { BroadcastRejectedError, FaucetError, type Analytics, type ChainApi, type FaucetApi, type QuizEvent, type Services, type TxStatus, type Utxo } from './types';

const TX_OPTS = { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true, disableScriptCheck: true } as const;
const enc = new TextEncoder();

// ------------------------------------------------------------------ chain

export interface FakeChainState {
  utxos: Map<string, Utxo[]>;
  broadcasts: Map<string, string>;
  polls: Map<string, number>;
  confirmAfterPolls: number;
  feeRate: number;
  /** Refuse every broadcast with this node message (tests: "broadcast rejected"). */
  rejectBroadcast?: string | undefined;
  height: number;
}

export type FakeChain = ChainApi & { state: FakeChainState; credit(address: string, sats: number, txid?: string): string };

export function createFakeChain(over: Partial<FakeChainState> = {}): FakeChain {
  const state: FakeChainState = { utxos: new Map(), broadcasts: new Map(), polls: new Map(), confirmAfterPolls: 2, feeRate: 1, height: 250_000, ...over };
  const add = (address: string, u: Utxo) => state.utxos.set(address, [...(state.utxos.get(address) ?? []), u]);
  const outputAddress = (script: Uint8Array): string | null => {
    try {
      return btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(script));
    } catch {
      return null;
    }
  };
  return {
    state,
    credit(address, sats, txid) {
      const id = txid ?? hex.encode(sha256(enc.encode(`credit|${address}|${sats}|${state.broadcasts.size}|${state.utxos.size}`)));
      add(address, { txid: id, vout: 0, value: sats, status: { confirmed: false } });
      state.broadcasts.set(id, '');
      return id;
    },
    async getUtxos(address) {
      return [...(state.utxos.get(address) ?? [])];
    },
    async getTx(txid): Promise<TxStatus | null> {
      if (!state.broadcasts.has(txid)) return null;
      const n = (state.polls.get(txid) ?? 0) + 1;
      state.polls.set(txid, n);
      return n >= state.confirmAfterPolls ? { txid, confirmed: true, blockHeight: state.height + 1 } : { txid, confirmed: false };
    },
    async getFeeRate() {
      return state.feeRate;
    },
    async broadcast(raw) {
      if (state.rejectBroadcast) throw new BroadcastRejectedError(state.rejectBroadcast);
      const tx = btc.Transaction.fromRaw(hex.decode(raw), TX_OPTS);
      // Every input must spend a coin this chain knows and has not seen spent.
      const spent: Array<[string, Utxo]> = [];
      for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        const txid = hex.encode(inp.txid!);
        const hit = [...state.utxos].flatMap(([a, list]) => list.filter((u) => u.txid === txid && u.vout === inp.index).map((u) => [a, u] as [string, Utxo]))[0];
        if (!hit) throw new BroadcastRejectedError('bad-txns-inputs-missingorspent');
        spent.push(hit);
      }
      for (const [a, u] of spent) state.utxos.set(a, state.utxos.get(a)!.filter((x) => x !== u));
      const id = tx.id;
      for (let o = 0; o < tx.outputsLength; o++) {
        const out = tx.getOutput(o);
        const a = out.script ? outputAddress(out.script) : null;
        if (a) add(a, { txid: id, vout: o, value: Number(out.amount), status: { confirmed: false } });
      }
      state.broadcasts.set(id, raw);
      return id;
    },
  };
}

// ------------------------------------------------------------------ faucet

export interface FakeFaucetOptions {
  difficulty?: number;
  dripSats?: number;
  /** Simulate a refusal on drip: `faucet_empty`, `address_rate_limited`, `budget_exhausted`, `faucet_disabled`, … */
  refuse?: { code: string; message: string; retryAfterSeconds?: number } | undefined;
  /** Artificial latency, ms (demo pacing). */
  latencyMs?: number;
  configured?: boolean;
}

export type FakeFaucet = FaucetApi & { options: FakeFaucetOptions; drips: Array<{ address: string; txid: string }>; issued: Set<string> };

export function createFakeFaucet(chain: FakeChain, opts: FakeFaucetOptions = {}): FakeFaucet {
  const issued = new Set<string>();
  const drips: Array<{ address: string; txid: string }> = [];
  const wait = () => new Promise((r) => setTimeout(r, opts.latencyMs ?? 0));
  let n = 0;
  const f: FakeFaucet = {
    configured: opts.configured ?? true,
    options: opts,
    drips,
    issued,
    async challenge() {
      await wait();
      const nonce = hex.encode(sha256(enc.encode(`demo-challenge|${++n}|${Date.now()}`))).slice(0, 32);
      issued.add(nonce);
      const difficulty = opts.difficulty ?? 12;
      return { algorithm: POW_ALGORITHM, nonce, difficulty, expiresAt: new Date(Date.now() + 300_000).toISOString(), ttlSeconds: 300, message: `${POW_PREFIX}${nonce}:{address}:{solution}` };
    },
    async drip({ address, nonce, solution }) {
      await wait();
      if (opts.refuse) throw new FaucetError(opts.refuse.code, opts.refuse.message, opts.refuse.retryAfterSeconds ?? null);
      if (!address.toLowerCase().startsWith('tb1')) throw new FaucetError('mainnet_address_refused', 'This is not a signet address.');
      if (!issued.delete(nonce)) throw new FaucetError('challenge_used', 'This challenge was already used; fetch a new one');
      if (!verifyPow({ nonce, address: address.toLowerCase(), solution, difficulty: opts.difficulty ?? 12 })) throw new FaucetError('pow_invalid', 'The proof of work does not check out.');
      if (drips.some((d) => d.address === address)) throw new FaucetError('address_rate_limited', 'This address already received its drip today', 86_400);
      const txid = chain.credit(address, opts.dripSats ?? 50_000);
      drips.push({ address, txid });
      return { network: 'signet', address, amountSats: opts.dripSats ?? 50_000, txid };
    },
  };
  return f;
}

// ------------------------------------------------------------------ analytics

export type FakeAnalytics = Analytics & { sent: QuizEvent[] };

export function createFakeAnalytics(enabled = true): FakeAnalytics {
  const sent: QuizEvent[] = [];
  return { enabled, sent, send: async (e) => void sent.push(e) };
}

// ------------------------------------------------------------------ bundle

export interface FakeServicesOptions {
  chain?: Partial<FakeChainState>;
  faucet?: FakeFaucetOptions;
  wallet?: FakeWalletOptions;
  analytics?: boolean;
}

export interface FakeServices extends Services {
  chain: FakeChain;
  faucet: FakeFaucet;
  analytics: FakeAnalytics;
  wallets: ReturnType<typeof createFakeWallets>;
}

export function createFakeServices(o: FakeServicesOptions = {}): FakeServices {
  const chain = createFakeChain(o.chain);
  // Magic Eden and XCP Wallet are mainnet-only in wallet-kit: not offered as "installed" on signet in demo mode.
  const wallets = createFakeWallets([], { installed: ['unisat', 'xverse', 'leather', 'okx', 'horizon'], ...o.wallet });
  return { mode: 'demo', chain, faucet: createFakeFaucet(chain, o.faucet), analytics: createFakeAnalytics(o.analytics ?? true), wallets, inscription: createRealInscription() };
}
