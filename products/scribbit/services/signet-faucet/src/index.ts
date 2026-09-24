export { createApp, DEFAULTS, SERVICE_NAME, SERVICE_VERSION, type FaucetOptions } from './app.js';
export { checkSignetAddress, type AddressVerdict } from './address.js';
export { ChallengeStore, DailyBudget, DripLimiter, type Challenge, type ConsumeResult } from './limits.js';
export { DRIP_RESULTS, FaucetMetrics } from './metrics.js';
export { ConfigError, loadServerConfig, type ServerConfig } from './config.js';
export {
  createBitcoindWallet,
  createFakeWallet,
  disabledWallet,
  FaucetWalletError,
  RPC,
  satsToBtcString,
  type BitcoindWallet,
  type BitcoindWalletOptions,
  type FaucetWallet,
  type FaucetWalletErrorCode,
  type FakeWallet,
  type FetchLike,
  type WalletKind,
} from './wallet.js';
