import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QUIZ } from '@bsh/scribbit-playground-kit';
import { fakes, memoryStore, renderApp, testConfig } from './helpers';
import { THROWAWAY_KEY } from '../src/lib/throwaway';
import { signetStatuses } from '../src/lib/walletStatus';

type User = ReturnType<typeof userEvent.setup>;

async function toCoins(user: User) {
  await user.click(screen.getByRole('button', { name: 'Make a throwaway test key' }));
  await screen.findByRole('heading', { level: 1, name: 'Get free test coins' });
}
async function toFile(user: User) {
  await toCoins(user);
  await user.click(screen.getByRole('button', { name: 'Get free test coins' }));
  await screen.findByRole('heading', { level: 1, name: 'Pick a small file' }, { timeout: 10_000 });
}
async function toInscribe(user: User) {
  await toFile(user);
  await user.click(screen.getByRole('button', { name: 'A line of text' }));
  await user.click(await screen.findByRole('button', { name: 'Continue: commit and reveal' }));
  await screen.findByRole('heading', { level: 1, name: 'Commit and reveal' });
}

describe('step 1: test wallet', () => {
  it('explains, keeps the throwaway key in the session store only, offers continue / new / forget and a signet-only backup', async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    const { unmount } = renderApp(fakes(), { store });
    expect(screen.getByText('In plain words')).toBeInTheDocument();
    expect(screen.getByTestId('onchain-wallet')).toHaveTextContent('Nothing yet');
    await user.click(screen.getByRole('button', { name: 'Make a throwaway test key' }));
    const saved = JSON.parse(store.map.get(THROWAWAY_KEY)!);
    expect(saved).toMatchObject({ network: 'signet' });
    expect(saved.privHex).toMatch(/^[0-9a-f]{64}$/);
    unmount();

    renderApp(fakes(), { store });
    expect(screen.getByRole('button', { name: "Continue with this tab's test key" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^tb1p/ })).toBeInTheDocument();
    await user.click(screen.getByText('Backup (optional)'));
    expect(await screen.findByTestId('backup-descriptor')).toHaveTextContent(/^tr\(c[1-9A-HJ-NP-Za-km-z]{51}\)$/);
    await user.click(screen.getByRole('button', { name: 'Forget this key now' }));
    expect(store.map.has(THROWAWAY_KEY)).toBe(false);
    expect(screen.getByRole('button', { name: 'Make a throwaway test key' })).toBeInTheDocument();
  });

  it('shows each wallet\'s signet status from the conformance snapshot; unsupported ones cannot be connected', () => {
    renderApp(fakes());
    const statuses = signetStatuses();
    for (const s of statuses) {
      const el = screen.queryByTestId(`status-${s.id}`);
      if (el) expect(el.textContent).toMatch(s.signet === 'assumed' ? /Signet: assumed, not yet verified/ : s.signet === 'unsupported' ? /Signet: not supported/ : /Signet:/);
    }
    for (const s of statuses.filter((x) => !x.usable)) {
      const name = new RegExp(`Connect ${s.name.split(' ')[0]}`);
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const verified = statuses.filter((s) => s.verified).length;
    expect(screen.getByText(new RegExp(`^${verified} of ${statuses.length} wallets verified on signet`))).toBeInTheDocument();
  });

  it('wallet refuses to connect: explained, still on step 1', async () => {
    const user = userEvent.setup();
    const services = fakes({ wallet: { installed: ['xverse'] } });
    const orig = services.wallets.connect;
    services.wallets.connect = async () => Promise.reject(Object.assign(new Error('User rejected the request'), { code: 'USER_REJECTED' }));
    renderApp(services);
    await user.click(screen.getByRole('button', { name: 'Connect Xverse' }));
    expect(await screen.findByText('You cancelled the request in your wallet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Get a test wallet' })).toBeInTheDocument();
    services.wallets.connect = orig;
  });
});

