/** The page's data as JSON: served as `playground.json` and rendered for `?format=json`. No secrets, no personal data. */
import { playgroundDocument } from '@bsh/scribbit-playground-kit';
import type { PlaygroundConfig } from './config';
import { CONFORMANCE_SOURCE, signetStatuses } from './lib/walletStatus';

export function jsonTwinData(config: PlaygroundConfig) {
  return {
    ...playgroundDocument(),
    anchors: { steps: ['#step-wallet', '#step-coins', '#step-file', '#step-inscribe', '#step-certificate'], glossary: '#term-<id>' },
    endpoints: { faucet: config.faucetUrl || null, esplora: config.esploraUrl, explorer: config.explorerUrl, ord: config.ordUrl, xray: config.xrayUrl, analytics: config.analyticsUrl ? 'on' : 'off' },
    faucetContract: 'contracts/openapi/scribbit-signet-faucet.yaml',
    wallets: { source: CONFORMANCE_SOURCE, signet: signetStatuses() },
  };
}
