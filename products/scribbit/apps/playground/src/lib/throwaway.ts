/**
 * The in-browser throwaway SIGNET key (ADR-0009). Generated with @noble/curves, kept in sessionStorage only (gone
 * when the tab closes), never sent anywhere. One Taproot key-path address pays and receives; the inscription leaf
 * names the untweaked internal key, and the page signs locally with @scure/btc-signer.
 *
 * Guard rails: the key is only ever turned into SIGNET (tb1p) addresses; loading refuses any stored record that
 * is not tagged signet; the export is a testnet-version WIF, which mainnet software rejects.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { PlaygroundWallet, SignPsbtRequest } from '../services/types';

export const THROWAWAY_KEY = 'scribb.it/playground/throwaway-key/v1';
const TX_OPTS = { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true } as const;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function sessionStore(): KeyValueStore | null {
  try {
    const s = globalThis.sessionStorage;
    const probe = '__scribbit_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export interface ThrowawayRecord {
  network: 'signet';
  privHex: string;
  createdAt: number;
}

export function generateThrowaway(random: () => Uint8Array = () => schnorr.utils.randomSecretKey()): ThrowawayRecord {
  return { network: 'signet', privHex: hex.encode(random()), createdAt: Date.now() };
}

export function saveThrowaway(store: KeyValueStore | null, r: ThrowawayRecord): void {
  store?.setItem(THROWAWAY_KEY, JSON.stringify(r));
}

export function loadThrowaway(store: KeyValueStore | null): ThrowawayRecord | null {
  try {
    const raw = store?.getItem(THROWAWAY_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<ThrowawayRecord>;
    if (r.network !== 'signet' || typeof r.privHex !== 'string' || !/^[0-9a-f]{64}$/.test(r.privHex)) return null;
    return { network: 'signet', privHex: r.privHex, createdAt: Number(r.createdAt) || 0 };
  } catch {
    return null;
  }
}

export function forgetThrowaway(store: KeyValueStore | null): void {
  store?.removeItem(THROWAWAY_KEY);
}

export interface ThrowawayKeys {
  priv: Uint8Array;
  /** 32-byte x-only internal key (the leaf key). */
  internal: Uint8Array;
  address: string;
  outputKeyHex: string;
}

export function deriveKeys(r: ThrowawayRecord): ThrowawayKeys {
  const priv = hex.decode(r.privHex);
  const internal = schnorr.getPublicKey(priv);
  const p = btc.p2tr(internal, undefined, btc.TEST_NETWORK);
  if (!p.address!.startsWith('tb1p')) throw new Error('throwaway key produced a non-signet address (bug)');
  return { priv, internal, address: p.address!, outputKeyHex: hex.encode(p.tweakedPubkey) };
}

/** Backup formats: a testnet WIF and a `tr()` descriptor for Bitcoin Core's `importdescriptors` on signet. */
export function exportBackup(r: ThrowawayRecord): { wif: string; descriptor: string } {
  const wif = btc.WIF(btc.TEST_NETWORK).encode(hex.decode(r.privHex));
  return { wif, descriptor: `tr(${wif})` };
}

/** Sign the requested inputs locally: tapscript inputs with the raw key (leaf names the internal key), key-path with the tweaked key. */
export function signLocally(keys: ThrowawayKeys, psbtBase64: string, req: SignPsbtRequest): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64), TX_OPTS);
  for (const i of req.inputsToSign) {
    if (i.address !== keys.address) throw Object.assign(new Error(`address ${i.address} is not the throwaway key's`), { code: 'ADDRESS_NOT_IN_WALLET' });
    const input = tx.getInput(i.index);
    const ok = input.tapLeafScript?.length ? tx.signIdx(keys.priv, i.index, [btc.SigHash.DEFAULT]) : tx.signIdx(keys.priv, i.index);
    if (!ok) throw new Error(`input ${i.index} could not be signed with the throwaway key`);
  }
  if (req.finalize) tx.finalize();
  return base64.encode(tx.toPSBT());
}

export function throwawayWallet(r: ThrowawayRecord): PlaygroundWallet & { keys: ThrowawayKeys } {
  const keys = deriveKeys(r);
  const account = { address: keys.address, publicKey: hex.encode(keys.internal), addressType: 'p2tr' as const };
  return {
    kind: 'throwaway',
    name: 'Throwaway test key',
    keys,
    ordinals: account,
    payment: account,
    plan: { leafPubkey: keys.internal, leafKeyKind: 'internal', sighash: 'default', inputToSign: { index: 0, address: keys.address, disableTweak: true }, broadcastVia: 'esplora' },
    async signPsbt(psbtBase64, req) {
      return { psbtBase64: signLocally(keys, psbtBase64, req) };
    },
  };
}
