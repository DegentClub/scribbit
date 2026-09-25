/**
 * @bsh/blockspace-tutor — the Ask Blockspace HTTP service. `createApp(opts)` mounts POST /v1/ask (grounded
 * answers + citations + guardrails) behind @bsh/edge; `src/main.ts` is the runnable entry point.
 */
export { createApp, parseAskRequest, SERVICE_NAME, SERVICE_TITLE, SERVICE_VERSION, type AppOptions, type AskErrorCode } from './app.js';
export { ConfigError, loadServerConfig, type ServerConfig } from './config.js';
export { HttpLiveFacts, type HttpLiveFactsOptions } from './livefacts-http.js';
