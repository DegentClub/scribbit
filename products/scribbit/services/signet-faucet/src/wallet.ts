/**
 * The faucet wallet port and its adapters. The only private key in this whole feature is the faucet's own, and it
 * stays inside bitcoind: this process asks bitcoind to `sendtoaddress` and never sees a key.
 *
 *   createBitcoindWallet   JSON-RPC to a signet node's wallet (env-configured; refuses any chain but signet)
 *   createFakeWallet       in-memory, deterministic txids, a finite balance (tests, local dev, demos)
 *   disabledWallet         the default: every send is refused with `faucet_disabled`
 */
import { sha256 } from '@noble/hashes/sha2.js';

export type WalletKind = 'off' | 'bitcoind' | 'fake';

export type FaucetWalletErrorCode = 'insufficient_funds' | 'unavailable' | 'wrong_chain' | 'rejected' | 'disabled';

export class FaucetWalletError extends Error {
  constructor(
    readonly code: FaucetWalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FaucetWalletError';
  }
}

export interface FaucetWallet {
  readonly kind: WalletKind;
  readonly enabled: boolean;
  /** Pay `sats` to `address`; resolves with the broadcast txid. Throws FaucetWalletError. */
  send(address: string, sats: number): Promise<{ txid: string }>;
}

export const disabledWallet: FaucetWallet = {
  kind: 'off',
  enabled: false,
  async send() {
    throw new FaucetWalletError('disabled', 'the faucet wallet is disabled (FAUCET_WALLET=off)');
  },
};

/** 50,000 sats → "0.00050000": exact, no floating point. */
export function satsToBtcString(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new RangeError(`invalid sats: ${sats}`);
  const s = String(sats).padStart(9, '0');
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}

// ------------------------------------------------------------------------------------------------ fake

export interface FakeWallet extends FaucetWallet {
  balanceSats: number;
  sent: Array<{ address: string; sats: number; txid: string }>;
  /** Make the next sends fail with this error (tests). */
  failWith?: FaucetWalletError | undefined;
}

export function createFakeWallet(opts: { balanceSats?: number } = {}): FakeWallet {
  const w: FakeWallet = {
    kind: 'fake',
    enabled: true,
    balanceSats: opts.balanceSats ?? 100_000_000,
    sent: [],
    async send(address, sats) {
      if (w.failWith) throw w.failWith;
      if (sats > w.balanceSats) throw new FaucetWalletError('insufficient_funds', 'Insufficient funds');
      w.balanceSats -= sats;
      const txid = Array.from(sha256(new TextEncoder().encode(`fake-faucet|${w.sent.length}|${address}|${sats}`)), (b) => b.toString(16).padStart(2, '0')).join('');
      w.sent.push({ address, sats, txid });
      return { txid };
    },
  };
  return w;
}

// ------------------------------------------------------------------------------------------------ bitcoind

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BitcoindWalletOptions {
  /** Node RPC base, e.g. http://bitcoind.internal.example:38332 (signet's default RPC port). */
  url: string;
  /** Wallet name (`/wallet/<name>`). */
  wallet: string;
  user: string;
  password: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Opt-in replaceability of drips (BIP 125). Default true: a stuck drip can be fee-bumped by the operator. */
  replaceable?: boolean;
}

interface RpcReply {
  result?: unknown;
  error?: { code: number; message: string } | null;
}

/** Bitcoin Core RPC error codes this adapter maps (src/rpc/protocol.h). */
export const RPC = { WALLET_INSUFFICIENT_FUNDS: -6, WALLET_ERROR: -4, INVALID_ADDRESS_OR_KEY: -5, WALLET_NOT_FOUND: -18, WALLET_NOT_SPECIFIED: -19, TYPE_ERROR: -3 } as const;

export interface BitcoindWallet extends FaucetWallet {
  /** getblockchaininfo → chain must be "signet". Called before the first send and by main.ts at startup. */
  assertSignet(): Promise<void>;
}

export function createBitcoindWallet(o: BitcoindWalletOptions): BitcoindWallet {
  const f: FetchLike = o.fetch ?? ((u, init) => fetch(u, init));
  const base = o.url.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${o.user}:${o.password}`).toString('base64')}`;
  let id = 0;
  let checked = false;

  async function call(path: string, method: string, params: unknown[]): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({ jsonrpc: '1.0', id: `faucet-${++id}`, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new FaucetWalletError('unavailable', `bitcoind did not answer ${method}: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 401 || res.status === 403) throw new FaucetWalletError('unavailable', `bitcoind refused the RPC credentials (HTTP ${res.status})`);
    let body: RpcReply;
    try {
      body = (await res.json()) as RpcReply;
    } catch {
      throw new FaucetWalletError('unavailable', `bitcoind answered ${method} with HTTP ${res.status} and no JSON`);
    }
    if (body.error) {
      const { code, message } = body.error;
      if (code === RPC.WALLET_INSUFFICIENT_FUNDS) throw new FaucetWalletError('insufficient_funds', message);
      if (code === RPC.INVALID_ADDRESS_OR_KEY || code === RPC.TYPE_ERROR) throw new FaucetWalletError('rejected', message);
      throw new FaucetWalletError('unavailable', `${method}: ${message} (${code})`);
    }
    if (!res.ok) throw new FaucetWalletError('unavailable', `bitcoind answered ${method} with HTTP ${res.status}`);
    return body.result;
  }

  const w: BitcoindWallet = {
    kind: 'bitcoind',
    enabled: true,
    async assertSignet() {
      const info = (await call('/', 'getblockchaininfo', [])) as { chain?: string } | null;
      if (info?.chain !== 'signet') throw new FaucetWalletError('wrong_chain', `bitcoind reports chain "${String(info?.chain)}"; the faucet only runs against signet`);
      checked = true;
    },
    async send(address, sats) {
      if (!checked) await w.assertSignet();
      const txid = await call(`/wallet/${encodeURIComponent(o.wallet)}`, 'sendtoaddress', [address, satsToBtcString(sats), '', '', false, o.replaceable ?? true]);
      if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) throw new FaucetWalletError('unavailable', 'sendtoaddress did not return a txid');
      return { txid };
    },
  };
  return w;
}
