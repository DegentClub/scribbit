# @bsh/mesh

The FlashyOS **"AAO" accountability formats** and **money documents**, implemented from the public
FlashyLabs repositories so that every Blockspace product repo can publish conformant well-known files
and exchange signed invoices and receipts with FlashyOS agents. Validators mirror the vendored
FlashyLabs checkers rule for rule; emitters mirror their emitters; the money documents mirror
`flashyos-wdk`'s `interop.ts`. Nothing here needs a network, a chain or a wallet: `node:crypto`
(Ed25519, SHA-256), hand-written canonical JSON, and `@noble/curves` only for BIP340.

It deliberately does **not** implement the parts FlashyOS has not published (the `flashyos/1`
handshake and `countersign/1` - see [Open questions](#open-questions)), does not hold keys, and does
not fetch anything.

## Use

```bash
pnpm --filter @bsh/mesh test
pnpm --filter @bsh/mesh typecheck
node platform/mesh/bin/mesh.mjs help      # the CLI; runs the TS sources under Node 22, no build
pnpm mesh:emit && pnpm mesh:check         # this repository's own flashy/ files (CI runs both)
```

```ts
import { validateCharter, emitFrontdoor, directoryFromCharter, signInvoice, verifyReceipt } from '@bsh/mesh';
```

## The formats

| Format | Well-known path | Module | What it is |
|---|---|---|---|
| `aao/0.1` charter | `/.well-known/flashyos-charter.json` and `/flashyos.roles.json` (same bytes) | `charter.ts` | Who the organisation is, who answers for it, its roles and what each may do |
| `frontdoor/1` | `/.well-known/frontdoor.json` | `frontdoor.ts` | The lanes a stranger may open and the ladder of what each rung costs and buys; carries `NOT_AUTHORITY` verbatim |
| `directory/0.1` | `/directory.fragment.json` (+ `directory.externals.json` beside the source) | `directory.ts` | This repository's fragment of the federated estate graph: nodes, edges, provenance |
| `shipped/1` | `/.well-known/shiplog.json` | `shipped.ts` | Sealed entries derived from `git log --first-parent`; private by default |
| `devlog/1` | `/.well-known/devlog.fragment.json` | `shipped.ts` | The human-readable changelog beside it |
| `checkpoint/1` | `/.well-known/checkpoint.json` | `checkpoint.ts` | An RFC 6962 Merkle head over every sealed record, with inclusion proofs |
| records pipeline | the three above, from `shiplog.config.json` | `records.ts` | `mesh emit|check <dir>`: append the log from git, project it, head it, verify it (ours - see [Records](#records-shipped-devlog-checkpoint)) |
| plane document | `/.well-known/flashyos-plane.json` | `plane.ts` | A plane's keys (active + retired, `kid` = sha256 of SPKI DER), chains, schemas |
| SignedInvoice v1 / SignedReceipt v1 | documents, not files | `money.ts` | What a payee wants; what a plane settled, under the key a verifier already trusts |
| `flashyos/1` handshake, `countersign/1` | `/.well-known/flashyos.json` | `handshake.ts` | **Unspecified upstream** - typed placeholder only |
| key binding (ours) | `/.well-known/bsh-key-binding.json` | `binding.ts` | Ed25519 key ⇄ BIP340 x-only key, each signing the same canonical bytes |
| `backlog/1` | `/.well-known/backlog.json` | - | Not implemented (an item decays and is never sealed; nothing here needs it yet) |

Every validator returns `Finding[]` - `{ code, path, message, severity }` with codes that are stable
(CI and tests match on them) and, where FlashyOS's checker has a code, the same code. Every emitter is
deterministic: two runs over the same inputs are byte-identical, which is what lets CI diff them.

Canonical form everywhere (`canonical.ts`): keys sorted recursively, arrays in order, no whitespace,
`undefined` dropped. Seals are `sha256(canonical(record minus digest))`; signatures are
`base64url(ed25519(canonical(signed fields)))`.

## Conformance

`test/conformance.test.ts` runs this package over what FlashyLabs actually publishes for
`flashy-ledger` (fixtures under `test/fixtures/flashy-ledger`, unmodified): their charter, door and
fragment pass our validators with no findings; `emitFrontdoor` and `directoryFromCharter` re-derive
their published door and fragment byte for byte; all 88 of their `shipped/1` seals recompute; and
our RFC 6962 root over their claims is their published `checkpoint.json` root. The bech32 codec was
additionally cross-checked against `@scure/btc-signer` on random addresses for every witness version.

## Publishing from a product repo

A repo publishes a `flashy/` directory. Three sources are hand-written; everything under `public/`
is generated and committed, and CI fails if the two disagree.

```
flashy/
  charter.json               # the aao/0.1 charter (source)
  frontdoor.config.json      # property, org, lanes, rungs, endpoint, ladder, updated (source)
  directory.config.json      # asserted, expires, assertedBy, platform, vertical, properties, emitters (source)
  shiplog.config.json        # source, org, assertedBy, defaultAuthor, authors, lexicon, visibility, origin (source; optional)
  directory.externals.json   # GENERATED: ids the fragment references but another repo defines
  shiplog.fragment.json      # GENERATED, APPENDED TO: the whole sealed log, private entries included
  public/                    # serve this directory at the site root
    flashyos.roles.json                  # GENERATED = charter.json
    directory.fragment.json              # GENERATED
    .well-known/flashyos-charter.json    # GENERATED = charter.json
    .well-known/frontdoor.json           # GENERATED
    .well-known/shiplog.json             # GENERATED: the public projection of shiplog.fragment.json
    .well-known/devlog.fragment.json     # GENERATED: devlog/1
    .well-known/checkpoint.json          # GENERATED: checkpoint/1 head over shiplog.json + directory.fragment.json
    .well-known/checkpoint.signed.json   # GENERATED only with MESH_CHECKPOINT_KEY: the same head under x-signature
```

```bash
mesh emit flashy             # regenerate public/** from the sources; with shiplog.config.json, append the records from git
mesh emit flashy --frozen    # the same without git: re-project the COMMITTED shiplog.fragment.json (what CI runs)
mesh check flashy            # validate every file, recompute every seal and the head, fail on anything stale
```

In this repository that is `pnpm mesh:emit` / `pnpm mesh:records` / `pnpm mesh:check`, and
`.github/workflows/ci.yml` runs `mesh:records`, fails on `git diff --exit-code flashy/`, then runs
the check. The scribb.it web app still has to serve `flashy/public` at its root for the URLs in the
fragment to resolve - until it does, the fragment's `src/scribbit-*` surfaces are promises with
nothing behind them. [`flashy/README.md`](../../flashy/README.md) describes every file.

The granular commands are there for other layouts and for fragments this repo does not publish yet:

```
mesh check-charter <file>
mesh check-frontdoor <file>
mesh check-directory <file> [--externals <file>]
mesh emit-charter <charter> <out...>
mesh emit-frontdoor <config> <out>
mesh emit-directory <charter> <out> [--config <file>]
mesh checkpoint <fragments...> --origin <id-or-url> --out <file> [--sign <key.pem>] [--at <iso>]
mesh keygen --out <dir> [--bip340]
mesh emit <dir> [--frozen] [--rev <rev>]
```

Exit codes: `0` ok, `1` findings (errors; warnings alone still exit 0), `2` fatal (usage, missing
file, bad JSON). `--json` prints one `{ command, ok, exit, summary, findings, ... }` object.
`keygen` writes private material with mode `0600` and refuses to overwrite it; never commit it.

### shipped/1 from git

`shippedFromGitLog(raw, config)` parses the output of

```
git log --first-parent --pretty=format:'%H%x1f%aI%x1f%aE%x1f%s%x1f%b%x1e' [rev]
```

(`GIT_LOG_FORMAT` / `gitLogArgs()`; identical to FlashyOS's) - one record per commit, fields
separated by `0x1f` (sha, author date, author email, subject, body), records terminated by `0x1e`.
Kind comes from a recorded decision (`config.kinds`), else a `kind:` trailer, else a conventional
prefix (`feat:`, `fix(scope)!:`, `chore(release):` ...), else the declared lexicon (`'imperative'` for
the built-in one), else `other`. Authors map through `config.authors` (email → `person/` or `agent/`
id); an unmapped machine address becomes `agent/unattributed`, never `defaultAuthor`. Every entry
lands `private` unless `config.visibility` says otherwise, and `config.held` keeps a sha private
regardless. Integration merges and the formats' own refresh commits are not work and are dropped.

## Records: shipped, devlog, checkpoint

When `<dir>/shiplog.config.json` exists, `mesh emit <dir>` and `mesh check <dir>` also produce and
verify the repository's records (`records.ts`, the pipeline; `shipped.ts` and `checkpoint.ts`, the
formats). The config is a `ShiplogConfig` (above) plus `origin` (the head's origin: `repo/<name>`
or the site URL) and `rev` (what git walks; default `HEAD`).

**`mesh emit` appends.** It runs `git log --first-parent` (`GIT_LOG_FORMAT`) at the repository root
that contains `<dir>` (`git rev-parse --show-toplevel`), derives and seals one entry per work commit,
and merges the result into the committed `shiplog.fragment.json` with **existing entries winning**:
an entry already sealed is history and is kept byte for byte even if the config, the lexicon or the
commit itself (a rewrite) would derive it differently today; only ids not yet in the fragment are
added (`appended` in the `--json` result). Holds (`held`) and `visibility` decide what the **public
projection** `public/.well-known/shiplog.json` carries; the fragment keeps everything. `devlog/1`
is merged the same way. Then the directory fragment is emitted - it declares the `shipped/1` and
`checkpoint/1` surfaces because the files are now on disk - and finally the head:

- `checkpoint.json` is `checkpointHead(claimsOf([shiplog.json, directory.fragment.json]))`: the
  RFC 6962 root over every **sealed** record in what is **served**, so a reader with only the URLs
  can recompute it. Directory nodes and edges carry no digest (FlashyOS seals shipped entries, not
  directory records), so today the tree is the log; a sealed directory would join it unchanged.
  `at` is the log's `generated`. Unsigned, as FlashyOS's is.
- `checkpoint.signed.json` is written **only** when the environment variable `MESH_CHECKPOINT_KEY`
  names an Ed25519 private key (PKCS#8 PEM): the same head under `x-signature`
  (`signCheckpointHead`). The key never enters the repository; CI has none and never writes the
  file. The unsigned head stays the served, FlashyOS-shaped one.

**Nothing reads the clock.** `generated` is the newest entry's author date (or the config's
`asserted` at midnight when the log is empty), the head's `at` is that `generated`, and `asserted`
on a new entry is the config's `asserted` or the day it was sealed - after which it is history.
Two emits over the same history are byte-identical.

**The log lags HEAD by design.** A commit cannot carry its own sealed entry, so the committed log is
always behind by the commits made since the last append - on a pull request, by the whole branch.
That is why CI runs `mesh emit --frozen`: no git, the served projections and the head are rebuilt from
the committed fragment, and `git diff --exit-code` then proves the served files are derived from the
committed sources and nothing more. Append locally with `pnpm mesh:emit` before you commit; a
commit whose subject is one of `BOOKKEEPING_SUBJECTS` (`shipped/1: refresh the log` ...) is not
work and never lands in the log.

**`mesh check` never reads git either.** It recomputes every seal in the fragment and the served
log (`validateShipped`), proves the served log is the fragment's public projection
(`shiplog-stale`), validates the devlog, recomputes the head from the served files and every leaf's
inclusion (`checkpoint-stale`), and - when `checkpoint.signed.json` exists - verifies its signature
(`checkpoint-signature-invalid`) and that it is the served head (`checkpoint-signed-stale`).
Missing files are `shiplog-fragment-missing`, `shiplog-not-served`, `devlog-not-served`,
`checkpoint-not-served`. Unmapped author addresses are reported at emit time as `unmapped-author`
warnings (a machine's address lands under `agent/unattributed`, never under `defaultAuthor`); a
recorded kind this format does not have is `bad-recorded-kind`. Finding paths are
`<file>#<record id>`.

In this repository (`flashy/shiplog.config.json`): every commit so far is authored by
`noreply@anthropic.com`, mapped to `agent/unattributed`, so every entry's `by` is that agent and the
devlog - which drops machine-authored commits outright - is empty. Subjects here are `<scope>: ...`,
not conventional types, and the declared lexicon is a list of leading words
(`feat|feature`, `fix`, `security`, `perf`, `docs`, `ci|infra|build`, `spec|contract|adr`,
`release`), so most entries are `other`. Both are what the history says; a `kinds` map in the config
is the place to record a person's decision otherwise.

## Anchoring

A head is a commitment; an anchor is that commitment written where we cannot rewrite it. The
scribb.it developer CLI does the first half:

```bash
scribbit anchor flashy/public/.well-known/checkpoint.json --network mainnet --fee-rate 2 --pubkey <xonly> \
  --claims flashy/public/.well-known/shiplog.json flashy/public/directory.fragment.json --claim ship/scribbit/<sha12>
scribbit anchor-verify checkpoint.json --claim ship/scribbit/<sha12> --claims shiplog.json directory.fragment.json
```

`anchor` reads a `checkpoint/1` head, builds an inscription whose body is the canonical JSON of
`{ "anchor": "1", "origin", "size", "root", "at" }` (this package's `canonicalStringify`; `counts`
and any `x-signature` stay off chain) under the content type
`application/vnd.flashyos.checkpoint+json`, and quotes it exactly with `@bsh/inscription`. **The
body and the media type are our proposal**: FlashyOS specifies the head and says it needs an outside
witness, but names no anchor format. `anchor-verify` and the `inclusion` section of `anchor` use
`claimsOf`, `inclusionProof` and `verifyInclusion` from here to prove a claim id against the
anchored root, and refuse a root the fragments do not hash to. Details and the open question to
FlashyLabs: [the CLI README](../../products/scribbit/apps/cli/README.md#anchoring-a-checkpoint-on-bitcoin).

## What is FlashyOS's format and what is ours

| Ours (extension) | Where | Why |
|---|---|---|
| `btc:` chain ids (`btc:mainnet`, `btc:testnet`, `btc:testnet4`, `btc:signet`) and bech32/bech32m destination validation; `verifyInvoice(..., { btcDestination: true })` → `BAD_DESTINATION` | `money.ts`, `bech32.ts` | FlashyOS's chain regex admits `btc:<id>` but defines no ids and checks no addresses |
| `x-signature` on a checkpoint head (`signCheckpointHead` / `verifyCheckpointHead`) | `checkpoint.ts` | FlashyOS's head is unsigned **by design** (the publisher holds both data and root, so a self-signature proves little). Ours proves only which key issued the head; it still needs consistency proofs and an outside witness to mean more |
| The key-binding document at `/.well-known/bsh-key-binding.json` | `binding.ts` | Ties our Ed25519 key to our BIP340 key so a taproot key on chain can be linked to a receipt |
| `validateShipped` / `validateDevlog` shape rules | `shipped.ts` | FlashyOS's vendored file only recomputes seals; ours also checks ids, provenance and visibility (modelled on their backlog checker) |
| `validatePlaneDocument` (every finding) beside `verifyPlaneDocument` (their first-failure port) | `plane.ts` | |
| `receiptFor`, `planeDocument`, `generateKeyPair`, `mesh emit|check <dir>` conveniences | | |
| The records pipeline: append-only merge, clock-free `generated`/`at`, the head over what is served, `--frozen`, `MESH_CHECKPOINT_KEY` | `records.ts` | FlashyOS refreshes its log from a workflow that commits the result; a diff gate in CI needs determinism and a mode that does not read git |
| The anchor body `{ anchor: "1", origin, size, root, at }` as `application/vnd.flashyos.checkpoint+json` | `@bsh/scribbit-cli anchor` | FlashyOS names no anchor format |
| `x-bitcoin` in our charter | `flashy/charter.json` | Carried as an explicit `x-` extension, as aao 0.1 requires |

Everything else - field names, regexes, rule text, codes, the `NOT_AUTHORITY` paragraph, canonical
form, RFC 6962 construction, the ten families, the surface table - is FlashyOS's, reproduced.

## This repository's charter

`flashy/charter.json` declares org `scribbit` ("scribb.it") with four roles: `inscription-engine`
(engineering: quote, envelope, rescue - LOW), `fee-oracle` (data: aggregate, publish - LOW),
`agent-gateway` (engineering: serve, authenticate, limit - MEDIUM) and `settlement` (finance: post,
receipt, refund - CRITICAL), escalation to `settlement`, one repository `github.com/DegentClub/scribbit`.

**Two placeholders must be replaced by a real, named human before anything is published on
scribb.it:** `accountableTo: "accountable@scribb.it"` in `charter.json` (it validates - it is an
email that is not the template placeholder - but the standard's question five is *a reachable
person*, not an alias) and `assertedBy: "person/bsh-accountable"` in `directory.config.json` (the
`person/` node is referenced, listed in `directory.externals.json`, and defined nowhere; FlashyOS's
estate defines its accountable people in one authoritative repository, and we have no such
repository yet).

## Open questions

- **`flashyos/1` handshake** (`/.well-known/flashyos.json`) and **`countersign/1`**: named in the
  FlashyOS material (a surface in `directory.mjs`, rung 2 of their door), never specified there. Not
  invented here; `handshake.ts` carries only a typed placeholder `{ flashyos: '1', ...x- }`.
- **`network`** in the charter: an allowed top-level key with no published shape; typed `unknown`.
- **Who defines our accountable person node** and where the estate-wide merge that resolves
  `directory.externals.json` runs for us - FlashyOS's is their `@flashyos/directory` merge.
- **Serving**: `flashy/public` must be mounted at the scribb.it site root; the frontdoor `endpoint`
  (`https://scribb.it/frontdoor`) is a URL the door promises and nothing answers yet.
- **`shipped/1`, `devlog/1`, `checkpoint/1` for this repository**: published from
  `flashy/shiplog.config.json` (public, appended by `pnpm mesh:emit`, re-projected in CI). Still open:
  who holds the head-signing key (`MESH_CHECKPOINT_KEY`) and where the anchoring transaction is
  broadcast from; `backlog/1` is not implemented.
- **The anchor format**: `application/vnd.flashyos.checkpoint+json` over the five head fields is
  our proposal; FlashyLabs has published none. To be raised with them before a mainnet anchor.
- **Plane identity**: `verifyReceipt({ trustedKeys })` wants a registry of planes we trust; none is
  configured anywhere yet.

## Interfaces

- Depends on: nothing in the workspace (`depends_on: []`). Runtime: `node:crypto`, `@noble/curves`
  (BIP340 only, same version as `@bsh/inscription`).
- Contracts: none (libraries expose a TypeScript API). The schema `$id`s the money documents
  conform to are exported as `INVOICE_SCHEMA_ID` / `RECEIPT_SCHEMA_ID`.

## NOTICE

The formats, rule text, canonical form and reference behaviour reproduced here, and the fixtures
under `test/fixtures/flashy-ledger`, come from the public FlashyLabs repositories
(`flashy-ledger`, `flashyos-wdk`, `flashyos-spec`), Copyright Flashy Labs, licensed under the
Apache License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>). This package is a
re-implementation in TypeScript with the extensions listed above; any divergence is ours.
