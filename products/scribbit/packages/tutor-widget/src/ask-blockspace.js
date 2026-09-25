// <ask-blockspace> — a framework-free web component (Shadow DOM) that asks the Ask Blockspace API and shows a
// grounded answer with citations. Offline `fixture` mode needs no server. Under 30 KB, no dependencies.
//
//   <ask-blockspace api-base="https://tutor.example"></ask-blockspace>
//   <ask-blockspace fixture></ask-blockspace>   <!-- offline demo -->
//
// Attributes:
//   api-base  Base URL of the Ask Blockspace API (POST {base}/v1/ask). Omitted → fixture mode.
//   fixture   Boolean: force the bundled offline fixtures even if api-base is set.
//   heading   Optional heading text (default "Ask Blockspace").
//
// It never asks for keys and never mentions prices on its own; guardrails live in the API. All API text is
// inserted as textContent (never innerHTML), so a response cannot inject markup.
import { fixtureAnswer } from './fixtures.js';

/** @typedef {import('./fixtures.js').AskResponse} AskResponse */

const SUGGESTIONS = ['What is the witness discount?', 'How big can an inscription be?', 'How is a fee rate calculated?'];

const STYLE = `
:host { all: initial; display: block; container-type: inline-size;
  --bg: #ffffff; --fg: #1a1c20; --muted: #55606b; --line: #d7dde3; --card: #f5f7f9;
  --accent: #0b6b5e; --accent-fg: #ffffff; --focus: #0b6b5e;
  --warn-bg: #fbecec; --warn-fg: #8a1f18; --warn-line: #e6b4b0;
  --chip-bg: #eef2f4; --chip-fg: #1a3d38;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  color: var(--fg); }
@media (prefers-color-scheme: dark) {
  :host { --bg: #14171a; --fg: #eef1f4; --muted: #a3adb7; --line: #2b3138; --card: #1b1f24;
    --accent: #3fd0b8; --accent-fg: #08201c; --focus: #3fd0b8;
    --warn-bg: #3a1c1a; --warn-fg: #ffb4ac; --warn-line: #6b2b26;
    --chip-bg: #21272d; --chip-fg: #bfeee6; } }
* { box-sizing: border-box; }
.wrap { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 16px; max-width: 100%; }
h2 { font-size: 1.1rem; line-height: 1.3; margin: 0 0 4px; }
.tag { color: var(--muted); font-size: .8rem; margin: 0 0 12px; }
form { display: flex; gap: 8px; flex-wrap: wrap; }
label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
input { flex: 1 1 12rem; min-width: 0; padding: 10px 12px; font-size: 1rem; color: var(--fg);
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
button { padding: 10px 14px; font-size: 1rem; border: 1px solid var(--accent); border-radius: 8px;
  background: var(--accent); color: var(--accent-fg); cursor: pointer; }
button.chip { background: var(--chip-bg); color: var(--chip-fg); border-color: var(--line); font-size: .85rem; padding: 6px 10px; }
button:disabled { opacity: .6; cursor: progress; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; }
.result { margin-top: 16px; }
.badge { display: inline-block; font-size: .72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted); }
.badge.grounded { color: var(--chip-fg); background: var(--chip-bg); border-color: var(--line); }
.badge.weak { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-line); }
.badge.refused { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-line); }
.answer { margin: 10px 0; line-height: 1.55; white-space: pre-wrap; }
.answer.refused { border-left: 3px solid var(--warn-line); padding-left: 12px; }
.note { color: var(--muted); font-size: .8rem; margin: 6px 0 0; }
.cites { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.cites li { font-size: .85rem; }
.cites a { color: var(--accent); text-decoration: underline; word-break: break-word; }
.cites .src { color: var(--muted); }
.facts { margin: 12px 0 0; padding: 10px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; font-size: .85rem; }
.facts h3 { margin: 0 0 6px; font-size: .82rem; }
.facts .t { color: var(--muted); }
.err { color: var(--warn-fg); }
@media (prefers-reduced-motion: no-preference) { .result { transition: opacity .15s ease; } }
`;

