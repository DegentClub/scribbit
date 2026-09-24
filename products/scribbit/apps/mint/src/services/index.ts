import type { AppConfig } from '../config';
import type { Services } from './types';
import { createRealWallets } from './real/wallet';
import { createMintApiChain } from './real/chain';
import { createRealInscription } from './real/inscription';
import { createRealCountersKit, createRealCp } from './real/counters';
import { createFakeServices } from './fakes';

/** Live: wallet-kit, the mint API (fees, Esplora, Counterparty proxy), the real maths. */
export function createLiveServices(app: AppConfig): Services {
  return {
    mode: 'live',
    wallets: createRealWallets(),
    chain: createMintApiChain(app.mintApiUrl, app.ordUrl),
    inscription: createRealInscription(),
    cp: createRealCp(app.mintApiUrl),
    counters: createRealCountersKit(),
  };
}

/** `?demo=1`: fakes for everything with money or a server behind it; the same maths as live. */
export function createDemoServices(app: AppConfig): Services {
  return createFakeServices({ network: app.network });
}

export function createServices(app: AppConfig): Services {
  return app.demo ? createDemoServices(app) : createLiveServices(app);
}

export type { Services } from './types';
