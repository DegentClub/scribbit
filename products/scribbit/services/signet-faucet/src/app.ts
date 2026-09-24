/**
 * HTTP surface (contracts/openapi/scribbit-signet-faucet.yaml):
 *
 *   GET  /                 discovery: drip amount, PoW rule, limits
 *   GET  /healthz          liveness
 *   GET  /metrics          Prometheus text
 *   GET  /v1/status        open? budget left today
 *   GET  /v1/challenge     single-use proof-of-work nonce
 *   POST /v1/drip          { address, nonce, solution } → signet sats
 *
 * Drip order (each refusal leaves every limit untouched, except the nonce, which the attempt consumes):
 *   body → address (signet only) → solution shape → wallet enabled → nonce (unknown/expired/used) → PoW →
 *   per-address and per-IP buckets (checked together) → daily budget → take → send → on failure refund all.
 */
import { Hono } from 'hono';
import {
  bodyLimit,
  corsAllowlist,
  EdgeError,
  getClientIp,
  InMemoryRateLimitStore,
  jsonErrorHandler,
  jsonErrors,
  jsonNotFound,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
} from '@bsh/edge';
import { isSolutionShape, isValidDifficulty, POW_ALGORITHM, POW_PREFIX, verifyPow } from '@bsh/scribbit-playground-kit';
import { checkSignetAddress } from './address.js';
import { ChallengeStore, DailyBudget, DripLimiter } from './limits.js';
import { FaucetMetrics } from './metrics.js';
import { disabledWallet, FaucetWalletError, type FaucetWallet } from './wallet.js';

export const SERVICE_NAME = 'scribbit-signet-faucet';
export const SERVICE_VERSION = '0.1.0';
const DAY_MS = 86_400_000;

export interface FaucetOptions {
  wallet?: FaucetWallet;
  /** Fixed drip, sats (default 50,000: enough for a 50 KB inscription at a few sat/vB). */
  dripSats?: number;
  /** Global budget per UTC day, sats (default 5,000,000 = 100 drips). */
  dailyBudgetSats?: number;
  addressDripsPerDay?: number;
  ipDripsPerDay?: number;
  powDifficulty?: number;
  challengeTtlMs?: number;
  /** Per-IP request bucket on every route, per minute. */
  requestsPerMinute?: number;
  /** Per-IP bucket on GET /v1/challenge, per minute. */
  challengesPerMinute?: number;
  corsOrigins?: readonly string[];
  trustedProxies?: readonly string[];
  publicUrl?: string | undefined;
  /** Signet explorer base for the drip's link, e.g. https://mempool.space/signet. */
  explorerUrl?: string | undefined;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  onUnexpected?: (info: { requestId: string | undefined; error: unknown }) => void;
}

export const DEFAULTS = Object.freeze({
  dripSats: 50_000,
  dailyBudgetSats: 5_000_000,
  addressDripsPerDay: 1,
  ipDripsPerDay: 3,
  powDifficulty: 20,
  challengeTtlMs: 300_000,
  requestsPerMinute: 60,
  challengesPerMinute: 20,
});

const retryAfter = (ms: number) => ({ 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) });

