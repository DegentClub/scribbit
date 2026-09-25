import { render } from '@testing-library/react';
import { App } from '../src/App';
import { readConfig, type PlaygroundConfig } from '../src/config';
import { createFakeServices, type FakeServices, type FakeServicesOptions } from '../src/services/fakes';
import { solveOnMainThread } from '../src/lib/pow';
import type { KeyValueStore } from '../src/lib/throwaway';

export function testConfig(over: Partial<PlaygroundConfig> = {}): PlaygroundConfig {
  return { ...readConfig({ VITE_FAUCET_URL: 'https://faucet.scribbit.internal.example' }, '?demo=1'), ...over };
}

export function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

/** Fakes at a small difficulty so the main-thread solver finishes in milliseconds under jsdom. */
export function fakes(o: FakeServicesOptions = {}): FakeServices {
  return createFakeServices({ ...o, faucet: { difficulty: 8, ...o.faucet }, chain: { confirmAfterPolls: 1, ...o.chain } });
}

export function renderApp(services: FakeServices, opts: { config?: PlaygroundConfig; store?: KeyValueStore; now?: () => number } = {}) {
  const store = opts.store ?? memoryStore();
  const utils = render(<App config={opts.config ?? testConfig()} services={services} store={store} solver={solveOnMainThread} pollMs={5} {...(opts.now ? { now: opts.now } : {})} />);
  return { ...utils, store };
}

export const enc = (s: string) => Uint8Array.from(new TextEncoder().encode(s));
