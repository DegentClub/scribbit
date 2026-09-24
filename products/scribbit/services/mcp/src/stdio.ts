/**
 * stdio entry point for local MCP clients (Claude Desktop, `claude mcp add`). No API key: the client is the
 * same user on the same machine. Fee sources come from MCP_FEE_URL_<NETWORK> (default: public mempool.space);
 * set them to `off` to run fully offline (quotes then need an explicit feeRate). Order tools need MCP_LEDGER_URL +
 * MCP_LEDGER_API_KEY; the local caller is unrestricted (every scope), so guard that key like any other secret.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Network } from '@bsh/inscription';
import { isNetwork, NETWORKS } from './content.js';
import { feeProviders } from './fees.js';
import { createLedgerClient } from './ledger-client.js';
import { createScribbitMcpServer } from './mcp.js';

export async function startStdio(env: Record<string, string | undefined> = process.env): Promise<void> {
  const networks = (env.MCP_NETWORKS ?? NETWORKS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => {
      if (!isNetwork(n)) throw new Error(`MCP_NETWORKS: unknown network "${n}"`);
      return n;
    });
  const feeUrls: Partial<Record<Network, string | 'off'>> = {};
  for (const n of networks) {
    const raw = env[`MCP_FEE_URL_${n.toUpperCase()}`]?.trim();
    if (raw) feeUrls[n] = raw.toLowerCase() === 'off' ? 'off' : raw;
  }
  const ledgerUrl = env.MCP_LEDGER_URL?.trim();
  const ledgerKey = env.MCP_LEDGER_API_KEY?.trim();
  if (ledgerUrl && !ledgerKey) throw new Error('MCP_LEDGER_API_KEY is required when MCP_LEDGER_URL is set');
  const server = createScribbitMcpServer({
    fees: feeProviders(networks, feeUrls),
    ...(ledgerUrl && ledgerKey ? { ledger: createLedgerClient({ baseUrl: ledgerUrl, apiKey: ledgerKey }) } : {}),
    // stdout is the protocol channel; diagnostics go to stderr only.
    onUnexpected: (tool, e) => console.error(JSON.stringify({ msg: 'tool failed', tool, error: String((e as Error)?.message ?? e) })),
  });
  await server.connect(new StdioServerTransport());
}

startStdio().catch((e) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});
