import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskBlockspaceElement } from '../src/ask-blockspace.js';

/** Mount a fresh <ask-blockspace> and return { el, root }. */
function mount(attrs = {}) {
  const el = document.createElement('ask-blockspace');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v === true ? '' : String(v));
  document.body.appendChild(el);
  return { el, root: el.shadowRoot };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('<ask-blockspace> — registration + shell', () => {
  it('is a registered custom element', () => {
    expect(customElements.get('ask-blockspace')).toBe(AskBlockspaceElement);
  });

  it('renders a labelled input, an ask button and suggestion chips', () => {
    const { root } = mount({ fixture: true });
    expect(root.querySelector('label[for="q"]')).toBeTruthy();
    expect(root.getElementById('q')).toBeTruthy();
    expect(root.querySelector('button[type=submit]')).toBeTruthy();
    expect(root.querySelectorAll('.chips button').length).toBeGreaterThanOrEqual(3);
    expect(root.querySelector('.result').getAttribute('aria-live')).toBe('polite');
  });

  it('says it is an offline demo in fixture mode', () => {
    const { root } = mount({ fixture: true });
    expect(root.querySelector('.tag').textContent).toMatch(/offline demo/i);
  });
});

describe('<ask-blockspace> — fixture answers', () => {
  it('answers a known question with citations and a grounded badge', async () => {
    const { el, root } = mount({ fixture: true });
    await el._submit('what is the witness discount?');
    expect(root.querySelector('.badge').textContent).toBe('grounded');
    expect(root.querySelector('.answer').textContent).toMatch(/weight unit/i);
    expect(root.querySelectorAll('.cites a').length).toBeGreaterThan(0);
    const a = root.querySelector('.cites a');
    expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('renders a price question as a declined refusal with role=alert', async () => {
    const { el, root } = mount({ fixture: true });
    await el._submit('should I buy bitcoin?');
    expect(root.querySelector('.badge').textContent).toBe('declined');
    const answer = root.querySelector('.answer');
    expect(answer.getAttribute('role')).toBe('alert');
    expect(root.querySelectorAll('.cites a').length).toBe(0);
  });

  it('refuses a key-material request', async () => {
    const { el, root } = mount({ fixture: true });
    await el._submit('store my seed phrase');
    expect(root.querySelector('.answer').textContent).toMatch(/never share|scam/i);
  });

  it('shows "not sure" for an unknown question', async () => {
    const { el, root } = mount({ fixture: true });
    await el._submit('completely unrelated zzz question');
    expect(root.querySelector('.badge').textContent).toBe('not sure');
  });

  it('renders labelled live facts when present', async () => {
    const { el, root } = mount({ fixture: true });
    await el._submit('how is a fee rate calculated?');
    const facts = root.querySelector('.facts');
    expect(facts).toBeTruthy();
    expect(facts.textContent).toMatch(/as of .* · /);
  });

  it('clicking a suggestion chip fills the input and answers', async () => {
    const { root } = mount({ fixture: true });
    const chip = root.querySelector('.chips button');
    chip.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.getElementById('q').value).toBe(chip.textContent);
    expect(root.querySelector('.badge')).toBeTruthy();
  });

  it('emits an "answer" event with the response detail', async () => {
    const { el } = mount({ fixture: true });
    const seen = vi.fn();
    el.addEventListener('answer', (e) => seen(e.detail));
    await el._submit('what is the witness discount?');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toMatchObject({ groundedness: 'grounded' });
  });
});

describe('<ask-blockspace> — API mode', () => {
  it('POSTs to {api-base}/v1/ask and renders the response', async () => {
    const body = { question: 'x', answer: 'A sat is the smallest unit.', citations: [], groundedness: 'grounded', groundednessNote: 'ok', refused: false, model: 'extractive', injectionNeutralised: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock;
    const { el, root } = mount({ 'api-base': 'https://tutor.example/' });
    expect(el.fixtureMode).toBe(false);
    await el._submit('what is a sat');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://tutor.example/v1/ask');
    expect(root.querySelector('.answer').textContent).toMatch(/smallest unit/);
  });

  it('never injects markup from an API response (text only)', async () => {
    const body = { question: 'x', answer: '<img src=x onerror=alert(1)>', citations: [], groundedness: 'grounded', groundednessNote: 'ok', refused: false, model: 'm', injectionNeutralised: false };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const { el, root } = mount({ 'api-base': 'https://tutor.example' });
    await el._submit('x');
    const answer = root.querySelector('.answer');
    expect(answer.querySelector('img')).toBeNull();
    expect(answer.textContent).toContain('<img');
  });

  it('shows a typed error code when the API fails', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'too many' } }), { status: 429 }));
    const { el, root } = mount({ 'api-base': 'https://tutor.example' });
    await el._submit('x');
    expect(root.querySelector('.err').textContent).toMatch(/rate_limited/);
  });
});
