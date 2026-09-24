import { render } from '@testing-library/react';
import type { AppConfig } from '../src/config';
import { App, type Route } from '../src/App';
import type { KeyValueStore } from '../src/lib/pending';
import { createFakeServices, type FakeServices, type FakeServicesOptions } from '../src/services/fakes';

export function testApp(over: Partial<AppConfig> = {}): AppConfig {
  return {
    network: 'signet',
    networks: ['signet'],
    mintApiUrl: 'http://api.test',
    explorerUrl: 'https://mempool.space/signet',
    ordUrl: 'https://signet.ordinals.com',
    countersGalleryUrl: 'https://counters.gallery',
    countersFunUrl: 'https://counters.fun',
    slipstreamUrl: 'https://slipstream.mara.com',
    pollIntervalMs: 5,
    demo: true,
    ...over,
  };
}

export function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

export function fakes(o: FakeServicesOptions = {}): FakeServices {
  return createFakeServices({ network: 'signet', chain: { confirmAfterPolls: 1 }, ...o });
}

export function renderApp(services: FakeServices, opts: { route?: Route; store?: KeyValueStore; app?: AppConfig } = {}) {
  const store = opts.store ?? memoryStore();
  const utils = render(<App app={opts.app ?? testApp()} services={services} store={store} initialRoute={opts.route ?? '/'} />);
  return { ...utils, store };
}

// jsdom's TextEncoder returns a Uint8Array from another realm; the libraries check `instanceof Uint8Array`.
export const enc = (s: string) => Uint8Array.from(new TextEncoder().encode(s));
