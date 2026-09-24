/**
 * Fakes for every I/O port, used by the tests and by `?demo=1`. They are honest where it matters: the fake
 * wallet holds real keys and really signs PSBTs (key path and tapscript, tweaked or not, per its
 * capabilities), the fake chain derives txids from the bytes it is given, and the fake Counterparty node
 * composes a real commit/reveal pair around a real ephemeral key. So the txid check, the leaf-signature
 * verification and the re-keying all execute for real; only the network is missing.
 *
 * The maths ports (InscriptionOps, CountersKit) are NOT faked: demo mode runs @bsh/inscription and
 * @bsh/scribbit-counters exactly as the live app does.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { taprootTweakPrivKey } from '@scure/btc-signer/utils.js';
import type { Network } from '@bsh/inscription';
import type { AssetInfo, ChainApi, ComposeResult, CpClient, FeeSnapshot, OwnedAsset, Services, SignPsbtRequest, Utxo, WalletId, WalletOption, WalletService, WalletSession } from './types';
import { CAPABILITIES } from '@bsh/wallet-kit';
import { INSTALL_URLS, isUnverified, WALLET_NAMES } from '../lib/walletRouting';

/** The kit's own capability table: demo mode behaves like the real wallets are documented to. */
const KNOWN_CAPABILITIES = CAPABILITIES;
import { scureNetwork } from '../lib/funding';
import { createRealInscription } from './real/inscription';
import { createRealCountersKit } from './real/counters';

const enc = new TextEncoder();
const sha256Hex = (b: Uint8Array) => hex.encode(sha256(b));
const TX_OPTS = { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true } as const;

export type CallLog = string[];

const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------------------------------------------ wallet

export interface FakeWalletOptions {
  /** Which ids are "installed" in the demo page. Default: all seven. */
  installed?: WalletId[];
  /** Override capabilities per wallet (tests: e.g. `{ leather: { tapscript: false } }`). */
  capabilities?: Partial<Record<WalletId, Partial<WalletSession['capabilities']>>>;
  /** Make a signature come back for an altered transaction (tests the txid check). */
  tamper?: (tx: btc.Transaction) => void;
  /** Reject every signing request (tests the cancel path). */
  reject?: boolean;
}

function keyFor(id: WalletId, purpose: string, network: Network): Uint8Array {
  return sha256(enc.encode(`scribbit-demo|${id}|${purpose}|${network}`));
}

/** Deterministic accounts per wallet id: p2tr for ordinals; p2wpkh (or the same p2tr) for payments. */
export function demoAccounts(id: WalletId, network: Network) {
  const net = scureNetwork(network);
  const ordPriv = keyFor(id, 'ordinals', network);
  const ordInternal = schnorr.getPublicKey(ordPriv);
  const ord = btc.p2tr(ordInternal, undefined, net);
  const sameAccount = id === 'unisat' || id === 'okx' || id === 'xcp' || id === 'horizon';
  const payPriv = sameAccount ? ordPriv : keyFor(id, 'payment', network);
  const payPub = secp256k1.getPublicKey(payPriv, true);
  const pay = sameAccount ? ord : btc.p2wpkh(payPub, net);
  return {
    ordinals: { address: ord.address!, publicKey: hex.encode(ordInternal), addressType: 'p2tr' as const, priv: ordPriv, internalKey: ordInternal, script: ord.script },
    payment: { address: pay.address!, publicKey: sameAccount ? hex.encode(ordInternal) : hex.encode(payPub), addressType: sameAccount ? ('p2tr' as const) : ('p2wpkh' as const), priv: payPriv, script: pay.script },
    taprootOutputKey: hex.encode(ord.tweakedPubkey),
  };
}

