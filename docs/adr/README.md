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
| [0009](0009-ledger-payees-and-psbt-payments.md) | Ledger payees, the `psbt` payment method and payout records | Accepted |
| [0010](0010-mesh-accountability-layer.md) | The mesh accountability layer: FlashyOS AAO formats implemented in the platform, published per organisation | Accepted |
| [0011](0011-records-and-bitcoin-anchoring.md) | Shipped records from git, checkpoint heads, and a proposed Bitcoin anchor format | Accepted |
| [0014](0014-open-authorization-plane.md) | An open, minimal authorization plane for our agents, wire-compatible with FlashyOS's | Accepted |

Infrastructure decisions (fleet, networking, secrets, Fleet API) live in the `infra` repository's own ADR series
and are cited as `infra ADR-NNN`.
