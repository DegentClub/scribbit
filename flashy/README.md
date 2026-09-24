# flashy/ — what scribb.it publishes to the mesh

The FlashyOS "AAO" accountability files this repository publishes for **scribb.it** (org `scribbit`,
property `scribb.it`), produced and checked by [`@bsh/mesh`](../platform/mesh/README.md). Three
kinds of file live here:

- **sources** — hand-written, the only files to edit;
- **generated** — derived from the sources by `pnpm mesh:emit`, committed, and re-derived in CI
  (`pnpm mesh:records` then `git diff --exit-code -- flashy/`), so the served files can never drift
  from their sources;
- **served** — everything under `public/`, to be mounted at the scribb.it site root so that
  `https://scribb.it/.well-known/…` resolves. Nothing serves it yet (see
  [Open questions](../platform/mesh/README.md#open-questions)).

```bash
pnpm mesh:emit      # append the records from git and regenerate public/**  (run before you commit)
pnpm mesh:records   # regenerate public/** from the COMMITTED records, without git  (what CI runs)
pnpm mesh:check     # validate every file, recompute every seal and the head, fail on anything stale
```

## Every file

| File | Kind | Format | Served at | What it is |
|---|---|---|---|---|
| `charter.json` | source | `aao/0.1` | — | Who scribb.it is: four roles (`inscription-engine`, `fee-oracle`, `agent-gateway`, `settlement`), escalation, the repository, and the `x-bitcoin` extension. `accountableTo` is a **placeholder** to replace with a named human before publishing |
| `frontdoor.config.json` | source | (config for `frontdoor/1`) | — | The lanes a stranger may open and the ladder of rungs 0–3 with what each costs and buys |
| `directory.config.json` | source | (config for `directory/0.1`) | — | What the fragment is additionally the authority for: the property, the record emitter `agent/scribbit-records`, `assertedBy` (the **placeholder** `person/bsh-accountable`), pinned `asserted`/`expires` dates |
| `shiplog.config.json` | source | (config for `shipped/1`, `devlog/1`, `checkpoint/1`) | — | Who seals the log (`agent/scribbit-records`), the `authors` map (email → node; `noreply@anthropic.com` → `agent/unattributed`), the kind lexicon, `visibility: public`, the head's `origin` (`https://scribb.it`) |
| `directory.externals.json` | generated | — | — | Ids the fragment references but another repository defines (`person/bsh-accountable`, the `std/…` standards it cites) |
| `shiplog.fragment.json` | generated | `shipped/1` | — | **The whole sealed log**, private entries included. `mesh emit` **appends** to it: committed entries are history and kept byte for byte; only commits not yet in it are derived and sealed |
| `public/.well-known/flashyos-charter.json` | generated | `aao/0.1` | `/.well-known/flashyos-charter.json` | = `charter.json` |
| `public/flashyos.roles.json` | generated | `aao/0.1` | `/flashyos.roles.json` | = `charter.json` (the second path the standard names) |
| `public/.well-known/frontdoor.json` | generated | `frontdoor/1` | `/.well-known/frontdoor.json` | The door, with FlashyOS's `NOT_AUTHORITY` paragraph verbatim |
| `public/directory.fragment.json` | generated | `directory/0.1` | `/directory.fragment.json` | Our fragment of the estate graph: the org, its agents (including the record emitter), the property, and one `src/` node per surface actually on disk here (`aao/0.1`, `shipped/1`, `checkpoint/1`) |
| `public/.well-known/shiplog.json` | generated | `shipped/1` | `/.well-known/shiplog.json` | The **public projection** of `shiplog.fragment.json`: same header, only `visibility: public` entries, holds applied |
| `public/.well-known/devlog.fragment.json` | generated | `devlog/1` | `/.well-known/devlog.fragment.json` | The human-readable changelog. A machine-authored commit is dropped outright (the format has no field to file it under), so while every commit here is authored by `noreply@anthropic.com` it is empty — that is the honest answer, not a bug |
| `public/.well-known/checkpoint.json` | generated | `checkpoint/1` | `/.well-known/checkpoint.json` | The RFC 6962 head over what is served: every sealed record in `shiplog.json` and `directory.fragment.json` (directory records carry no digest, so today the tree is the log). Unsigned, as FlashyOS's is. `at` = the log's `generated` |
| `public/.well-known/checkpoint.signed.json` | generated, **optional** | `checkpoint/1` + `x-signature` | `/.well-known/checkpoint.signed.json` | The same head under our Ed25519 signature. Written only when `MESH_CHECKPOINT_KEY=<path to key.pem> pnpm mesh:emit` is run by an operator holding the key; CI has no key and never writes it. The key is never committed; `mesh check` verifies the signature and that it is the served head |

## Determinism

Every generated file is a pure function of the sources and (for the records) the git history at
the time of the last append: `generated` is the newest entry's author date, the head's `at` is that
`generated`, the fragment's dates are pinned in `directory.config.json`. Two runs over the same
inputs are byte-identical, which is what lets CI diff them.

The one thing that is *not* a pure function of HEAD is the log itself: a commit cannot carry its own
sealed entry, so the committed log always lags HEAD by the commits made since someone last ran
`pnpm mesh:emit`. CI therefore re-projects from the committed fragment (`--frozen`) rather than
re-deriving from git, and checks seals, projection and head rather than completeness.

## Anchoring

`scribbit anchor public/.well-known/checkpoint.json --network <net> --fee-rate <n> --pubkey <xonly>`
(the [developer CLI](../products/scribbit/apps/cli/README.md#anchoring-a-checkpoint-on-bitcoin))
quotes this head as an inscription, exactly; `scribbit anchor-verify` proves a claim id against the
anchored root. The anchor format is our proposal, not FlashyOS's.

## Not here

- `backlog/1` (`/.well-known/backlog.json`): not implemented; nothing here files intentions yet.
- `flashyos/1` handshake (`/.well-known/flashyos.json`): unspecified upstream.
- `/.well-known/bsh-key-binding.json`, `/.well-known/flashyos-plane.json`: the library can produce
  them; no key is configured to sign them.
