import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { solvePow, verifyPow } from '@bsh/scribbit-playground-kit';
import { createApp, createFakeWallet, type FaucetOptions } from '../src/index.js';

const key = (s: string) => sha256(new TextEncoder().encode(s));
const xonly = (s: string) => schnorr.getPublicKey(key(s));
const compressed = (s: string) => secp256k1.getPublicKey(key(s), true);
const REGTEST = { ...btc.TEST_NETWORK, bech32: 'bcrt' };

/** Valid addresses on every network, derived from fixed test keys (illustrative, never funded). */
export const ADDR = {
  signetTr: btc.p2tr(xonly('a'), undefined, btc.TEST_NETWORK).address!,
  signetTr2: btc.p2tr(xonly('b'), undefined, btc.TEST_NETWORK).address!,
  signetWpkh: btc.p2wpkh(compressed('c'), btc.TEST_NETWORK).address!,
  signetLegacy: btc.p2pkh(compressed('d'), btc.TEST_NETWORK).address!,
  mainnetTr: btc.p2tr(xonly('a'), undefined, btc.NETWORK).address!,
  mainnetWpkh: btc.p2wpkh(compressed('c'), btc.NETWORK).address!,
  mainnetLegacy: btc.p2pkh(compressed('d'), btc.NETWORK).address!,
  mainnetP2sh: btc.p2sh(btc.p2wpkh(compressed('e'), btc.NETWORK), btc.NETWORK).address!,
  regtestTr: btc.p2tr(xonly('a'), undefined, REGTEST).address!,
};

export const DIFFICULTY = 8;

export function makeFaucet(over: Partial<FaucetOptions> = {}) {
  let t = Date.UTC(2026, 8, 24, 12, 0, 0);
  const wallet = createFakeWallet({ balanceSats: 10_000_000 });
  let r = 0;
  const app = createApp({
    wallet,
    powDifficulty: DIFFICULTY,
    now: () => t,
    random: (n) => Uint8Array.from({ length: n }, (_, i) => (i + 7 * ++r) & 0xff),
    corsOrigins: ['https://scribb.it'],
    ...over,
  });
  return {
    app,
    wallet,
    advance: (ms: number) => void (t += ms),
    now: () => t,
  };
}

export type Faucet = ReturnType<typeof makeFaucet>;

export async function challenge(f: Faucet, ip = '192.0.2.10') {
  const res = await f.app.request('/v1/challenge', {}, peer(ip));
  return { res, body: (await res.json()) as { nonce: string; difficulty: number; expiresAt: string } };
}

export function drip(f: Faucet, body: unknown, opts: { ip?: string; contentType?: string } = {}) {
  return f.app.request('/v1/drip', { method: 'POST', headers: { 'content-type': opts.contentType ?? 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, peer(opts.ip ?? '192.0.2.10'));
}

/** Fetch a challenge, solve it for `address`, and ask for a drip. */
export async function solvedDrip(f: Faucet, address: string, ip = '192.0.2.10') {
  const { body: ch } = await challenge(f, ip);
  const { solution } = solvePow(ch.nonce, address.toLowerCase(), ch.difficulty);
  return drip(f, { address, nonce: ch.nonce, solution }, { ip });
}

/** A solution that is certainly WRONG for this nonce/address/difficulty. */
export function wrongSolution(nonce: string, address: string, difficulty: number): string {
  for (let i = 0; ; i++) if (!verifyPow({ nonce, address, solution: String(i), difficulty })) return String(i);
}

/** Hono `env` that makes the edge see a TCP peer address (RFC 5737 documentation ranges in tests). */
export const peer = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
