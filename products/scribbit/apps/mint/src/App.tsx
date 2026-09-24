import { useEffect, useState } from 'react';
import type { AppConfig } from './config';
import { networkLabel } from './config';
import type { Services } from './services/types';
import { browserStore, type KeyValueStore } from './lib/pending';
import { OrdinalsPage } from './pages/OrdinalsPage';
import { CountersPage } from './pages/CountersPage';

export type Route = '/' | '/ordinals' | '/counters';

export function routeOf(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p.endsWith('/ordinals') ? '/ordinals' : p.endsWith('/counters') ? '/counters' : '/';
}

export interface AppProps {
  app: AppConfig;
  services: Services;
  store?: KeyValueStore | null;
  /** Start on a route (tests); otherwise read from `location`. */
  initialRoute?: Route;
}

export function App({ app, services, store = browserStore(), initialRoute }: AppProps) {
  const [route, setRoute] = useState<Route>(initialRoute ?? routeOf(typeof location !== 'undefined' ? location.pathname : '/'));
  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    document.title = route === '/ordinals' ? 'Inscribe · scribb.it' : route === '/counters' ? 'Mint a Counter · scribb.it' : 'scribb.it · write to Bitcoin';
  }, [route]);

  const go = (r: Route) => (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      history.pushState(null, '', `${r}${location.search}`);
    } catch {
      /* jsdom / sandbox */
    }
    setRoute(r);
    window.scrollTo?.(0, 0);
  };

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      {services.mode === 'demo' ? (
        <div className="demo-ribbon" role="note">
          <strong>DEMO</strong> · simulated wallets, node and chain; the transaction maths and signatures are real. No bitcoin moves. Remove <code>?demo=1</code> for the real mint.
        </div>
      ) : null}
      <header className="header">
        <a className="brand" href="/" onClick={go('/')}>
          <span className="brand__mark">
            scribb<span className="brand__dot">.</span>it
          </span>
          <span className="brand__tag">write to Bitcoin</span>
        </a>
        <nav className="nav" aria-label="Main">
          <a href="/ordinals" aria-current={route === '/ordinals' ? 'page' : undefined} onClick={go('/ordinals')}>
            /ordinals
          </a>
          <a href="/counters" aria-current={route === '/counters' ? 'page' : undefined} onClick={go('/counters')}>
            /counters
          </a>
        </nav>
        <div className="net">
          <span className="net__dot" aria-hidden="true" />
          {app.networks.length > 1 ? (
            <>
              <label htmlFor="network" className="sr-only">
                Network
              </label>
              <select
                id="network"
                value={app.network}
                onChange={(e) => {
                  const q = new URLSearchParams(location.search);
                  q.set('network', e.target.value);
                  location.search = q.toString();
                }}
              >
                {app.networks.map((n) => (
                  <option key={n} value={n}>
                    {networkLabel(n)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span>{networkLabel(app.network)}</span>
          )}
        </div>
      </header>
      <main id="main">
        {route === '/ordinals' ? <OrdinalsPage key={`o-${app.network}`} app={app} services={services} store={store} /> : null}
        {route === '/counters' ? <CountersPage key={`c-${app.network}`} app={app} services={services} store={store} /> : null}
        {route === '/' ? (
          <div className="page">
            <header>
              <h1>Write to Bitcoin.</h1>
              <p className="lede">Put a file on Bitcoin, byte for byte. You see the exact bytes, weight and cost first; your wallet signs every transaction; this site never holds a key and nothing is custodial.</p>
            </header>
            <div className="home-cards">
              <a className="card home-card" href="/ordinals" onClick={go('/ordinals')}>
                <p className="card__kicker">/ordinals</p>
                <h2>Inscribe anything</h2>
                <p>Any file or text as an Ordinals inscription: images, HTML, audio, a poem. One file or a batch.</p>
              </a>
              <a className="card home-card" href="/counters" onClick={go('/counters')}>
                <p className="card__kicker">/counters</p>
                <h2>Mint a Bitcoin Counter</h2>
                <p>A Counterparty asset whose description is the file itself, numbered forever. Counter, reinscription or an XCP-69 fair launch.</p>
              </a>
            </div>
          </div>
        ) : null}
      </main>
      <footer className="footer">
        <p>
          scribb.it · PSBTs only: your wallet signs, we build and check. Network <span className="mono">{networkLabel(app.network)}</span>
          {services.mode === 'demo' ? ' · demo mode' : ''}.
        </p>
      </footer>
    </>
  );
}