export function createFakeWallets(log: CallLog = [], opts: FakeWalletOptions = {}): WalletService & { sessions: WalletSession[] } {
  const ids: WalletId[] = ['unisat', 'xverse', 'leather', 'okx', 'magiceden', 'xcp', 'horizon'];
  const installed = new Set(opts.installed ?? ids);
  const sessions: WalletSession[] = [];
  return {
    sessions,
    list(): WalletOption[] {
      return ids.map((id) => ({ id, name: WALLET_NAMES[id], installed: installed.has(id), installUrl: INSTALL_URLS[id], capabilities: { ...KNOWN_CAPABILITIES[id], ...(opts.capabilities?.[id] ?? {}) }, unverified: isUnverified(id, { ...KNOWN_CAPABILITIES[id], ...(opts.capabilities?.[id] ?? {}) }) }));
    },
    async connect(id, network) {
      log.push(`wallet.connect:${id}`);
      if (!installed.has(id)) throw Object.assign(new Error(`${WALLET_NAMES[id]} is not installed.`), { code: 'WALLET_NOT_INSTALLED' });
      const acc = demoAccounts(id, network);
      const capabilities = { ...KNOWN_CAPABILITIES[id], ...(opts.capabilities?.[id] ?? {}) };
      const session: WalletSession = {
        id,
        name: WALLET_NAMES[id],
        network,
        ordinals: { address: acc.ordinals.address, publicKey: acc.ordinals.publicKey, addressType: 'p2tr' },
        payment: { address: acc.payment.address, publicKey: acc.payment.publicKey, addressType: acc.payment.addressType },
        capabilities,
        taprootOutputKey: acc.taprootOutputKey,
        async signPsbt(psbtBase64: string, req: SignPsbtRequest) {
          log.push(`wallet.signPsbt:${id}${req.broadcast ? ':broadcast' : ''}${req.inscription ? ':inscription' : ''}`);
          if (opts.reject) throw Object.assign(new Error('User rejected the request'), { code: 'USER_REJECTED' });
          if (id === 'xcp' && !req.inscription) throw new Error('XCP Wallet refuses a commit without an inscription context (Not a Counterparty Transaction).');
          const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64), TX_OPTS);
          opts.tamper?.(tx);
          for (const i of req.inputsToSign) {
            const input = tx.getInput(i.index);
            const sighash = [btc.SigHash.DEFAULT, btc.SigHash.ALL];
            if (input.tapLeafScript?.length) {
              if (capabilities.tapscript === false) throw new Error(`${WALLET_NAMES[id]} cannot sign tapscript inputs.`);
              // Tweaked signer (the wallet's default for p2tr) unless the app asked to disable the tweak.
              const key = i.disableTweak ? acc.ordinals.priv : taprootTweakPrivKey(acc.ordinals.priv);
              if (!tx.signIdx(key, i.index, sighash)) throw new Error('leaf key mismatch: nothing signed');
            } else if (input.witnessUtxo && !input.tapInternalKey && bytesEq(input.witnessUtxo.script, acc.ordinals.script)) {
              // Counterparty composes carry no tapInternalKey; a real wallet knows its own key.
              tx.updateInput(i.index, { tapInternalKey: acc.ordinals.internalKey });
              tx.signIdx(acc.ordinals.priv, i.index, sighash);
            } else if (i.address === acc.payment.address) {
              tx.signIdx(acc.payment.priv, i.index, sighash);
            } else if (i.address === acc.ordinals.address) {
              tx.signIdx(acc.ordinals.priv, i.index, sighash);
            } else throw Object.assign(new Error(`address ${i.address} is not in this wallet`), { code: 'ADDRESS_NOT_IN_WALLET' });
          }
          if (req.finalize || req.broadcast) tx.finalize();
          const out: { psbtBase64: string; txid?: string } = { psbtBase64: base64.encode(tx.toPSBT()) };
          if (req.broadcast) {
            if (!capabilities.broadcast) throw new Error(`${WALLET_NAMES[id]} cannot broadcast.`);
            out.txid = await fakeBroadcastHook?.(hex.encode(tx.extract()));
          }
          return out;
        },
        ...(capabilities.broadcast ? { pushTx: async (h: string) => (log.push(`wallet.pushTx:${id}`), fakeBroadcastHook ? fakeBroadcastHook(h) : btc.Transaction.fromRaw(hex.decode(h), TX_OPTS).id) } : {}),
        async disconnect() {
          log.push(`wallet.disconnect:${id}`);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

/** Set by the fake chain so a wallet broadcast lands in the same fake mempool. */
let fakeBroadcastHook: ((hex: string) => Promise<string>) | null = null;

// ------------------------------------------------------------------ chain

export interface FakeChainState {
  utxos: Map<string, Utxo[]>;
  /** txid → raw hex, in broadcast order. */
  broadcasts: Map<string, string>;
  /** Broadcasts confirm after this many `getTx` polls (demo pacing). */
  confirmAfterPolls: number;
  polls: Map<string, number>;
  fees: FeeSnapshot;
  failBroadcast?: string | undefined;
}

export const DEMO_FEES: FeeSnapshot = { minFeeRate: 1, standard: { slow: 2, normal: 5, fast: 9 }, block: { min: 1.5, recommended: 6 }, fetchedAt: '2026-09-23T12:00:00.000Z', stale: false };

export function createFakeChain(log: CallLog = [], over: Partial<FakeChainState> = {}): ChainApi & { state: FakeChainState } {
  const state: FakeChainState = { utxos: new Map(), broadcasts: new Map(), confirmAfterPolls: 2, polls: new Map(), fees: DEMO_FEES, ...over };
  const accept = async (raw: string): Promise<string> => {
    const txid = btc.Transaction.fromRaw(hex.decode(raw), { ...TX_OPTS, disableScriptCheck: true }).id;
    if (state.failBroadcast) throw new Error(state.failBroadcast);
    state.broadcasts.set(txid, raw);
    return txid;
  };
  fakeBroadcastHook = accept;
  return {
    state,
    async getFees() {
      log.push('chain.getFees');
      return state.fees;
    },
    async getUtxos(address) {
      log.push('chain.getUtxos');
      const known = state.utxos.get(address);
      if (known) return known;
      // Every demo wallet is comfortably funded with two confirmed coins.
      const list: Utxo[] = [0, 1].map((i) => ({ txid: sha256Hex(enc.encode(`utxo|${address}|${i}`)), vout: i, value: i === 0 ? 2_500_000 : 800_000, status: { confirmed: true, block_height: 900_000 + i } }));
      state.utxos.set(address, list);
      return list;
    },
    async getTx(txid) {
      log.push('chain.getTx');
      if (!state.broadcasts.has(txid)) return null;
      const n = (state.polls.get(txid) ?? 0) + 1;
      state.polls.set(txid, n);
      return n >= state.confirmAfterPolls ? { txid, confirmed: true, blockHeight: 900_100 } : { txid, confirmed: false };
    },
    async broadcast(raw) {
      log.push('chain.broadcast');
      return accept(raw);
    },
    async getInscriptionContent(id) {
      log.push('chain.getInscriptionContent');
      const raw = state.broadcasts.get(id.replace(/i\d+$/, ''));
      if (!raw) return null;
      const n = (state.polls.get(`content:${id}`) ?? 0) + 1;
      state.polls.set(`content:${id}`, n);
      if (n < state.confirmAfterPolls) return null; // "not indexed yet" for the first poll
      return extractInscriptionBody(raw);
    },
  };
}

/** Read the inscription body back out of a raw reveal (ord envelope in input 0's tapscript). Honest verification for demo mode. */
export function extractInscriptionBody(rawHex: string): Uint8Array | null {
  const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { ...TX_OPTS, disableScriptCheck: true });
  const w = tx.getInput(0).finalScriptWitness;
  if (!w || w.length < 3) return null;
  const ops = btc.Script.decode(w[w.length - 2]!);
  const ord = ops.findIndex((o) => o instanceof Uint8Array && new TextDecoder().decode(o) === 'ord');
  if (ord < 0) return null;
  let i = ord + 1;
  while (i < ops.length && ops[i] !== 0 && ops[i] !== 'ENDIF') i += 2; // tag/value pairs until the body tag (OP_0)
  if (ops[i] !== 0) return new Uint8Array();
  const parts: Uint8Array[] = [];
  for (i += 1; i < ops.length && ops[i] !== 'ENDIF'; i++) if (ops[i] instanceof Uint8Array) parts.push(ops[i] as Uint8Array);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) (out.set(p, off), (off += p.length));
  return out;
}

// ------------------------------------------------------------------ counterparty node

export interface FakeCpState {
  assets: Map<string, AssetInfo>;
  xcpBalance: bigint;
  tip: number;
  utxos: Map<string, Utxo[]>;
  /** Default 'text/plain'; the compose echoes the description it received. */
  composes: ComposeResult[];
  broadcasts: string[];
}

function chunks(b: Uint8Array, n = 520): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n));
  return out;
}

