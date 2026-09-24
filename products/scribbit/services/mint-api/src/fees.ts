/**
 * Fee provider: a scribb.it fee server (`.../v1/fees`, contracts/openapi/scribbit-fees.yaml) or a
 * mempool.space-compatible base URL. `fetch` is injectable so tests never touch the network.
 */
import {
  createFeeOracle,
  feeClient,
  mempoolBlocksSource,
  mempoolRecommendedSource,
  publicMempoolUrl,
  type FeeProvider,
  type FetchLike,
  type Network,
} from '@bsh/scribbit-fee-oracle';

export function feeProviderFor(url: string | 'off' | undefined, network: Network, fetchImpl?: FetchLike): FeeProvider | undefined {
  if (url === 'off') return undefined;
  const src = url ?? publicMempoolUrl(network);
  if (!src) return undefined;
  const parsed = new URL(src);
  const f = fetchImpl ?? ((u, init) => fetch(u, init));
  if (/\/v1\/fees\/?$/.test(parsed.pathname)) return feeClient({ url: src, network, fetch: f });
  return createFeeOracle({
    network,
    sources: [mempoolRecommendedSource({ baseUrl: src, fetch: f }), mempoolBlocksSource({ baseUrl: src, fetch: f })],
    timeoutMs: 10_000,
  });
}
