/**
 * @bsh/scribbit-mcp: the scribb.it MCP server ("scribb.it: write to Bitcoin").
 *
 * - `createScribbitMcpServer(ports)` builds the McpServer (tools, resources, prompts) for any transport.
 * - `createApp(opts)` mounts it at /mcp in a Hono app behind @bsh/edge (API keys, rate limits, JSON errors).
 * - `src/main.ts` (HTTP) and `src/stdio.ts` (local stdio) are the runnable entry points.
 */
export { createApp, MCP_SCOPE, type AppOptions } from './app.js';
export { createScribbitMcpServer, INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, SERVER_VERSION, inscribePrompt } from './mcp.js';
export { ConfigError, keyStoreFrom, loadServerConfig, parseKeyRecord, parseKeyRecords, type ServerConfig } from './config.js';
export { feeProviderFor, feeProviders, type FeeProviderChoice } from './fees.js';
export { ToolError, type ToolErrorBody, type ToolErrorCode } from './errors.js';
export {
  askBlockspace,
  getAsker,
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
export { extractSecuritySection, securityModelDoc } from './docs.js';
export { DEFAULT_MAX_BODY_BYTES, MAX_CONTENT_BYTES, MAX_METADATA_BYTES } from './limits.js';
