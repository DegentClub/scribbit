# @bsh/blockspace-tutor-widget — agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **library**, but authored as browser-native **ES-module JavaScript** (`src/*.js`) so the same file runs
  in the browser, the demo page and the jsdom tests with no build step. Types are checked with `tsc --checkJs`.
- Keep it **dependency-free and under 30 KB**. No framework, no bundler. Shadow DOM only; never leak styles.
- **All API/response text goes in via `textContent`**, never `innerHTML` — a response must not be able to inject
  markup. Keep it that way.
- The widget owns no policy: guardrails and grounding live in `@bsh/blockspace-tutor-kb` behind the API. The
  fixtures in `src/fixtures.js` are labelled demo data.
- The demo page loads ES modules, which browsers refuse over `file://` (CORS). The render test serves the
  package over http; do the same if you preview it.
- Verify with `pnpm --filter @bsh/blockspace-tutor-widget test` (jsdom + a real Chromium render at 390/1280,
  light/dark) and `typecheck`. Look at `docs/screenshots/` after changing anything visual.
