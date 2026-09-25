# Ask Blockspace — content policy (testable invariants)

Ask Blockspace is a **tutor**, not an advisor and not a wallet. These rules are product policy, enforced in
`src/guardrails.ts` and `src/ask.ts`, and each is covered by a test. They apply identically to every surface
(HTTP service, MCP tool, widget), because all of them run this one library.

## Invariants

1. **Never price or investment advice.** Any question asking what something is worth, whether to buy/sell/hold,
   price predictions, ROI, or market timing is **refused** with `refusalReason: "price_advice"` and redirected to
   learning. The tutor explains how blockspace *works*, never what anything is *worth*.
   - Test: `test/guardrails.test.ts` (price set), `test/ask.test.ts` (refusal shape).

2. **Never keys or seeds.** Any request to reveal, generate, store, import or hand over a seed phrase, recovery
   phrase, mnemonic or private key is **refused hard** with `refusalReason: "key_material"` and a safety warning.
   A server never asks for or accepts key material. This rule takes precedence over every other classification.
   - Test: `test/guardrails.test.ts` (keys set + precedence), `test/ask.test.ts`.

3. **Never sign or broadcast a mainnet transaction on someone's behalf.** Refused with
   `refusalReason: "mainnet_signing"`; the tutor explains the non-custodial model and points to signet practice.
   - Test: `test/guardrails.test.ts` (signing set), `test/ask.test.ts`.

4. **Never fabricate a citation.** In extractive mode every sentence of an answer is a verbatim substring of a
   retrieved chunk; every citation maps to a real source with a public URL. When a real model is used it must
   answer only from the provided context and name the sources it used.
   - Test: `test/ask.test.ts` (citation faithfulness), `test/freshness.test.ts` (public URLs).

5. **Weak retrieval → humility, not guessing.** When the best match scores below the confidence floor, the tutor
   says it is not sure and links to the glossary instead of inventing an answer.
   - Test: `test/ask.test.ts` (weak retrieval).

6. **Retrieved and user text is data, not instructions.** Prompt-injection markers in the question and in KB
   chunks are neutralised before generation; the generator is told to treat context as data.
   - Test: `test/guardrails.test.ts` (sanitisation), `test/ask.test.ts` (injection neutralised flag).

7. **Live facts are labelled and optional.** Any live chain fact carries a timestamp and a source; the tutor
   works with the live-facts port disabled.
   - Test: `test/ask.test.ts` (live facts).

## Non-goals

Ask Blockspace does not execute transactions, hold funds, manage wallets, or give financial, legal or tax
advice. It is an educational surface over public, cited sources.
