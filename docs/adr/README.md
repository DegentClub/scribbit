# Architecture decision records

One file per decision: `NNNN-kebab-title.md`, numbered sequentially. An accepted ADR is never edited except to
change its status; to change a decision, write a new ADR that supersedes it and link both ways.
Start from [`template.md`](template.md).

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-structure.md) | One monorepo for platform and products, made legible by manifests, a catalog and boundaries | Accepted |
| [0002](0002-degent-mint-architecture.md) | degent.club automated mint: non-custodial, parent-linked, block-sized (lives in DegentClub/degent; pointer here) | Accepted |
| [0003](0003-machine-readable-catalog.md) | Machine-readable component catalog | Accepted |
| [0004](0004-repo-split.md) | Three repositories under DegentClub, platform pinned as a submodule | Accepted |
| [0009](0009-signet-playground.md) | Signet Playground: throwaway browser keys on signet only, proof of work over captcha, a five-minute target | Accepted |
| [0012](0012-ask-blockspace-retrieval-grounded-tutor.md) | Ask Blockspace: a retrieval-grounded tutor with a provider-agnostic ChatPort and extractive fallback | Accepted |

Infrastructure decisions (fleet, networking, secrets, Fleet API) live in the `infra` repository's own ADR series
and are cited as `infra ADR-NNN`.
