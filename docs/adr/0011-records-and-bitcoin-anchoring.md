# ADR-0011: Shipped records from git, checkpoint heads, and a proposed Bitcoin anchor format

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** team-platform, team-scribbit
- **Components:** `@bsh/mesh` (`records.ts`, CLI `emit` / `check`), `@bsh/scribbit-cli` (`anchor`, `anchor-verify`), `flashy/` in each repository, CI
- **Related:** ADR-0010 (mesh accountability layer)

## Context

ADR-0010 publishes each organisation's charter, front door and directory. FlashyOS's accountability layer also
expects a record of what shipped (`shipped/1`, sealed by digest), a developer log (`devlog/1`) and a checkpoint
head (`checkpoint/1`, an RFC 6962 Merkle root over the sealed records). Their roadmap names an Anchor Protocol that
writes such roots to public chains, "Bitcoin" among them, but specifies no encoding, cadence or proof format.
We are the organisation in the mesh that inscribes on Bitcoin for a living.

## Decision

1. **Records derive from git, and are a union.** `mesh emit` reads `git log --first-parent` with FlashyOS's own
   format, seals each entry (`digest = sha256(canonical JSON without digest)`), and appends only new ids; entries
   already published are kept byte for byte. `generated` is the newest entry's time, never the clock, so the
   output is deterministic.
2. **A commit cannot contain its own record.** The log therefore always lags `HEAD` by design. CI runs
   `mesh emit --frozen` (re-project from the committed log, no git) and fails on a diff; `mesh check` verifies
   seals, the public projection and the head, not completeness. Appending is a local pre-commit step.
3. **The checkpoint head is unsigned, as FlashyOS's is.** A signed copy with our Ed25519 `x-signature` is written
   only when a key path is supplied through the environment; keys are never committed.
4. **Proposed anchor format.** `scribbit anchor` inscribes the canonical JSON of
   `{ "anchor": "1", "origin", "size", "root", "at" }` with the media type
   `application/vnd.flashyos.checkpoint+json`, quoted exactly by `@bsh/inscription`. `scribbit anchor-verify`
   proves a claim id against the anchored root with an RFC 6962 inclusion proof. The media type and body are our
   proposal to FlashyLabs, labelled as such, not their format.

## Alternatives considered

- **OP_RETURN with the 32-byte root.** Cheaper, but loses the origin and size a verifier needs, and ord-based
  explorers do not index it. Kept as a fallback if FlashyLabs specifies it.
- **Regenerate the whole log in CI from git.** Rejected: history rewrites and shallow clones would change
  published, sealed records, which the format forbids ("a correction is appended, never edited").

## Consequences

- Machine-authored commits map to `agent/unattributed` and are dropped from the devlog, as FlashyOS does; a
  person's commits need an author mapping in `shiplog.config.json`.
- Kind classification uses leading words; our `<scope>: …` subjects classify as `other` until a `kinds` map is
  decided.
- Anchoring cadence and who pays for it are open; the CLI quotes and builds, a person or the settlement role
  broadcasts.
