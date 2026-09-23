/**
 * Fee provider factory: a scribb.it fee server (`.../v1/fees`, contracts/openapi/scribbit-fees.yaml) or a
 * mempool.space-compatible base URL, per network. `fetch` is injectable so tests never touch the network.
 */
import type { Network } from '@bsh/inscription';
import {
  createFeeOracle,
  feeClient,
  mempoolBlocksSource,
  mempoolRecommendedSource,
  publicMempoolUrl,
  type FeeProvider,
  type FetchLike,
} from '@bsh/scribbit-fee-oracle';

export interface FeeProviderChoice {
  provider: FeeProvider;
  kind: 'scribbit-fee-server' | 'mempool';
  url: string;
}

export function feeProviderFor(url: string | undefined, network: Network, fetchImpl?: FetchLike): FeeProviderChoice | undefined {
  const src = url ?? publicMempoolUrl(network);
  if (!src) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    throw new Error(`invalid fee source URL "${src}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`fee source must be http(s): "${src}"`);
  const f = fetchImpl ?? ((u, init) => fetch(u, init));
  if (/\/v1\/fees\/?$/.test(parsed.pathname)) return { provider: feeClient({ url: src, network, fetch: f }), kind: 'scribbit-fee-server', url: src };
  const oracle = createFeeOracle({
    network,
    sources: [mempoolRecommendedSource({ baseUrl: src, fetch: f }), mempoolBlocksSource({ baseUrl: src, fetch: f })],
    timeoutMs: 10_000,
  });
  return { provider: oracle, kind: 'mempool', url: src };
}

/** Build the `fees` port for a set of networks. `'off'` disables a network's oracle (quotes then need feeRate). */
export function feeProviders(networks: readonly Network[], urls: Partial<Record<Network, string | 'off'>>, fetchImpl?: FetchLike): Partial<Record<Network, FeeProvider>> {
  const out: Partial<Record<Network, FeeProvider>> = {};
  for (const n of networks) {
    const u = urls[n];
    if (u === 'off') continue;
    const choice = feeProviderFor(u, n, fetchImpl);
    if (choice) out[n] = choice.provider;
  }
  return out;
}
