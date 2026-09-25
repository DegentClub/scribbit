# ADR-0014: An open, minimal authorization plane for our agents, wire-compatible with FlashyOS's

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** team-platform; product owner (mesh paper, Phase F)
- **Components:** `@bsh/plane` (`platform/plane`), `@bsh/scribbit-mcp` (`products/scribbit/services/mcp`), `@bsh/mesh` (`platform/mesh`, plane document), CI
- **Related:** ADR-0010 (the mesh accountability layer), ADR-0009 (ledger payees), `contracts/openapi/plane.yaml`

## Context

The mesh paper's Phase F calls for a spend-authorization plane between an agent (an MCP tool, a mint bot) and the
money it is allowed to move: something that turns "an agent asked to pay X" into "an agent may pay X, once, within
N minutes, for exactly this destination and amount" - and that says no, cheaply, before anything reaches the
ledger or the signer. FlashyOS (FlashyLabs, Apache-2.0) has already published the shape such a plane takes in
`flashyos-wdk`: `docs/wallet/spec.md`, `interop.ts`, `openapi.wallet.json` and `schema/*.json` define an
`OperationRecord` an agent proposes, a `SpendEnvelope` that bounds what one agent may do on one chain, five checks
run in a fixed order (identity, authority, envelope, budget, grading), three verdicts (ALLOW, ESCALATE, DENY), ten
denial codes, and a signed, single-use, five-minute `SpendAuthorization` a signer redeems against the actual call.
FlashyOS's own plane implementation is private; only the formats and validators are public.

We already run one money-adjacent HTTP service per organisation this way (the ledger, ADR-0009) and one shared
accountability library that implements FlashyOS's other published formats field-for-field (`@bsh/mesh`, ADR-0010).
The scribb.it MCP server (`@bsh/scribbit-mcp`) is the first caller that needs this: `create_order` and
`report_funding` let an agent move sats to artist, club and platform payees, and today nothing between the tool
call and the ledger enforces a per-agent, per-destination, per-day ceiling.

## Decision

1. **Implement the plane as `@bsh/plane`, a standalone service, to FlashyOS's published shape.** Field names, the
   five checks, their order, the verdicts and the ten denial codes (`SCOPE_MISSING`, `NO_ENVELOPE`,
   `ENVELOPE_INACTIVE`, `KIND_NOT_PERMITTED`, `ASSET_NOT_PERMITTED`, `DESTINATION_NOT_PERMITTED`, `PER_TX_CAP`,
   `DAILY_CAP`, `INVALID_AMOUNT`, `INVALID_RECORD`) are theirs, vendored as fixtures under
   `test/fixtures/flashyos-wdk` (Apache-2.0, unmodified) and checked by a conformance suite, the same discipline
   ADR-0010 set for `@bsh/mesh`. `decide()` (`src/decide.ts`) is the policy; its check order is load-bearing and
   tested, not merely documented.
2. **`SpendAuthorization` is exactly FlashyOS's capability**: single use (the id is a nonce, consumed only on a
   successful redemption so a refused call never burns it), five minutes by default (configurable 10-300 s, capped
   at 300), Ed25519-signed over canonical JSON via `@bsh/mesh`'s `canonicalBytes`/`asPrivateKey`, and re-derived
   from the actual call at redemption time rather than trusted at face value (chain, kind, asset, destination must
   match; amount must be `<= maxAmount`).
3. **`wallet:propose` and `wallet:settle` are never held by one key, ever** - refused at key-load time
   (`SCOPE_CONFLICT`), not merely by convention - because the proposer must never be the party that reports its
   own settlement. `wallet:delegate` (people, via a second-factor `X-Approval` signature) is likewise never held
   with either. This is FlashyOS's separation of duties, enforced at configuration, not just policy.
4. **The plane publishes a `PlaneDocument` at `/.well-known/flashyos-plane.json`** (`@bsh/mesh`'s `planeDocument` /
   `validatePlaneDocument`, already shared infrastructure per ADR-0010): the active signing key, any retired keys
   (rotation is an overlap, never a cut), the chains it authorizes, and the schemas it enforces. A verifier holding
   only this document can check a `SpendAuthorization` or an audit head offline.
