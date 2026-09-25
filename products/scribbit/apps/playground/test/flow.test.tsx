import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GOAL_SECONDS } from '@bsh/scribbit-playground-kit';
import { extractInscriptionBody } from '@bsh/scribbit-mint/src/services/fakes';
import { fakes, renderApp } from './helpers';
import type { FakeServices } from '../src/services/fakes';

type User = ReturnType<typeof userEvent.setup>;

/** The scripted demo path: the same clicks a first-time visitor makes. */
export async function scriptedPath(user: User, sample = 'A line of text') {
  await user.click(screen.getByRole('button', { name: 'Make a throwaway test key' }));
  await screen.findByRole('heading', { level: 1, name: 'Get free test coins' });
  await user.click(screen.getByRole('button', { name: 'Get free test coins' }));
  await screen.findByRole('heading', { level: 1, name: 'Pick a small file' }, { timeout: 10_000 });
  await user.click(screen.getByRole('button', { name: sample }));
  await screen.findByTestId('quote');
  await user.click(screen.getByRole('button', { name: 'Continue: commit and reveal' }));
  await screen.findByRole('heading', { level: 1, name: 'Commit and reveal' });
  await user.click(screen.getByRole('button', { name: /Sign the commit with your test key/ }));
  await screen.findByText(/Commit broadcast/);
  await user.click(screen.getByRole('button', { name: /Sign the reveal with your test key/ }));
  await screen.findByRole('heading', { level: 1, name: 'Your certificate' });
}

describe('the whole demo flow (throwaway key, fake faucet/chain, real maths and signatures)', () => {
  it('goes through the five steps and writes the exact bytes into a real, signed reveal', async () => {
    const user = userEvent.setup();
    const services: FakeServices = fakes();
    const { store } = renderApp(services);
    expect(screen.getByRole('note', { name: 'Test network warning' })).toHaveTextContent('TEST NETWORK');
    expect(screen.getByRole('heading', { level: 1, name: 'Get a test wallet' })).toBeInTheDocument();
    await scriptedPath(user);

    // The key lived in the (session) store only, tagged signet.
    const rec = JSON.parse([...(store as unknown as { map: Map<string, string> }).map.values()][0]!);
    expect(rec.network).toBe('signet');

    // Faucet drip + commit + reveal all went through the fake chain's UTXO set.
    expect(services.faucet.drips).toHaveLength(1);
    const raws = [...services.chain.state.broadcasts.values()].filter(Boolean);
    expect(raws).toHaveLength(2);
    const body = extractInscriptionBody(raws[1]!);
    expect(new TextDecoder().decode(body!)).toBe('Hello from the scribb.it Signet Playground. My first inscription, on a test network.');

    const cert = screen.getByTestId('certificate');
    const id = within(cert).getByTestId('inscription-id').textContent!;
    expect(id).toMatch(/^[0-9a-f]{64}i0$/);
    expect(services.chain.state.broadcasts.has(id.slice(0, 64))).toBe(true);
    // Links: signet ord explorer, signet tx explorer, X-Ray.
    expect(within(cert).getByRole('link', { name: /ord explorer/ })).toHaveAttribute('href', `https://signet.ordinals.com/inscription/${id}`);
    expect(within(cert).getByRole('link', { name: /Reveal on the signet explorer/ })).toHaveAttribute('href', `https://mempool.space/signet/tx/${id.slice(0, 64)}`);
    expect(within(cert).getByRole('link', { name: /X-Ray/ })).toHaveAttribute('href', `https://block.space/xray/${id.slice(0, 64)}`);
    // The on-screen banner never left.
    expect(screen.getByRole('note', { name: 'Test network warning' })).toBeInTheDocument();
  });

  it('timing: the scripted path completes all five steps inside the five-minute goal and the certificate says so', async () => {
    const user = userEvent.setup();
    const t0 = performance.now();
    renderApp(fakes());
    await scriptedPath(user, 'A tiny SVG badge');
    const wallSeconds = (performance.now() - t0) / 1000;
    expect(wallSeconds).toBeLessThan(GOAL_SECONDS);
    // The app's own clock agrees (it measures from the first click to the reveal).
    const shown = screen.getByTestId('elapsed').textContent!;
    const [m, s] = shown.split(':').map(Number);
    expect(m! * 60 + s!).toBeLessThan(GOAL_SECONDS);
    expect(screen.getByTestId('certificate')).toHaveTextContent('inside the five-minute goal');
    expect(screen.getByTestId('timer')).toHaveTextContent('Finished in');
  });

  it('a slow run is told the truth: past five minutes the certificate does not claim the goal', async () => {
    const user = userEvent.setup();
    let t = 1_000_000;
    const services = fakes();
    renderApp(services, { now: () => t });
    await user.click(screen.getByRole('button', { name: 'Make a throwaway test key' }));
    t += 301_000;
    await user.click(await screen.findByRole('button', { name: 'Get free test coins' }));
    await user.click(await screen.findByRole('button', { name: 'A line of text' }, { timeout: 10_000 }));
    await user.click(await screen.findByRole('button', { name: 'Continue: commit and reveal' }));
    await user.click(await screen.findByRole('button', { name: /Sign the commit/ }));
    await screen.findByText(/Commit broadcast/);
    await user.click(screen.getByRole('button', { name: /Sign the reveal/ }));
    await screen.findByTestId('certificate');
    expect(screen.getByTestId('elapsed')).toHaveTextContent('5:01');
    expect(screen.getByTestId('certificate')).toHaveTextContent('The goal is five minutes');
  });

  it('works with a real wallet on signet via wallet-kit (fake UniSat that really signs)', async () => {
    const user = userEvent.setup();
    const services = fakes();
    renderApp(services);
    await user.click(screen.getByRole('button', { name: 'Connect UniSat' }));
    await screen.findByRole('heading', { level: 1, name: 'Get free test coins' });
    await user.click(screen.getByRole('button', { name: 'Get free test coins' }));
    await user.click(await screen.findByRole('button', { name: 'A line of text' }, { timeout: 10_000 }));
    await user.click(await screen.findByRole('button', { name: 'Continue: commit and reveal' }));
    await user.click(await screen.findByRole('button', { name: /Sign the commit with UniSat/ }));
    await screen.findByText(/Commit broadcast/);
    await user.click(screen.getByRole('button', { name: /Sign the reveal with UniSat/ }));
    await waitFor(() => expect(screen.getByTestId('certificate')).toBeInTheDocument());
    expect(services.wallets.sessions[0]!.network).toBe('signet');
    expect(screen.getByTestId('certificate')).toHaveTextContent('UniSat');
  });
});