export class AskBlockspaceElement extends HTMLElement {
  static get observedAttributes() {
    return ['api-base', 'fixture', 'heading'];
  }

  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._busy = false;
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    if (this._root.childElementCount) this._render();
  }

  get apiBase() {
    return this.getAttribute('api-base') || '';
  }

  get fixtureMode() {
    return this.hasAttribute('fixture') || !this.apiBase;
  }

  _render() {
    const heading = this.getAttribute('heading') || 'Ask Blockspace';
    this._root.innerHTML = `<style>${STYLE}</style>
      <section class="wrap" part="wrap">
        <h2>${escapeHtml(heading)}</h2>
        <p class="tag">Grounded answers about Bitcoin blockspace, with citations. No price advice, never your keys.${this.fixtureMode ? ' <em>Offline demo.</em>' : ''}</p>
        <form part="form">
          <label for="q">Your blockspace question</label>
          <input id="q" name="q" type="text" autocomplete="off" placeholder="e.g. what is the witness discount?" maxlength="2000" />
          <button type="submit" part="ask">Ask</button>
        </form>
        <div class="chips" role="group" aria-label="Example questions"></div>
        <div class="result" role="region" aria-live="polite" aria-label="Answer"></div>
      </section>`;

    const chips = /** @type {HTMLElement} */ (this._root.querySelector('.chips'));
    for (const s of SUGGESTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = s;
      b.addEventListener('click', () => {
        /** @type {HTMLInputElement} */ (this._root.getElementById('q')).value = s;
        this._submit(s);
      });
      chips.appendChild(b);
    }

    /** @type {HTMLFormElement} */ (this._root.querySelector('form')).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = /** @type {HTMLInputElement} */ (this._root.getElementById('q')).value.trim();
      if (v) this._submit(v);
    });
  }

  /** @param {string} question */
  async _submit(question) {
    if (this._busy) return;
    this._busy = true;
    const btn = /** @type {HTMLButtonElement} */ (this._root.querySelector('button[type=submit]'));
    btn.disabled = true;
    const region = /** @type {HTMLElement} */ (this._root.querySelector('.result'));
    region.textContent = 'Thinking…';
    try {
      const res = this.fixtureMode ? fixtureAnswer(question) : await this._fetch(question);
      this._renderResult(res);
      this.dispatchEvent(new CustomEvent('answer', { detail: res, bubbles: true, composed: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      region.replaceChildren(el('p', 'err', `Could not reach the Ask Blockspace API: ${msg}`));
    } finally {
      this._busy = false;
      btn.disabled = false;
    }
  }

  /** @param {string} question @returns {Promise<AskResponse>} */
  async _fetch(question) {
    const url = `${this.apiBase.replace(/\/+$/, '')}/v1/ask`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, includeLiveFacts: true }) });
    if (!r.ok) {
      let code = String(r.status);
      try {
        code = (await r.json())?.error?.code || code;
      } catch { /* ignore */ }
      throw new Error(code);
    }
    return r.json();
  }

  /** @param {AskResponse} res */
  _renderResult(res) {
    const region = /** @type {HTMLElement} */ (this._root.querySelector('.result'));
    const g = res.refused ? 'refused' : res.groundedness;
    const badge = el('span', `badge ${g}`, g === 'grounded' ? 'grounded' : g === 'weak' ? 'not sure' : 'declined');

    const answer = el('p', `answer${res.refused ? ' refused' : ''}`, res.answer);
    if (res.refused) answer.setAttribute('role', 'alert');

    const nodes = [badge, answer];
    if (res.groundednessNote) nodes.push(el('p', 'note', res.groundednessNote + (res.model ? ` · ${res.model}` : '')));

    if (res.citations && res.citations.length) {
      const ul = document.createElement('ul');
      ul.className = 'cites';
      ul.setAttribute('aria-label', 'Sources');
      for (const c of res.citations) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = c.url;
        a.textContent = c.title;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
        li.appendChild(el('span', 'src', ` — ${c.type}${c.section ? ' · ' + c.section : ''}`));
        ul.appendChild(li);
      }
      nodes.push(el('p', 'note', 'Sources'), ul);
    }

    if (res.liveFacts && res.liveFacts.length) {
      const box = document.createElement('div');
      box.className = 'facts';
      box.appendChild(el('h3', '', 'Live chain facts'));
      for (const f of res.liveFacts) {
        box.appendChild(el('div', '', `${f.label}: ${f.value}`));
      }
      const f0 = res.liveFacts[0];
      if (f0) box.appendChild(el('div', 't', `as of ${f0.observedAt} · ${f0.source}`));
      nodes.push(box);
    }

    region.replaceChildren(...nodes);
  }
}

/** @param {string} tag @param {string} cls @param {string} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function escapeHtml(/** @type {string} */ s) {
  /** @type {Record<string, string>} */
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/** Register the element (idempotent). Auto-runs on import in a browser. */
export function defineAskBlockspace(tag = 'ask-blockspace') {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, AskBlockspaceElement);
}

defineAskBlockspace();
