# @bsh/scribbit-cli

`scribbit` is a developer CLI for scribb.it, built on [`@bsh/inscription`](../../../../platform/inscription)
(exact envelope, weight and fee maths), [`@bsh/scribbit-fee-oracle`](../../packages/fee-oracle) and
[`@bsh/mesh`](../../../../platform/mesh) (checkpoint heads and inclusion proofs). It quotes an inscription
exactly, dumps its tapscript, derives commit addresses, builds the self-rescue transaction from a half-signed
reveal, and quotes a mesh checkpoint head as an anchor inscription. It never holds keys that move funds and
never broadcasts anything.

```bash
pnpm --filter @bsh/scribbit-cli scribbit quote art.webp --parent <txid>i0 --fee-rate 2.5
pnpm --filter @bsh/scribbit-cli test
pnpm --filter @bsh/scribbit-cli typecheck
# or via the bin: products/scribbit/apps/cli/bin/scribbit.mjs <command> ...
```

## Commands

| Command | What it prints |
|---|---|
| `quote <file> [--parent <id>] [--fee-rate n \| --fee-source url] [--network net] [--tier slow\|normal\|fast] [--recipient addr] [--postage sats]` | Exact reveal weight and vsize (`estimateRevealWeight`), lane, fee rate and where it came from, reveal fee, postage, and **commit value** (`quoteReveal`). With `--parent`, it also prints the rescue layout: same fee, 402 WU lighter, with its effective rate |
| `envelope <file> [--parent] [--metadata f] [--pubkey xonly] [--hex]` | Tapscript size, sha256, an annotated op layout (header, tags, body chunks), a push-opcode histogram, and head/tail hex (`--hex` prints all of it) |
| `commit-address <file> --pubkey <xonly> --network <net> [--parent <id>]` | P2TR commit address, scriptPubKey, NUMS internal key, tapleaf hash, control block |
| `rescue --psbt <b64 \| @file \| ->` | Finalizes the half-signed PSBT into the no-parent rescue transaction: hex, txid, inscription id, weight, vsize |
| `anchor <checkpoint.json> --network <net> [--fee-rate n \| --fee-source url] [--pubkey xonly] [--recipient addr] [--postage sats] [--claims <fragments...>] [--claim id]` | Quotes a `checkpoint/1` head as an inscription: the canonical anchor body and its media type, exact reveal weight/vsize/lane, fee, commit value, the commit address with `--pubkey`, whether the head's `x-signature` verifies, and an `inclusion` section (with `--claims`: the root recomputed from the fragments; with `--claim` too: the inclusion proof) |
| `anchor-verify <checkpoint.json> --claim <id> --claims <fragments...>` | Builds the RFC 6962 inclusion proof for a claim id from the fragments and verifies it against the root the head anchors. Exit 3 for a tampered root or fragment, or an unknown claim |

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

## Anchoring a checkpoint on Bitcoin

`@bsh/mesh` publishes a `checkpoint/1` head - an RFC 6962 root over every sealed record a repository
serves (`flashy/public/.well-known/checkpoint.json` here). FlashyOS's head is unsigned by design and,
as their material says, needs an outside witness to mean more than "the publisher said so". An
inscription is that witness: once the head is in a block, the publisher can no longer quietly
re-publish a different history for the same size.

```bash
scribbit anchor flashy/public/.well-known/checkpoint.json --network mainnet --fee-rate 2 --pubkey <xonly> \
  --claims flashy/public/.well-known/shiplog.json flashy/public/directory.fragment.json --claim ship/scribbit/<sha12>
```

**The body** is the canonical JSON (keys sorted, no whitespace - `@bsh/mesh` `canonicalStringify`) of

```json
{"anchor":"1","at":"<head.at>","origin":"<head.origin>","root":"<head.root>","size":<head.size>}
```

with content type **`application/vnd.flashyos.checkpoint+json`**. `counts` and any `x-signature` are
not inscribed: the five fields identify the head, the rest is derivable or off-chain. The same head
re-serialised with keys shuffled, or signed, anchors the same bytes (`test/anchor.test.ts`).

**This body and this media type are our proposal, not FlashyOS's.** FlashyOS specifies the head, its
Merkle construction and the inclusion proof, and names no anchor format; `vnd.flashyos.` is used
because the payload *is* their document, and it should be theirs to ratify or replace. **Open
question to FlashyLabs**: do they want a canonical anchor shape (this one, an `anchor/1` format of
their own, or the head's full canonical bytes), a registered media type, and a way for a head to
point at its anchors (an `x-anchors` list of `<txid>i<n>`)? Until answered, treat the media type as
`x-`-grade and do not depend on other verifiers recognising it.

**The quote** is the ordinary single-layout reveal `[commit] -> [anchor]` (`estimateRevealWeight` with
no parent, `quoteReveal`), so the numbers are the ones `scribbit quote` would print for a file with
these bytes: weight, vsize, lane (always standard - the body is under 200 bytes), reveal fee at the
requested or fetched rate, postage and commit value, and with `--pubkey` the P2TR commit address for
this exact body (`commitAddress`). The tests build and finalize a real signed reveal for the same
body and assert the weight, vsize and fee match.

**Proving a claim against the anchor.** A verifier holding the anchored root and the served
fragments does what `anchor-verify` does: gather every sealed `{ id, digest }` from the fragments
(`claimsOf` - sorted by id), check the RFC 6962 root over them equals the anchored root, build
`inclusionProof(claims, id)` (leaf index, size, audit path) and `verifyInclusion` it against the
anchored root - not the root the fragments produce, which is the whole point - then re-seal the
record itself (`sha256(canonical(record without digest)) == digest`). `anchor` prints these steps as
its `inclusion` section; `anchor-verify` performs them and exits 3 on a root the fragments do not
hash to, a tampered fragment, or an unknown claim.

```bash
scribbit anchor-verify checkpoint.json --claim ship/scribbit/<sha12> --claims shiplog.json directory.fragment.json --json
```

The CLI stops at the quote and the address: funding the commit, signing the reveal and broadcasting
are the wallet's (`@bsh/inscription` `buildHalfSignedReveal` / the wallet-signed PSBT flow), and
recording the resulting `<txid>i0` next to the head is the open question above.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | failure: fee source unreachable, internal error |
| 2 | usage: unknown command or option, missing or malformed value (network, pubkey, parent id, address, fee rate…) |
| 3 | input rejected: unreadable file, reveal too large for any lane, invalid or unsigned PSBT, not a `checkpoint/1` head, a claim that does not prove against the anchored root |

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
  vsizes and fees match them exactly. `anchor.test.ts` does the same for the anchor body (single layout,
  `finalizeReveal`), checks the body is canonical and deterministic, that `anchor-verify` accepts a valid
  proof and refuses a tampered root, and that `--json` prints exactly one object.