/** A Core-style taproot envelope leaf: OP_FALSE OP_IF <CNTRPRTY + message> OP_ENDIF <key> OP_CHECKSIG. */
export function fakeCoreEnvelope(message: Uint8Array, leafKey: Uint8Array): Uint8Array {
  const data = new Uint8Array([...enc.encode('CNTRPRTY'), ...message]);
  return btc.Script.encode([0, 'IF', ...chunks(data), 'ENDIF', leafKey, 'CHECKSIG']);
}

export function createFakeCp(log: CallLog = [], chain: ReturnType<typeof createFakeChain>, network: Network, over: Partial<FakeCpState> = {}): CpClient & { state: FakeCpState } {
  const state: FakeCpState = { assets: new Map(), xcpBalance: 125_000_000n, tip: 912_345, utxos: chain.state.utxos, composes: [], broadcasts: [], ...over };
  const net = scureNetwork(network);
  const seed = (name: string, owner: string): AssetInfo => ({ asset: name, owner, divisible: false, locked: false, descriptionLocked: false, supply: 1n });
  // A famous name that belongs to somebody else, so "exists (not yours)" can be shown.
  state.assets.set('SCRIBBIT', seed('SCRIBBIT', btc.p2wpkh(secp256k1.getPublicKey(sha256(enc.encode('somebody')), true), net).address!));
  return {
    state,
    async getAsset(name) {
      log.push('cp.getAsset');
      return state.assets.get(name) ?? null;
    },
    async getBalance(_address, asset) {
      log.push('cp.getBalance');
      return asset === 'XCP' ? state.xcpBalance : 0n;
    },
    async getOwnedAssets(address) {
      log.push('cp.getOwnedAssets');
      const mine: OwnedAsset[] = [...state.assets.values()].filter((a) => a.owner === address).map((a) => ({ asset: a.asset, divisible: a.divisible, descriptionLocked: a.descriptionLocked, mimeType: 'image/png' }));
      return mine;
    },
    async getTip() {
      log.push('cp.getTip');
      return state.tip;
    },
    async compose(address, type, params) {
      log.push(`cp.compose:${type}`);
      const rate = Number(params.sat_per_vbyte ?? '1');
      const description = params.description ?? '';
      const asset = params.asset ?? 'A0';
      if (type === 'issuance' && state.assets.has(asset) && state.assets.get(asset)!.owner !== address) throw new Error(`Counterparty said 400: asset ${asset} is owned by another address`);
      // Core composes with a random key it then discards; the engine swaps it for the wallet's.
      const ephemeral = schnorr.utils.randomSecretKey();
      const ephemeralPub = schnorr.getPublicKey(ephemeral);
      const message = enc.encode(`${type}|${asset}|${params.mime_type ?? ''}|`);
      const body = enc.encode(description);
      const leaf = fakeCoreEnvelope(new Uint8Array([...message, ...body]), ephemeralPub);
      const commitP2tr = btc.p2tr(ephemeralPub, { script: leaf, leafVersion: 0xc0 }, net, true);
      // Reveal outputs: the CNTRPRTY marker (plus a 546-sat p2tr output for the ord wrapper).
      const ordWrapper = params.inscription === 'true';
      const revealOutputs = [{ script: btc.Script.encode(['RETURN', enc.encode('CNTRPRTY')]), amount: 0n }, ...(ordWrapper ? [{ script: btc.OutScript.encode(btc.Address(net).decode(address)), amount: 546n }] : [])];
      // Core signs its reveal with the discarded key (script path, 64-byte SIGHASH_DEFAULT signature); only the
      // outputs and the weight matter to the engine, so the signature bytes are a placeholder of the right size.
      const tapLeaf = commitP2tr.tapLeafScript![0]!;
      const controlBlock = btc.TaprootControlBlock.encode(tapLeaf[0]);
      const revealTx = (commitTxid: string, amount: bigint) => {
        const t = new btc.Transaction({ allowUnknownOutputs: true });
        for (const o of revealOutputs) t.addOutput(o);
        t.addInput({ txid: commitTxid, index: 0, witnessUtxo: { script: commitP2tr.script, amount }, finalScriptWitness: [new Uint8Array(64).fill(1), leaf, controlBlock] });
        return t;
      };
      const measure = revealTx('00'.repeat(32), 100_000n);
      const revealVsize = Math.ceil(measure.weight / 4);
      const outputsValue = revealOutputs.reduce((s, o) => s + Number(o.amount), 0);
      const commitValue = Math.max(Math.ceil(revealVsize * rate) + outputsValue, 330);
      // Commit: the source's coins pay the commit output and change back to the source.
      const utxos = await chain.getUtxos(address);
      const payScript = btc.OutScript.encode(btc.Address(net).decode(address));
      const inputs = utxos.filter((u) => u.value > 10_000).slice(0, 1);
      const inValue = inputs.reduce((s, u) => s + u.value, 0);
      const commitVsize = 155;
      const fee = Math.ceil(commitVsize * rate);
      const change = inValue - commitValue - fee;
      if (change < 546) throw new Error('Counterparty said 400: Insufficient BTC at address');
      const commit = new btc.Transaction({ allowUnknownOutputs: true });
      for (const u of inputs) commit.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: payScript, amount: BigInt(u.value) } });
      commit.addOutput({ script: commitP2tr.script, amount: BigInt(commitValue) });
      commit.addOutput({ script: payScript, amount: BigInt(change) });
      const commitRaw = commit.unsignedTx;
      // Core's own signed reveal (its witness is useless to us; its outputs and weight are what we read).
      const reveal = revealTx(commit.id, BigInt(commitValue));
      const result: ComposeResult = {
        rawtransaction: hex.encode(commitRaw),
        envelope_script: hex.encode(leaf),
        signed_reveal_rawtransaction: hex.encode(reveal.toBytes(true, true)),
        btc_fee: fee,
        btc_change: change,
        btc_in: inValue,
        btc_out: commitValue,
        inputs_values: inputs.map((u) => u.value),
        lock_scripts: inputs.map(() => hex.encode(payScript)),
        signed_tx_estimated_size: { vsize: commitVsize, adjusted_vsize: commitVsize, sigops_count: 0 },
        params: { ...params, description: `[${body.length} bytes]` },
      };
      state.composes.push(result);
      if (type === 'issuance' && !state.assets.has(asset)) state.assets.set(asset, seed(asset, address));
      if (type === 'fairminter') state.assets.set(asset, seed(asset, address));
      return result;
    },
    async broadcast(h) {
      log.push('cp.broadcast');
      state.broadcasts.push(h);
      return chain.broadcast(h);
    },
    async knowsTx(txid) {
      log.push('cp.knowsTx');
      return chain.state.broadcasts.has(txid);
    },
  };
}

// ------------------------------------------------------------------ bundle

export interface FakeServicesOptions {
  network?: Network;
  log?: CallLog;
  wallet?: FakeWalletOptions;
  chain?: Partial<FakeChainState>;
  cp?: Partial<FakeCpState>;
}

export interface FakeServices extends Services {
  log: CallLog;
  chain: ReturnType<typeof createFakeChain>;
  cp: ReturnType<typeof createFakeCp>;
  wallets: ReturnType<typeof createFakeWallets>;
}

export function createFakeServices(o: FakeServicesOptions = {}): FakeServices {
  const log = o.log ?? [];
  const network = o.network ?? 'signet';
  const chain = createFakeChain(log, o.chain);
  const wallets = createFakeWallets(log, o.wallet);
  const cp = createFakeCp(log, chain, network, o.cp);
  return { mode: 'demo', log, wallets, chain, cp, inscription: createRealInscription(), counters: createRealCountersKit() };
}
