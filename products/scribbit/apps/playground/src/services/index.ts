import type { PlaygroundConfig } from '../config';
import type { Services } from './types';
import { createRealWallets } from '@bsh/scribbit-mint/src/services/real/wallet';
import { createRealInscription } from '@bsh/scribbit-mint/src/services/real/inscription';
import { createHttpFaucet } from './real/faucet';
import { createEsploraChain } from './real/esplora';
import { createAnalytics } from './real/analytics';
import { createFakeServices } from './fakes';

export function createLiveServices(c: PlaygroundConfig): Services {
  return {
    mode: 'live',
    faucet: createHttpFaucet(c.faucetUrl),
    chain: createEsploraChain(c.esploraUrl, { fixedFeeRate: c.feeRate, minFeeRate: c.minFeeRate }),
    analytics: createAnalytics(c.analyticsUrl),
    wallets: createRealWallets(),
    inscription: createRealInscription(),
  };
}

/** `?demo=1`: fully offline. Analytics is recorded in memory only, never sent. */
export function createDemoServices(): Services {
  return createFakeServices({ faucet: { latencyMs: 250 }, chain: { confirmAfterPolls: 3 } });
}

export function createServices(c: PlaygroundConfig): Services {
  return c.demo ? createDemoServices() : createLiveServices(c);
}

export type { Services } from './types';
