# @bsh/scribbit-cli

`scribbit` is a developer CLI for scribb.it, built on [`@bsh/inscription`](../../../../platform/inscription)
(exact envelope, weight and fee maths) and [`@bsh/scribbit-fee-oracle`](../../packages/fee-oracle). It quotes an
inscription exactly, dumps its tapscript, derives commit addresses, and builds the self-rescue transaction
from a half-signed reveal. It never holds keys that move funds and never broadcasts anything.

```bash
pnpm --filter @bsh/scribbit-cli scribbit quote art.webp --parent <txid>i0 --fee-rate 2.5
pnpm --filter @bsh/scribbit-cli test
pnpm --filter @bsh/scribbit-cli typecheck
# or via the bin: products/scribbit/apps/cli/bin/scribbit.mjs <command> ...
```

## Quickstart

From the repository root:

```bash
pnpm install
echo 'hello, block space' > hello.txt
node products/scribbit/apps/cli/bin/scribbit.mjs quote hello.txt --fee-rate 2 --network signet
# envelope      89 bytes, 1 body chunk(s)
# reveal        569 WU / 143 vB (single layout)
# lane          standard
# reveal fee    286 sats
# postage       546 sats
# commit value  832 sats  <- fund the commit address with exactly this
node products/scribbit/apps/cli/bin/scribbit.mjs envelope hello.txt --json   # one JSON object, for scripts
```

(`pnpm --filter @bsh/scribbit-cli scribbit ...` works too, but then relative paths resolve from the package
directory: pass absolute paths.)

## Commands

| Command | What it prints |
|---|---|
| `quote <file> [--parent <id>] [--fee-rate n \| --fee-source url] [--network net] [--tier slow\|normal\|fast] [--recipient addr] [--postage sats]` | Exact reveal weight and vsize (`estimateRevealWeight`), lane, fee rate and where it came from, reveal fee, postage, and **commit value** (`quoteReveal`). With `--parent`, it also prints the rescue layout: same fee, 402 WU lighter, with its effective rate |
| `envelope <file> [--parent] [--metadata f] [--pubkey xonly] [--hex]` | Tapscript size, sha256, an annotated op layout (header, tags, body chunks), a push-opcode histogram, and head/tail hex (`--hex` prints all of it) |
| `commit-address <file> --pubkey <xonly> --network <net> [--parent <id>]` | P2TR commit address, scriptPubKey, NUMS internal key, tapleaf hash, control block |
| `rescue --psbt <b64 \| @file \| ->` | Finalizes the half-signed PSBT into the no-parent rescue transaction: hex, txid, inscription id, weight, vsize |

Shared content flags: `--content-type` (inferred from the extension otherwise), `--parent`, `--metadata`.
Every command takes `--json`, which prints exactly one JSON object on stdout: `{"ok":true,"command":...}`
on success, or `{"ok":false,"exitCode":n,"error":{"code","message","details?"}}` on failure. Sats are JSON
numbers.

### Fee rate selection (`quote`)

1. If `--fee-rate` is given, it is used as is, and no network call is made.
2. Otherwise `--fee-source <url>` is used. A URL ending in `/v1/fees` is treated as a scribb.it fee server
   (`contracts/openapi/scribbit-fees.yaml`). Any other URL is treated as a mempool.space-compatible base
   (e.g. `https://mempool.space/signet`), and the CLI aggregates `/api/v1/fees/recommended` and
   `/api/v1/fees/mempool-blocks` in-process with `@bsh/scribbit-fee-oracle`.
3. If neither flag is given, the CLI uses the public mempool.space for the network. regtest has no public
   source, so it needs `--fee-rate`.

Standard-lane reveals use `standard.<tier>` (default `normal`). Block-lane reveals use
`block.recommended`, and the output warns that they need a non-standard broadcaster.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | failure: fee source unreachable, internal error |
| 2 | usage: unknown command or option, missing or malformed value (network, pubkey, parent id, address, fee rate…) |
| 3 | input rejected: unreadable file, reveal too large for any lane, invalid or unsigned PSBT |

## Design

- The argument parser is plain code with no framework (`src/args.ts`). It supports `--flag value`,
  `--flag=value`, `--` and `-h`, rejects repeated flags, and suggests the closest match for an unknown
  option.
- Every side effect goes through the `CliIO` port (`src/io.ts`): stdout, stderr, file reads, stdin and
  `fetch`. `run(argv, io)` returns the exit code and never calls `process.exit`.
- Tests (`test/*.test.ts`) run the CLI in-process with a virtual filesystem and fake fee sources, so they
  make no network calls. `quote.test.ts` checks the `@bsh/inscription` README size table. It also builds,
  signs and finalizes real reveals (parent layout via `attachParent`/`signParentInput`, rescue layout via
  `scribbit rescue`) for bodies of 1, 520, 521, 10k and 400k bytes, and asserts that the quoted weights,
  vsizes and fees match them exactly.