5. **The audit log is hash-chained per organisation and append-only**, every verdict recorded including refusals
   ("refusals are evidence"): entry shape and hash rule mirror FlashyOS's `ProvenanceEntry`
   (`sha256(canonical({seq, at, kind, id, data, prev}))`, genesis `prev` = 64 zeros), so their `verifyExport`
   algorithm checks our chain unmodified. The head can be Ed25519-signed with the plane key, an extension marked
   ours (FlashyOS's own head is unsigned by design).
6. **The budget check is a compare-and-set, not a lock**: `Budget.reserve` reads today's used-amount row, decides,
   then writes only if nobody else reserved or released against that row since the read, retrying on conflict.
   Two proposals racing for the last of a daily cap therefore resolve to exactly one ALLOW and one DAILY_CAP DENY,
   never both ALLOW and never a false DENY - tested directly with concurrent proposals via `Promise.all`.
7. **Marked, separable extensions** beyond FlashyOS's spec: an `active` flag on envelopes (theirs revokes via a
   different route), `payee:<kind>` destination classes matched against the ledger's payee kinds, an
   `humanApprovalAtOrAbove` threshold per envelope (mapped from an `aao/0.1` charter role, ADR-0010), and bech32/
   bech32m destination validation on `btc:` chains (`@bsh/mesh`'s checker) with an amount ceiling at the 21M BTC
   supply. None of this weakens FlashyOS's checks; it only adds ones they have no chain family to need.
8. **This plane is ours, independent of FlashyOS's, wire-compatible where their OpenAPI applies.** We do not call
   their service and they cannot call ours; interoperability is at the level of formats a third party could verify
   against either implementation, exactly the posture ADR-0010 already took for the rest of the mesh formats.
9. **`@bsh/scribbit-mcp` is the first governed caller.** With `MCP_PLANE_URL` set, `create_order` (when it carries
   payees) and `report_funding` propose every payee share to the plane, in order, before anything reaches the
   ledger, for any MCP key whose `ownerId` is mapped to a plane agent (`MCP_PLANE_AGENTS_JSON`); keys with no
   mapping are ungoverned. A DENY - or a plane the client cannot reach, which fails closed rather than open - is
   the tool error `plane_denied` (added to the `ToolError` code enum only; it is never a valid response verdict).
   An ESCALATE does not refuse the call: the response carries `escalated: true` and the plane's reasons, and
   `report_funding` reproposes the same shares (same derived Idempotency-Key as `create_order`'s) so a person's
   approval on the plane is picked up rather than re-decided.

## Alternatives considered

- **Fold authorization into the ledger.** Rejected: the ledger already has its own contract and payee model
  (ADR-0009); conflating "what was paid" with "what may be paid" would make the ledger the policy engine for every
  future money-moving service, not just scribb.it's.
- **Skip the plane and hard-code per-tool limits in `@bsh/scribbit-mcp`.** Rejected: limits, escalation and audit
  would then live once per caller instead of once per organisation, and nothing would produce FlashyOS-shaped
  evidence a person or a future service could verify independently.
- **Depend on FlashyOS's own plane.** Not available to us (private, per their spec); and ADR-0010 already commits
  us to accountability formats that verify without requiring their service.

## Consequences

- Every future money-moving tool or service gains authorization for free by proposing to `@bsh/plane` and mapping
  its keys to plane agents; it need not reimplement budget, envelope or escalation logic.
- Standing up the plane in an environment means provisioning its Ed25519 signing key and API keys through SOPS
  (`services/plane/authz-private-key`, `services/plane/api-keys`), and, per governed caller,
  `services/<caller>/plane-agent-keys` - an infrastructure change tracked separately (fleet deploy, not this repo).
- An escalated proposal now depends on a person resolving a decision on the plane (`PUT
  .../wallet/envelopes/:agent`, `POST .../decisions/:decisionId/resolve`, both second-factor `X-Approval`); until
  that tooling has an operator-facing surface, resolution is via direct API calls. Tracked as follow-up work, not
  a reason to hold this ADR open.
- The plane's SQLite store is single-writer (`node:sqlite`, WAL); a deployment that needs multiple plane replicas
  will need a different `PlaneStore` adapter before it can scale past one process. Not needed at current volume.
