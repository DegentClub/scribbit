# @bsh/scribbit-playground-kit

The shared words and rules of the **Signet Playground** (ADR-0009): the five step explanations, the glossary and
the three-question quiz, plus the faucet's SHA-256 proof-of-work rule. One source, three readers: the playground
app renders the explanations, the MCP server serves them through `playground_explain_step`, and the signet faucet
verifies the proof of work the app's Web Worker produces. It holds no key, does no I/O and knows nothing about
networks beyond words.

## Quickstart

In a scribbit workspace package: add `"@bsh/scribbit-playground-kit": "workspace:*"` to `package.json` and
`"@bsh/scribbit-playground-kit"` to `depends_on` in `component.yaml`, then:

```ts
import { explainStep, scoreQuiz, QUIZ, solvePow, verifyPow } from '@bsh/scribbit-playground-kit';

const step = explainStep('coins');            // or explainStep(2)
console.log(step.title, step.glossary.map((g) => g.term));

const { solution } = solvePow('00ff…nonce', 'tb1p…address', 12);
console.log(verifyPow({ nonce: '00ff…nonce', address: 'tb1p…address', solution, difficulty: 12 })); // true

console.log(scoreQuiz(QUIZ.map((q) => q.answer)).passed);  // true
```

```bash
pnpm --filter @bsh/scribbit-playground-kit test        # 21 tests: PoW vectors + properties, content integrity
pnpm --filter @bsh/scribbit-playground-kit typecheck
```

## What is in it

| Export | What |
|---|---|
| `STEPS`, `STEP_IDS`, `stepContent`, `explainStep` | The five steps (`wallet`, `coins`, `file`, `inscribe`, `certificate`): title, summary, 2-4 explanation paragraphs, the "what just happened on chain" line, safety line, glossary ids. `explainStep` expands the glossary and accepts `1..5`, an id or `"3"` |
| `GLOSSARY`, `glossaryEntry` | Terms with stable ids (used as `#term-<id>` anchors) |
| `QUIZ`, `scoreQuiz` | Three questions; pass = all three right |
| `playgroundDocument()` | Everything above as one JSON document (the page's `playground.json` twin) |
| `GOAL_SECONDS` (300), `DEFAULT_MAX_FILE_BYTES` (51,200), `PLAYGROUND_VERSION` | Shared constants |
| `POW_ALGORITHM`, `powDigest`, `leadingZeroBits`, `verifyPow`, `solvePow`, `solvePowSlice`, `expectedHashes` | The proof-of-work rule below |

## The proof-of-work rule

```
digest   = SHA-256( UTF-8( "scribbit-faucet-pow/v1:" + nonce + ":" + address + ":" + solution ) )
accepted = leadingZeroBits(digest) >= difficulty          (difficulty 1..32; solution: decimal, ≤ 20 digits, no leading zeros)
```

Expected work is `2^difficulty` hashes (20 bits ≈ 1,048,576); verification is one hash. The address is part of
the message, so work done for one address cannot fund another; the nonce is single-use on the server. Numbers in
the tests are illustrative vectors, not measurements of any particular device.

## Limits and honesty

- Protocol numbers in the text (4,000,000 WU per block, 400,000 WU standard transaction, 4 WU per non-witness byte,
  1 WU per witness byte, 520-byte pushes, 330-sat P2TR dust) are asserted by `test/content.test.ts`; no text
  talks about prices (also asserted).
- The explanations say signet blocks arrive "about every ten minutes": that is signet's target, not a guarantee.

## Interfaces

- Depends on: nothing in the workspace (`@noble/hashes` only).
- Consumed by `@bsh/scribbit-playground` (app), `@bsh/scribbit-signet-faucet` (PoW verification) and
  `@bsh/scribbit-mcp` (`playground_explain_step`).
