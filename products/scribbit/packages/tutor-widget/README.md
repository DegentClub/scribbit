# @bsh/blockspace-tutor-widget

A tiny, framework-free **`<ask-blockspace>`** web component that drops the Ask Blockspace tutor into any page.
Shadow DOM (no style bleed), no dependencies, under 30 KB, and an **offline fixture mode** so it renders with no
server. It talks to the [Ask Blockspace API](../../services/tutor) (`@bsh/blockspace-tutor`) and inherits its
policy: grounded answers with citations, never price advice, never keys. Design:
[ADR-0012](../../../../docs/adr/0012-ask-blockspace-retrieval-grounded-tutor.md).

## Quickstart

Open the demo (offline, no build):

```bash
# any static server rooted at this package works; ES modules need http, not file://
python3 -m http.server -d products/scribbit/packages/tutor-widget 8080
# → http://localhost:8080/demo/index.html
```

Embed it in your own page against a live API:

```html
<script type="module" src="https://cdn.example/ask-blockspace.js"></script>
<ask-blockspace api-base="https://tutor.example"></ask-blockspace>
```

Offline demo (bundled fixtures, no server):

```html
<ask-blockspace fixture></ask-blockspace>
```

## Portal embed snippet (Build/Learn area)

Add this where the portal wants the tutor (host the module from your static asset origin and point `api-base`
at the deployed Ask Blockspace API). This is **documentation only** — this package does not modify the portal.

```html
<!-- Ask Blockspace tutor widget -->
<script type="module" src="/assets/ask-blockspace.js"></script>
<ask-blockspace api-base="https://tutor.blockspace.holdings" heading="Ask Blockspace"></ask-blockspace>
```

## What / why

- **What:** one custom element that renders a question box, suggestion chips, and a grounded answer with
  citations, a groundedness badge, refusal notices, and labelled live facts.
- **Why:** put the tutor in front of people (portal Build/Learn), reusing the same API and guardrails the MCP
  tool uses — no framework, no bundler, no lock-in.

## Configuration (attributes)

| Attribute | Default | Meaning |
|---|---|---|
| `api-base` | _(none)_ | Base URL of the Ask Blockspace API; the widget POSTs to `{api-base}/v1/ask`. Omit → fixture mode. |
| `fixture` | _(absent)_ | Boolean; force the bundled offline fixtures even when `api-base` is set. |
| `heading` | `Ask Blockspace` | Heading text shown at the top. |

Events: emits a DOM `answer` event (`bubbles`, `composed`) with the API response as `detail`.

## Accessibility

Keyboard reachable (Enter submits, chips are buttons), visible focus rings, `aria-live="polite"` results,
`role="alert"` on refusals, respects `prefers-reduced-motion`, and WCAG AA contrast in light and dark. All API
text is inserted as `textContent` (never `innerHTML`), so a response cannot inject markup.

## Limits

- English UI; the answer text comes from the API (English KB today).
- Fixture mode knows only a handful of example questions — it is a demo, not the full KB.
- Renders best in evergreen browsers (custom elements, Shadow DOM, `container-type`).

## Use

```bash
pnpm --filter @bsh/blockspace-tutor-widget test        # jsdom component tests + a real Chromium render
pnpm --filter @bsh/blockspace-tutor-widget typecheck   # tsc --checkJs over the JS source
```

Screenshots from the render test land in `docs/screenshots/` (390/1280 px, light/dark). `demo/llms.txt` is the
widget's machine-readable guide, served next to the demo page; the API serves its own `/llms.txt` twin.
