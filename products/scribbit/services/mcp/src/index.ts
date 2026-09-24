/**
 * @bsh/scribbit-mcp: the scribb.it MCP server ("scribb.it: write to Bitcoin").
 *
 * - `createScribbitMcpServer(ports)` builds the McpServer (tools, resources, prompts) for any transport.
 * - `createApp(opts)` mounts it at /mcp in a Hono app behind @bsh/edge (API keys, scopes, rate limits, JSON errors),
 *   with the discovery document, the agent card and /.well-known/mcp.json.
 * - `src/main.ts` (HTTP) and `src/stdio.ts` (local stdio) are the runnable entry points.
 */
export { createApp, agentCard, mcpManifest, AGENT_CARD_PATH, FLASHYOS_LINKS, MCP_MANIFEST_PATH, MCP_SCOPE, PROTOCOL_VERSIONS, PROVIDER, WELL_KNOWN_CACHE_CONTROL, type AppOptions } from './app.js';
export {
  createScribbitMcpServer,
  INSTRUCTIONS,
  PROMPTS,
  RESOURCES,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  TOOLS,
  inscribePrompt,
  promptNames,
  resourceUris,
  toolNames,
  toolScopes,
  type ResourceSpec,
  type ToolSpec,
} from './mcp.js';
export {
  CALCULATOR_SCOPES,
  FUNDING_REPORT_SCOPES,
  MCP_SCOPES,
  ORDER_READ_SCOPES,
  ORDER_WRITE_SCOPES,
  SCOPE_MCP,
  SCOPE_ORDER,
  SCOPE_QUOTE,
  SCOPE_SETTLE,
  assertScopeSet,
  hasAnyScope,
  isMcpScope,
  mcpScopesOf,
  scopeConflict,
  type McpScope,
} from './scopes.js';
export { ConfigError, keyStoreFrom, loadServerConfig, parseKeyRecord, parseKeyRecords, type ServerConfig } from './config.js';
export { feeProviderFor, feeProviders, type FeeProviderChoice } from './fees.js';
export { ToolError, type ToolErrorBody, type ToolErrorCode } from './errors.js';
export {
  buildEnvelope,
  commitAddressTool,
  docWeight,
  explainLanes,
  getFees,
  lanesMarkdown,
  maxBodyFor,
  quoteInscription,
  rescueTx,
  TIERS,
  type CommitAddressResult,
  type EnvelopeResult,
  type ExplainLanesResult,
  type QuoteResult,
  type RescueResult,
  type ScribbitMcpPorts,
} from './tools.js';
export {
  createOrder,
  currentPayment,
  getOrder,
  getReceipt,
  reportFunding,
  validateObservation,
  validatePayees,
  COMMIT_PAYEE_REF,
  DUST_WARNING_SATS,
  MAX_OBSERVED_OUTPUTS,
  MAX_PAYEES,
  NETWORK_COST_SKU,
  PAYEE_KINDS,
  QUOTE_TTL_MS,
  type CreateOrderInput,
  type CreateOrderResult,
  type ExpectedOutputView,
  type GetOrderResult,
  type GetReceiptResult,
  type PayeeInput,
  type ReportFundingInput,
  type ReportFundingResult,
} from './orders.js';
export {
  createLedgerClient,
  LedgerClientError,
  type FetchLike,
  type LedgerClient,
  type LedgerClientOptions,
  type LedgerCreateOrder,
  type LedgerExpectedOutput,
  type LedgerLineItem,
  type LedgerObservation,
  type LedgerObservationResult,
  type LedgerOrder,
  type LedgerPayee,
  type LedgerPayment,
  type LedgerPayout,
  type LedgerReceipt,
} from './ledger-client.js';
export { extractSecuritySection, FALLBACK_SECURITY_MODEL, securityModelDoc } from './docs.js';
export { DEFAULT_MAX_BODY_BYTES, MAX_CONTENT_BYTES, MAX_METADATA_BYTES } from './limits.js';
