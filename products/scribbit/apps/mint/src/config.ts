import type { Network } from '@bsh/inscription';

/** Runtime configuration, from Vite env vars with safe defaults. See README "Configuration". */
export interface AppConfig {
  network: Network;
  /** `@bsh/scribbit-mint-api` base (no trailing slash). `/api/...` is appended. */
  mintApiUrl: string;
  /** Block explorer for tx links: `${explorerUrl}/tx/<txid>`. */
  explorerUrl: string;
  /** ord server: `${ordUrl}/inscription/<id>` and `/content/<id>`. */
  ordUrl: string;
  /** Bitcoin Counters explorer + market: `${countersGalleryUrl}/asset/<name>`, `${countersFunUrl}/c/<name>`. */
  countersGalleryUrl: string;
  countersFunUrl: string;
  /** Slipstream hand-off is offered when a counters reveal exceeds the standard relay cap. */
  slipstreamUrl: string;
  pollIntervalMs: number;
  demo: boolean;
  /** Networks the header switch offers (VITE_NETWORKS; demo: all three public ones). */
  networks: Network[];
}

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export function defaultExplorer(network: Network): string {
  switch (network) {
    case 'mainnet':
      return 'https://explore.block.space';
    case 'testnet':
      return 'https://mempool.space/testnet4';
    case 'signet':
      return 'https://mempool.space/signet';
    case 'regtest':
      return 'http://localhost:3002';
  }
}

export function defaultOrd(network: Network): string {
  switch (network) {
    case 'mainnet':
      return 'https://ordinals.com';
    case 'testnet':
      return 'https://testnet4.ordinals.com';
    case 'signet':
      return 'https://signet.ordinals.com';
    case 'regtest':
      return 'http://localhost:8080';
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export interface EnvLike {
  VITE_MINT_API_URL?: string;
  VITE_NETWORK?: string;
  VITE_EXPLORER_URL?: string;
  VITE_ORD_URL?: string;
  VITE_COUNTERS_GALLERY_URL?: string;
  VITE_COUNTERS_FUN_URL?: string;
  VITE_SLIPSTREAM_URL?: string;
  VITE_POLL_MS?: string;
  VITE_NETWORKS?: string;
  /** Per-network API bases: VITE_MINT_API_URL_MAINNET / _TESTNET / _SIGNET / _REGTEST. */
  [key: string]: string | undefined;
}

export function readConfig(env: EnvLike, search: string): AppConfig {
  const params = new URLSearchParams(search);
  const demo = params.get('demo') === '1' || params.get('demo') === 'true';
  const rawNet = (env.VITE_NETWORK ?? 'mainnet') as Network;
  const base: Network = NETWORKS.includes(rawNet) ? rawNet : 'mainnet';
  const listed = (env.VITE_NETWORKS ?? '').split(',').map((s) => s.trim()).filter((s): s is Network => NETWORKS.includes(s as Network));
  const networks: Network[] = demo ? ['mainnet', 'testnet', 'signet'] : listed.length ? [...new Set([base, ...listed])] : [base];
  const asked = params.get('network') as Network | null;
  // `?network=` switches only between networks this deployment serves (one mint API per network).
  const network: Network = asked && networks.includes(asked) ? asked : base;
  const poll = Number(env.VITE_POLL_MS ?? '');
  return {
    network,
    mintApiUrl: trimSlash(env[`VITE_MINT_API_URL_${network.toUpperCase()}`] ?? env.VITE_MINT_API_URL ?? ''),
    explorerUrl: trimSlash(env.VITE_EXPLORER_URL ?? defaultExplorer(network)),
    ordUrl: trimSlash(env.VITE_ORD_URL ?? defaultOrd(network)),
    countersGalleryUrl: trimSlash(env.VITE_COUNTERS_GALLERY_URL ?? 'https://counters.gallery'),
    countersFunUrl: trimSlash(env.VITE_COUNTERS_FUN_URL ?? 'https://counters.fun'),
    slipstreamUrl: trimSlash(env.VITE_SLIPSTREAM_URL ?? 'https://slipstream.mara.com'),
    pollIntervalMs: Number.isFinite(poll) && poll > 0 ? poll : demo ? 800 : 5000,
    demo,
    networks,
  };
}

/** Human labels. `testnet` means testnet4 everywhere in this app. */
export function networkLabel(network: Network): string {
  return network === 'testnet' ? 'testnet4' : network;
}