export function createApp(opts: FaucetOptions = {}): Hono & { faucet: { metrics: FaucetMetrics; budget: DailyBudget; challenges: ChallengeStore } } {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS & FaucetOptions;
  if (!Number.isSafeInteger(cfg.dripSats) || cfg.dripSats < 330) throw new Error('dripSats must be an integer >= 330 (P2TR dust)');
  if (cfg.dailyBudgetSats < cfg.dripSats) throw new Error('dailyBudgetSats must cover at least one drip');
  if (!isValidDifficulty(cfg.powDifficulty)) throw new Error('powDifficulty must be an integer 1..32');
  const wallet = opts.wallet ?? disabledWallet;
  const now = opts.now ?? Date.now;
  const challenges = new ChallengeStore({ difficulty: cfg.powDifficulty, ttlMs: cfg.challengeTtlMs, ...(opts.random ? { random: opts.random } : {}) });
  const byAddress = new DripLimiter(cfg.addressDripsPerDay, DAY_MS);
  const byIp = new DripLimiter(cfg.ipDripsPerDay, DAY_MS);
  const budget = new DailyBudget(cfg.dailyBudgetSats);
  const metrics = new FaucetMetrics();
  const rl = new InMemoryRateLimitStore();
  const ttlSeconds = Math.round(cfg.challengeTtlMs / 1000);
  const powRule = { algorithm: POW_ALGORITHM, message: `${POW_PREFIX}{nonce}:{address}:{solution}`, difficulty: cfg.powDifficulty, ttlSeconds };

  const app = new Hono();
  app.onError(jsonErrorHandler({ onUnexpected: (error, c) => opts.onUnexpected?.({ requestId: c.get('requestId'), error }) }));
  app.notFound(jsonNotFound());
  app.use(requestId());
  app.use(jsonErrors());
  app.use(securityHeaders());
  if (opts.corsOrigins?.length) app.use(corsAllowlist([...opts.corsOrigins], { allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'X-Request-Id'] }));
  if (opts.trustedProxies?.length) app.use(trustProxy({ trusted: [...opts.trustedProxies] }));
  app.use(rateLimit({ windowMs: 60_000, max: cfg.requestsPerMinute, store: rl, prefix: 'req', now }));
  app.use('/v1/drip', bodyLimit(4096));

  const status = () => {
    const t = now();
    const remaining = budget.remaining(t);
    const reason = !wallet.enabled ? 'faucet_disabled' : remaining < cfg.dripSats ? 'budget_exhausted' : null;
    return {
      network: 'signet' as const,
      open: reason === null,
      reason,
      amountSats: cfg.dripSats,
      budgetRemainingSats: remaining,
      budgetLimitSats: cfg.dailyBudgetSats,
      budgetResetsAt: new Date(budget.resetsAt(t)).toISOString(),
    };
  };

  app.get('/', (c) =>
    c.json({
      name: SERVICE_NAME,
      title: 'scribb.it signet faucet',
      version: SERVICE_VERSION,
      network: 'signet',
      wallet: wallet.kind,
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      endpoints: { challenge: 'GET /v1/challenge', drip: 'POST /v1/drip', status: 'GET /v1/status', metrics: 'GET /metrics' },
      drip: { amountSats: cfg.dripSats },
      pow: powRule,
      limits: { addressDripsPerDay: cfg.addressDripsPerDay, ipDripsPerDay: cfg.ipDripsPerDay, dailyBudgetSats: cfg.dailyBudgetSats },
    }),
  );

  app.get('/healthz', (c) => c.json({ status: 'ok', service: SERVICE_NAME, version: SERVICE_VERSION, network: 'signet', wallet: wallet.kind }));

  app.get('/metrics', (c) => {
    const s = status();
    c.header('Cache-Control', 'no-store');
    return c.text(metrics.render({ budgetRemainingSats: s.budgetRemainingSats, budgetLimitSats: s.budgetLimitSats, walletEnabled: wallet.enabled }), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  });

  app.get('/v1/status', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(status());
  });

  app.get('/v1/challenge', rateLimit({ windowMs: 60_000, max: cfg.challengesPerMinute, store: rl, prefix: 'challenge', headers: false, now }), (c) => {
    const ch = challenges.issue(now());
    metrics.challengesIssued++;
    c.header('Cache-Control', 'no-store');
    return c.json({ algorithm: POW_ALGORITHM, nonce: ch.nonce, difficulty: ch.difficulty, expiresAt: new Date(ch.expiresAt).toISOString(), ttlSeconds, message: `${POW_PREFIX}${ch.nonce}:{address}:{solution}` });
  });

  app.post('/v1/drip', async (c) => {
    const refuse = (status: 400 | 409 | 410 | 413 | 415 | 429 | 502 | 503, code: string, message: string, headers: Record<string, string> = {}): never => {
      metrics.drip(code);
      throw new EdgeError(status, code, message, headers);
    };
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) refuse(415, 'unsupported_media_type', 'Send a JSON body (application/json)');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      refuse(400, 'bad_request', 'Body is not valid JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) refuse(400, 'bad_request', 'Body must be an object { address, nonce, solution }');
    const { address, nonce, solution, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length) refuse(400, 'bad_request', `Unknown field(s): ${Object.keys(extra).join(', ')}`);

    const verdict = checkSignetAddress(address);
    if (!verdict.ok) refuse(400, verdict.code, verdict.message);
    const addr = (verdict as { address: string }).address;
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) refuse(400, 'bad_request', 'nonce must be the 32-hex-character value from GET /v1/challenge');
    if (!isSolutionShape(solution)) refuse(400, 'bad_request', 'solution must be a decimal counter string (at most 20 digits, no leading zeros)');
    if (!wallet.enabled) refuse(503, 'faucet_disabled', 'The faucet is not dispensing on this instance');

    const t = now();
    const consumed = challenges.consume(nonce as string, t);
    if (!consumed.ok) {
      if (consumed.code === 'challenge_used') refuse(409, 'challenge_used', 'This challenge was already used; fetch a new one');
      if (consumed.code === 'challenge_expired') refuse(410, 'challenge_expired', 'This challenge expired; fetch a new one');
      refuse(400, 'challenge_unknown', 'Unknown challenge (never issued, or forgotten after a restart); fetch a new one');
    }
    const ch = (consumed as { challenge: { difficulty: number } }).challenge;
    // The work is checked against the difficulty the nonce was ISSUED with, and against the lower-cased address.
    if (!verifyPow({ nonce: nonce as string, address: addr, solution: solution as string, difficulty: ch.difficulty })) {
      refuse(400, 'pow_invalid', `The solution does not give ${ch.difficulty} leading zero bits for this nonce and address; fetch a new challenge`);
    }

    const ip = getClientIp(c);
    const addrWait = byAddress.retryAfterMs(addr, t);
    if (addrWait > 0) refuse(429, 'address_rate_limited', 'This address already received its drip today', retryAfter(addrWait));
    const ipWait = byIp.retryAfterMs(ip, t);
    if (ipWait > 0) refuse(429, 'ip_rate_limited', 'Too many drips from your network today', retryAfter(ipWait));
    if (!budget.reserve(cfg.dripSats, t)) refuse(503, 'budget_exhausted', "Today's faucet budget is spent; it resets at 00:00 UTC", retryAfter(budget.resetsAt(t) - t));
    byAddress.take(addr, t);
    byIp.take(ip, t);

    let txid: string;
    try {
      ({ txid } = await wallet.send(addr, cfg.dripSats));
    } catch (e) {
      const t2 = now();
      budget.release(cfg.dripSats, t2);
      byAddress.refund(addr, t2);
      byIp.refund(ip, t2);
      if (e instanceof FaucetWalletError && e.code === 'insufficient_funds') refuse(503, 'faucet_empty', 'The faucet wallet is empty; an operator has to refill it. Nothing was sent.');
      if (e instanceof FaucetWalletError && e.code === 'disabled') refuse(503, 'faucet_disabled', 'The faucet is not dispensing on this instance');
      opts.onUnexpected?.({ requestId: c.get('requestId'), error: e });
      refuse(502, 'wallet_unavailable', 'The faucet wallet did not send. Nothing was sent; try again shortly.');
    }
    metrics.drip('ok');
    metrics.satsSent += cfg.dripSats;
    c.header('Cache-Control', 'no-store');
    return c.json({ network: 'signet', address: addr, amountSats: cfg.dripSats, txid: txid!, ...(opts.explorerUrl ? { explorerUrl: `${opts.explorerUrl.replace(/\/+$/, '')}/tx/${txid!}` } : {}) });
  });

  return Object.assign(app, { faucet: { metrics, budget, challenges } });
}
