/**
 * Per-tool API key scopes. `mcp` is the original, read-only scope (every calculator). The three newer scopes
 * follow what an agent may do with money: `mcp:quote` reads orders, `mcp:order` proposes them (create) and
 * reports funding, `mcp:settle` reports funding and reads but never proposes. `mcp:order` and `mcp:settle` are
 * never granted to one key (the FlashyOS propose / settle split): a proposer cannot also be the party that
 * confirms what the chain shows.
 */
export const SCOPE_MCP = 'mcp';
export const SCOPE_QUOTE = 'mcp:quote';
export const SCOPE_ORDER = 'mcp:order';
export const SCOPE_SETTLE = 'mcp:settle';

export const MCP_SCOPES = [SCOPE_MCP, SCOPE_QUOTE, SCOPE_ORDER, SCOPE_SETTLE] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Read-only calculators: any MCP scope. */
export const CALCULATOR_SCOPES: readonly McpScope[] = MCP_SCOPES;
/** Reading an order or a receipt. */
export const ORDER_READ_SCOPES: readonly McpScope[] = [SCOPE_QUOTE, SCOPE_ORDER, SCOPE_SETTLE];
/** Creating an order (proposing). */
export const ORDER_WRITE_SCOPES: readonly McpScope[] = [SCOPE_ORDER];
/** Reporting a funding transaction: the proposer or the settle side. */
export const FUNDING_REPORT_SCOPES: readonly McpScope[] = [SCOPE_ORDER, SCOPE_SETTLE];

export const isMcpScope = (s: unknown): s is McpScope => typeof s === 'string' && (MCP_SCOPES as readonly string[]).includes(s);

/** The MCP scopes among a key's scopes (other services' scopes are ignored). */
export const mcpScopesOf = (scopes: readonly string[]): McpScope[] => scopes.filter(isMcpScope);

/** `mcp:order` and `mcp:settle` on one key is a configuration error, never a runtime question. */
export function scopeConflict(scopes: readonly string[]): string | undefined {
  if (scopes.includes(SCOPE_ORDER) && scopes.includes(SCOPE_SETTLE))
    return `scopes ${SCOPE_ORDER} and ${SCOPE_SETTLE} cannot be held by the same key (a proposer never settles its own orders)`;
  return undefined;
}

export function assertScopeSet(scopes: readonly string[], label: string): void {
  const conflict = scopeConflict(scopes);
  if (conflict) throw new Error(`${label}: ${conflict}`);
}

/**
 * Whether a caller holding `granted` may use a tool accepting `required`. `granted === undefined` means an
 * unrestricted local caller (stdio: same user, same machine; or anonymous with MCP_REQUIRE_API_KEY=false).
 */
export function hasAnyScope(granted: readonly string[] | undefined, required: readonly McpScope[]): boolean {
  if (granted === undefined) return true;
  return required.some((s) => granted.includes(s));
}