describe('step 2: faucet', () => {
  it('shows the proof of work, then the faucet transaction on chain', async () => {
    const user = userEvent.setup();
    const services = fakes({ faucet: { difficulty: 10, latencyMs: 30 } });
    renderApp(services);
    await toCoins(user);
    expect(screen.getByTestId('onchain-coins')).toHaveTextContent('Your address');
    await user.click(screen.getByRole('button', { name: 'Get free test coins' }));
    await screen.findByRole('heading', { level: 1, name: 'Pick a small file' }, { timeout: 10_000 });
    expect(services.faucet.drips).toHaveLength(1);
  });

  it.each([
    ['faucet_empty', 'The faucet is empty right now'],
    ['address_rate_limited', 'This address already got test coins today'],
    ['ip_rate_limited', 'Too many requests from your network'],
    ['budget_exhausted', "Today's faucet budget is spent"],
    ['faucet_disabled', 'No faucet on this page'],
    ['wallet_unavailable', 'The faucet did not answer'],
    ['pow_invalid', 'The puzzle did not count'],
  ])('%s is explained in plain words', async (code, title) => {
    const user = userEvent.setup();
    const services = fakes({ faucet: { refuse: { code, message: 'x', retryAfterSeconds: 3600 } } });
    renderApp(services);
    await toCoins(user);
    await user.click(screen.getByRole('button', { name: 'Get free test coins' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(title);
    if (code.endsWith('rate_limited')) expect(alert).toHaveTextContent('60 minutes');
    expect(screen.getByRole('heading', { level: 1, name: 'Get free test coins' })).toBeInTheDocument();
    expect(services.faucet.drips).toHaveLength(0);
  });

  it('retry after a transient refusal works', async () => {
    const user = userEvent.setup();
    const services = fakes({ faucet: { refuse: { code: 'rate_limited', message: 'x' } } });
    renderApp(services);
    await toCoins(user);
    await user.click(screen.getByRole('button', { name: 'Get free test coins' }));
    await screen.findByRole('alert');
    services.faucet.options.refuse = undefined;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 1, name: 'Pick a small file' }, { timeout: 10_000 });
  });

  it('live mode without a faucet: explains, and "Check my balance" moves on once coins arrive', async () => {
    const user = userEvent.setup();
    const services = fakes({ faucet: { configured: false } });
    renderApp(services, { config: testConfig({ faucetUrl: '' }) });
    await toCoins(user);
    expect(screen.getByText('No faucet on this page')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check my balance' }));
    expect(await screen.findByText('No coins at this address yet.')).toBeInTheDocument();
    const addr = screen.getByTestId('onchain-coins').querySelector('a')!.textContent!;
    services.chain.credit(addr, 80_000);
    await user.click(screen.getByRole('button', { name: 'Check my balance' }));
    await screen.findByRole('heading', { level: 1, name: 'Pick a small file' });
  });
});

describe('step 3: file and quote', () => {
  it('shows the exact quote (weight, vsize, lane, fee rate, costs) before anything is signed', async () => {
    const user = userEvent.setup();
    const services = fakes({ chain: { feeRate: 2 } });
    renderApp(services);
    await toFile(user);
    expect(screen.getByRole('button', { name: 'Continue: commit and reveal' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'A tiny SVG badge' }));
    const q = await screen.findByTestId('quote');
    expect(q).toHaveTextContent('image/svg+xml');
    expect(q).toHaveTextContent(/\d[\d,]* WU/);
    expect(q).toHaveTextContent('standard');
    expect(q).toHaveTextContent('2 sat/vB');
    expect(within(q).getByTestId('total-sats').textContent).toMatch(/^[\d,]+$/);
    expect(services.chain.state.broadcasts.size).toBe(1); // only the drip
  });

  it('refuses a file over the limit with the reason and what to do', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { config: testConfig({ maxFileBytes: 100 }) });
    await toFile(user);
    await user.upload(screen.getByLabelText(/your own file/), new File(['x'.repeat(101)], 'big.txt', { type: 'text/plain' }));
    expect(await screen.findByText(/big\.txt is 101 B; the playground takes files up to 100 B/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue: commit and reveal' })).toBeDisabled();
  });

  it('quotes an uploaded file within the limit', async () => {
    const user = userEvent.setup();
    renderApp(fakes());
    await toFile(user);
    await user.upload(screen.getByLabelText(/your own file/), new File(['{"hello":"signet"}'], 'note.json', { type: 'application/json' }));
    expect(await screen.findByTestId('quote')).toHaveTextContent('note.json');
  });

  it('not enough test coins: explained before signing', async () => {
    const user = userEvent.setup();
    // A 12,000-sat drip is spendable (above the 10,000-sat inscription guard) but too small at 50 sat/vB.
    renderApp(fakes({ faucet: { dripSats: 12_000 }, chain: { feeRate: 50 } }));
    await toFile(user);
    await user.click(screen.getByRole('button', { name: 'A tiny SVG badge' }));
    expect(await screen.findByText(/Not enough spendable funds/)).toBeInTheDocument();
  });
});

describe('step 4: commit and reveal', () => {
  it('broadcast rejected: the node\'s reason, a hint, nothing moved, and a way back', async () => {
    const user = userEvent.setup();
    const services = fakes();
    renderApp(services);
    await toInscribe(user);
    services.chain.state.rejectBroadcast = 'min relay fee not met, 150 < 170';
    await user.click(screen.getByRole('button', { name: /Sign the commit/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The signet node refused the transaction');
    expect(alert).toHaveTextContent('min relay fee not met');
    expect(alert).toHaveTextContent('Rebuild the quote in step 3');
    expect(screen.getByRole('button', { name: /Sign the reveal/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Back to step 3' }));
    await screen.findByRole('heading', { level: 1, name: 'Pick a small file' });
  });

  it('reveal rejected after a good commit: the commit stays, the reveal can be retried', async () => {
    const user = userEvent.setup();
    const services = fakes();
    renderApp(services);
    await toInscribe(user);
    await user.click(screen.getByRole('button', { name: /Sign the commit/ }));
    await screen.findByText(/Commit broadcast/);
    services.chain.state.rejectBroadcast = 'non-mandatory-script-verify-flag';
    await user.click(screen.getByRole('button', { name: /Sign the reveal/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('non-mandatory-script-verify-flag');
    services.chain.state.rejectBroadcast = undefined;
    await user.click(screen.getByRole('button', { name: /Sign the reveal/ }));
    await screen.findByTestId('certificate');
  });

  it('wallet refuses to sign: explained, nothing broadcast', async () => {
    const user = userEvent.setup();
    const services = fakes({ wallet: { reject: true } });
    renderApp(services);
    await user.click(screen.getByRole('button', { name: 'Connect Xverse' }));
    await user.click(await screen.findByRole('button', { name: 'Get free test coins' }));
    await user.click(await screen.findByRole('button', { name: 'A line of text' }, { timeout: 10_000 }));
    await user.click(await screen.findByRole('button', { name: 'Continue: commit and reveal' }));
    await user.click(await screen.findByRole('button', { name: /Sign the commit with Xverse/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your wallet did not sign');
    expect(alert).toHaveTextContent('Nothing was signed or sent');
    expect(services.chain.state.broadcasts.size).toBe(1);
  });
});

describe('step 5: certificate and quiz', () => {
  async function toCertificate(user: User, services = fakes()) {
    renderApp(services);
    await toInscribe(user);
    await user.click(screen.getByRole('button', { name: /Sign the commit/ }));
    await screen.findByText(/Commit broadcast/);
    await user.click(screen.getByRole('button', { name: /Sign the reveal/ }));
    await screen.findByTestId('certificate');
    return services;
  }
  const answer = async (user: User, picks: number[]) => {
    for (const [i, q] of QUIZ.entries()) {
      const group = screen.getByRole('group', { name: new RegExp(q.prompt.replace(/[?']/g, '.')) });
      await user.click(within(group).getAllByRole('radio')[picks[i]!]!);
    }
    await user.click(screen.getByRole('button', { name: 'Check my answers' }));
  };

  it('passing the quiz; the only analytics event is anonymous (5 fields, no address, no txid)', async () => {
    const user = userEvent.setup();
    const services = await toCertificate(user);
    expect(screen.getByRole('button', { name: 'Check my answers' })).toBeDisabled();
    await answer(user, QUIZ.map((q) => q.answer));
    expect(await screen.findByText('3 of 3: you can explain what you did.')).toBeInTheDocument();
    expect(services.analytics.sent).toEqual([{ event: 'playground.quiz', version: '1', passed: true, score: 3, total: 3 }]);
    expect(screen.getByTestId('analytics-note')).toHaveTextContent('never sent');
  });

  it('failing the quiz shows why, and analytics off sends nothing', async () => {
    const user = userEvent.setup();
    const services = await toCertificate(user, fakes({ analytics: false }));
    await answer(user, QUIZ.map((q) => (q.answer + 1) % q.options.length));
    expect(await screen.findByText(/0 of 3/)).toBeInTheDocument();
    expect(screen.getAllByText(/Not quite/)).toHaveLength(3);
    expect(services.analytics.sent).toEqual([]);
    expect(screen.getByTestId('analytics-note')).toHaveTextContent('Nothing about your answers is sent anywhere.');
  });

  it('start over returns to step 1 with the timer reset', async () => {
    const user = userEvent.setup();
    await toCertificate(user);
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Get a test wallet' })).toBeInTheDocument());
    expect(screen.getByTestId('timer')).toHaveTextContent('Timer starts with step 1');
  });
});

describe('page twins', () => {
  it('?format=json renders the machine document', () => {
    renderApp(fakes(), { config: testConfig({ format: 'json' }) });
    const doc = JSON.parse(screen.getByTestId('json-twin').textContent!);
    expect(doc.steps).toHaveLength(5);
    expect(doc.network).toBe('signet');
    expect(doc.wallets.signet.length).toBeGreaterThan(0);
    expect(doc.endpoints.analytics).toBe('off');
  });
});
