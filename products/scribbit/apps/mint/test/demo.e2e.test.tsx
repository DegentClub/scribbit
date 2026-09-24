import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readConfig, withBase } from '../src/config';
import { createDemoServices } from '../src/services';
import { loadPendingCounters, loadPendingOrdinals } from '../src/lib/pending';
import { routeOf } from '../src/App';
import { fakes, memoryStore, renderApp, testApp } from './helpers';

const file = (name: string, body: string, type = 'text/plain') => new File([body], name, { type });

describe('config and routing', () => {
  it('?demo=1 switches to demo services; env vars configure the live ones', () => {
    const demo = readConfig({}, '?demo=1');
    expect(demo.demo).toBe(true);
    expect(demo.networks).toEqual(['mainnet', 'testnet', 'signet']);
    expect(createDemoServices(demo).mode).toBe('demo');
    const live = readConfig({ VITE_MINT_API_URL: 'https://api.scribb.it/', VITE_NETWORK: 'signet', VITE_NETWORKS: 'signet,testnet', VITE_MINT_API_URL_TESTNET: 'https://t4.api.scribb.it' }, '?network=testnet');
    expect(live).toMatchObject({ demo: false, network: 'testnet', networks: ['signet', 'testnet'], mintApiUrl: 'https://t4.api.scribb.it', explorerUrl: 'https://mempool.space/testnet4', ordUrl: 'https://testnet4.ordinals.com' });
    expect(readConfig({ VITE_NETWORK: 'signet' }, '?network=mainnet').network).toBe('signet'); // not served here
    expect(readConfig({ VITE_NETWORK: 'bogus' }, '').network).toBe('mainnet');
    expect(readConfig({}, '').explorerUrl).toBe('https://explore.block.space');
    expect(routeOf('/ordinals/')).toBe('/ordinals');
    expect(routeOf('/counters')).toBe('/counters');
    expect(routeOf('/x')).toBe('/');
  });

  it('VITE_DEMO_DEFAULT=1 (the GitHub Pages build) makes demo the default; ?demo=0 still reaches live', () => {
    expect(readConfig({ VITE_DEMO_DEFAULT: '1' }, '').demo).toBe(true);
    expect(readConfig({ VITE_DEMO_DEFAULT: 'true' }, '?network=signet').demo).toBe(true);
    expect(readConfig({ VITE_DEMO_DEFAULT: '1' }, '?demo=0').demo).toBe(false);
    expect(readConfig({ VITE_DEMO_DEFAULT: '0' }, '').demo).toBe(false);
    expect(readConfig({}, '?demo=false').demo).toBe(false);
  });

  it('serves under a sub-path base (GitHub Pages /scribbit/): links and routes keep the prefix', async () => {
    expect(readConfig({ BASE_URL: '/scribbit/' }, '').base).toBe('/scribbit/');
    expect(readConfig({ BASE_URL: '/scribbit' }, '').base).toBe('/scribbit/');
    expect(readConfig({}, '').base).toBe('/');
    expect(withBase('/scribbit/', '/ordinals')).toBe('/scribbit/ordinals');
    expect(withBase('/scribbit/', '/')).toBe('/scribbit/');
    expect(withBase(undefined, '/counters')).toBe('/counters');
    expect(routeOf('/scribbit/ordinals')).toBe('/ordinals');
    expect(routeOf('/scribbit/')).toBe('/');
    renderApp(fakes(), { app: testApp({ base: '/scribbit/' }) });
    expect(screen.getAllByRole('link', { name: /\/ordinals/ })[0]).toHaveAttribute('href', '/scribbit/ordinals');
    expect(screen.getByRole('link', { name: /write to Bitcoin/i })).toHaveAttribute('href', '/scribbit/');
  });

  it('home links to both pages and shows the demo ribbon', async () => {
    const user = userEvent.setup();
    renderApp(fakes());
    expect(screen.getByText('DEMO')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Inscribe anything/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Inscribe anything' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '/counters' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Mint a Bitcoin Counter' })).toBeInTheDocument();
  });
});

