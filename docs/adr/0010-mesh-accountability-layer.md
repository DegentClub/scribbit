# ADR-0010: The mesh accountability layer: FlashyOS AAO formats implemented in the platform, published per organisation

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** team-platform; product owner (board paper "Degent Club on the Mesh")
- **Components:** `@bsh/mesh` (`platform/mesh`), `flashy/` in every DegentClub repository, CI
- **Related:** ADR-0003 (machine-readable catalog), ADR-0009 (ledger payees), blockspace-holdings roadmap p5

## Context

The board decided to build degent.club, scribb.it and block.space as Agentic Autonomous Organizations and to
connect them to the FlashyOS mesh. FlashyOS's public material (FlashyLabs/flashyos-spec, flashyos-wdk,
flashy-ledger, agentfile, Apache-2.0) defines an accountability layer of JSON documents an organisation serves
at well-known paths: a charter (`aao` 0.1: roles, an accountable human, escalation), a directory fragment (nodes
and edges), a front door (lanes and rungs with a verbatim "not authority" clause), shipped and devlog records
sealed by digest, and a checkpoint head (an RFC 6962 Merkle root). The specifications themselves are not yet
published; the only executable definitions are validators vendored inside flashy-ledger. Everything in the
economic layer signs with Ed25519 over canonical JSON; there is no Bitcoin chain family.

We already declare our estate in manifests and a catalog (ADR-0003). The mesh formats are a projection of the
same facts for a different reader.

## Decision

1. **One implementation, in the platform.** `@bsh/mesh` implements the formats as typed validators and emitters
   (charter, directory, front door, shipped, devlog, checkpoint) plus the money documents (signed invoice and
   receipt v1, Ed25519), key generation and fingerprints, a plane document, and a CLI (`mesh check`, `mesh emit`,
   `keygen`). No third-party dependency beyond `@noble/curves`, which the inscription package already uses.
2. **Conformance is proven against their published files, not our reading of them.** The test suite runs the
   package over FlashyLabs' own charter, front door, directory fragment, shipped log and checkpoint (fixtures
   vendored unmodified with a NOTICE): zero findings, byte-identical re-derivation of the door and the fragment,
   every seal recomputed, the checkpoint root reproduced. A rule that would make us accept something their
   checker refuses is a bug.
3. **Every repository publishes a `flashy/` directory**: sources (`charter.json`, `frontdoor.config.json`,
   `directory.config.json`) and generated outputs under `flashy/public` at the exact well-known paths. CI
   regenerates and fails on a diff, then validates. The holdings repository, being Python, vendors the upstream
   checkers instead of the package.
4. **Our extensions are marked and separable**: a `btc:` chain family with bech32 and bech32m destination checks,
   an optional Ed25519 `x-signature` on checkpoint heads (FlashyOS's head is unsigned by design), a key-binding
   document that ties an organisation's Ed25519 key to its BIP340 key, and `x-bitcoin` charter extensions.
   Nothing FlashyOS has not specified (the flashyos/1 handshake, countersign/1) is invented; placeholders carry
   an explicit comment.
5. **Roles are named for the function performed**, from the ten families, with capabilities that are actions and
   a human-approval threshold per role, mapped to the components that already exist. Empty families stay empty.

## Alternatives considered

- **Wait for the specifications to be published.** The vendored checkers are what their conformance tool runs
  today; publishing now costs days and is Apache-2.0 either way. The CI diff gate makes a later format change a
  regeneration, not a rewrite.
- **Vendor the upstream scripts everywhere.** Done for the Python repository. For the TypeScript repositories a
  typed package gives tests, reuse and the money documents that scripts do not.
- **Depend on FlashyOS's private plane for identity.** Rejected: the formats are designed to be verified offline
  ("verification never requires us"); our own accountability must not require their service.

## Consequences

- The `accountableTo` address and the `person/` node in each charter are placeholders until a named human is
  chosen per organisation; the checker accepts them, the README flags them, and rung 1 of the front door cannot
  be climbed honestly before that.
- The generated files must be served at the well-known paths of each property domain; that is an infrastructure
  change tracked separately.
- The Ed25519 organisation keys live with the policy signer's custody; signing invoices and receipts is a
  settlement-role capability with `humanApprovalAtOrAbove: CRITICAL` in the charter.
- Open questions to FlashyLabs are listed in the package README (handshake schema, countersign, key types,
  Bitcoin anchoring, a `btc` family in their wallet, mainnet, the person authority for external organisations).
