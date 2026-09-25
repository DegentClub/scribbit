# @bsh/blockspace-tutor-kb — agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **library**. It owns the Ask Blockspace knowledge base, retrieval, guardrails and answering core. The
  tutor service and the MCP `ask_blockspace` tool both consume it — change policy HERE, once.
- **Guardrails are product policy** (`POLICY.md`). Every rule has a test; do not weaken one without updating
  `POLICY.md` and the tests together.
- **No model id is hardcoded.** The real adapter (`src/chat-anthropic.ts`) reads base URL, key and model id from
  env; the default is the offline `ExtractiveChatPort`. Keep it that way.
- **The index is committed and must stay fresh.** After editing anything under `sources/`, run
  `pnpm --filter @bsh/blockspace-tutor-kb refresh`; the freshness test fails otherwise. Re-pull upstream with the
  `snapshot` script (needs `PORTAL_DIR` + `SPECS_DIR`).
- Keep the public API in `src/index.ts`. Verify with `pnpm --filter @bsh/blockspace-tutor-kb test` and
  `typecheck` before finishing.