describe('wallet picker', () => {
  it('lists all seven wallets with capability badges and install links', async () => {
    renderApp(fakes({ wallet: { installed: ['unisat', 'xcp'] } }), { route: '/ordinals' });
    for (const n of ['UniSat', 'Xverse', 'Leather', 'OKX Wallet', 'Magic Eden', 'XCP Wallet', 'Horizon Wallet']) expect(screen.getAllByText(n).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Connect UniSat' })).toBeEnabled();
    expect(screen.getByRole('link', { name: /Install Leather/ })).toHaveAttribute('href', expect.stringContaining('leather.io'));
    expect(screen.getAllByText('can sign tapscript').length).toBeGreaterThan(0);
    expect(screen.getAllByText('no broadcasts').length).toBe(1); // Horizon
    // XCP Wallet and Horizon are VERIFIED in the kit README; the other five carry the warning.
    expect(screen.getAllByText('unverified on this wallet: test on signet first')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Connect XCP Wallet' })).toBeEnabled();
  });
});

describe('demo: /ordinals end to end through the UI', () => {
  it('connect → content → quote → commit → reveal → done → verify bytes; batch of two', async () => {
    const user = userEvent.setup();
    const services = fakes();
    const { store } = renderApp(services, { route: '/ordinals' });
    await user.click(screen.getByRole('button', { name: 'Connect Xverse' }));
    expect(await screen.findByText('Connected: Xverse')).toBeInTheDocument();
    expect(screen.getByText(/internal key .* \(signed untweaked\)/)).toBeInTheDocument();
    expect(screen.getByText('Reveal signing unverified on this wallet: test on signet first.')).toBeInTheDocument();

    await user.upload(screen.getByLabelText('Choose files to inscribe'), [file('poem.txt', 'roses are orange'), file('pixel.png', '\x89PNG\r\n\x1a\nfake', '')]);
    const files = await screen.findByRole('list', { name: 'Files to inscribe' });
    expect(within(files).getByText('poem.txt')).toBeInTheDocument();
    expect(within(files).getByDisplayValue('image/png')).toBeInTheDocument(); // magic bytes win
    await waitFor(() => expect(screen.getByRole('button', { name: /normal · 5/ })).toHaveAttribute('aria-pressed', 'true'));

    await user.click(screen.getByRole('button', { name: 'Quote #1 of 2' }));
    expect(await screen.findByRole('heading', { name: 'The bill, to the sat' })).toBeInTheDocument();
    expect(screen.getByText(/Standard \(≤ 400,000 WU/)).toBeInTheDocument();
    expect(screen.getByTestId('total-sats').textContent).toMatch(/^\d{1,3}(,\d{3})*$/);
    expect(services.log).not.toContain('wallet.signPsbt:xverse');

    await user.click(screen.getByRole('button', { name: 'Sign commit with Xverse' }));
    expect(await screen.findByRole('heading', { name: 'Reveal the inscription' })).toBeInTheDocument();
    expect(loadPendingOrdinals(store)?.fileName).toBe('poem.txt');
    await user.click(screen.getByRole('button', { name: 'Sign reveal with Xverse' }));
    expect(await screen.findByRole('heading', { name: 'Written to Bitcoin' })).toBeInTheDocument();
    expect(loadPendingOrdinals(store)).toBeNull();
    expect(screen.getByRole('link', { name: /ordinals\.com/ })).toHaveAttribute('href', expect.stringMatching(/signet\.ordinals\.com\/inscription\/[0-9a-f]{64}i0$/));
    expect(screen.getByRole('link', { name: /explore\.block\.space/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Verify bytes' }));
    expect(await screen.findByText('✓ On-chain bytes match the SHA-256 above')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next file (2 of 2)' }));
    await user.click(await screen.findByRole('button', { name: 'Quote #2 of 2' }));
    await user.click(await screen.findByRole('button', { name: 'Sign commit with Xverse' }));
    await user.click(await screen.findByRole('button', { name: 'Sign reveal with Xverse' }));
    expect(await screen.findByRole('heading', { name: 'Written to Bitcoin' })).toBeInTheDocument();
    expect(screen.getByText('2 of 2 inscribed. Sequential: one commit and reveal at a time, so there is only ever one pending mint.')).toBeInTheDocument();
  });

  it('a cancelled signature says what to do; a reload with a pending commit offers resume', async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    const services = fakes();
    const first = renderApp(services, { route: '/ordinals', store });
    await user.click(screen.getByRole('button', { name: 'Connect XCP Wallet' }));
    await user.type(await screen.findByLabelText('…or paste text'), 'gm');
    await user.click(screen.getByRole('button', { name: 'Add text' }));
    await user.click(screen.getByRole('button', { name: 'Get exact quote' }));
    await user.click(await screen.findByRole('button', { name: 'Sign commit with XCP Wallet' }));
    await screen.findByRole('heading', { name: 'Reveal the inscription' });
    first.unmount();

    // --- reload: the wallet now rejects once
    const again = fakes({ wallet: { reject: true } });
    again.chain.state.broadcasts = services.chain.state.broadcasts;
    renderApp(again, { route: '/ordinals', store });
    expect(await screen.findByText('You have an unfinished inscription')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect XCP Wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Resume: sign the reveal' }));
    await user.click(await screen.findByRole('button', { name: 'Sign reveal with XCP Wallet' }));
    expect(await screen.findByText('You cancelled the request in your wallet.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was signed or sent/)).toBeInTheDocument();
    expect(loadPendingOrdinals(store)).not.toBeNull();
  });
});

describe('demo: /counters end to end through the UI', () => {
  it('pre-flight → mint → receipt with counters.gallery / counters.fun links', async () => {
    const user = userEvent.setup();
    const services = fakes();
    const { store } = renderApp(services, { route: '/counters' });
    await user.click(screen.getByRole('button', { name: 'Connect Horizon Wallet' }));
    expect(await screen.findByText('Connected: Horizon Wallet')).toBeInTheDocument();
    const checks = screen.getByRole('list', { name: 'Pre-flight checks' });
    expect(within(checks).getByText(/Add a file\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mint counter' })).toBeDisabled();

    await user.upload(screen.getByLabelText("Choose the counter's file"), file('art.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(await screen.findByDisplayValue('image/svg+xml')).toBeInTheDocument();

    // A taken name is refused with the reason; a named asset shows the XCP burn.
    await user.type(screen.getByLabelText('Asset name'), 'SCRIBBIT');
    expect(await within(checks).findByText(/SCRIBBIT is taken/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Asset name'));
    await user.type(screen.getByLabelText('Asset name'), 'PRINTSHOP');
    expect(await within(checks).findByText(/PRINTSHOP is free/)).toBeInTheDocument();
    expect(within(checks).getByText(/0\.5 XCP burned/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mint counter' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Mint counter' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'PRINTSHOP' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /counters\.gallery/ })).toHaveAttribute('href', 'https://counters.gallery/asset/PRINTSHOP');
    expect(screen.getByRole('link', { name: /counters\.fun/ })).toHaveAttribute('href', 'https://counters.fun/c/PRINTSHOP');
    expect(loadPendingCounters(store)).toBeNull();
    expect(services.log).toContain('cp.compose:issuance');
    expect(services.log).not.toContain('wallet.pushTx:horizon'); // Horizon cannot broadcast: the node relays
  });

  it('fairminter XCP-69 is scheduled from the tip; custom exposes the parameters', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { route: '/counters' });
    await user.click(screen.getByRole('button', { name: 'Connect XCP Wallet' }));
    await user.click(screen.getByRole('button', { name: 'Fairminter' }));
    expect(await screen.findByText(/Starts at block 912,348/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const soft = screen.getByLabelText('soft cap');
    await user.clear(soft);
    await user.type(soft, '0');
    expect((await screen.findAllByText(/a pool needs a soft cap/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Deploy fairminter' })).toBeDisabled();
  });
});
