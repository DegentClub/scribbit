# ADR-0009: Ledger payees, the `psbt` payment method and payout records

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** team-platform, with team-degent (first consumer: the Open Studio, degent ADR-0007)
- **Components:** `@bsh/ledger`, `@bsh/events` (`ledger.payout.{status}`), `@bsh/inscription` (attribution metadata)
- **Related:** ADR-0002 §2 (non-custodial funding), degent ADR-0005 (0x81 reveals), blockspace ADR-0008 (attribution in certification)

## Context

The ledger recorded who owed what to the house: orders, payments (on-chain address, Lightning, card), refunds,
receipts. degent.club's Open Studio pays a third party, the artist, 10% of the mint price, and pays the club its
fee, both as outputs of the transaction the minter signs in their own wallet. The house never holds either sum.
The ledger therefore had to learn three things it did not know: that a line item can have a payee, that a payment
can be "the customer signed a PSBT that carries these outputs", and that money leaving to a payee is a record of
its own, not a refund.

Two constraints shaped the design. The platform is non-custodial by rule (CLAUDE.md rule 6), so the ledger must
never become the thing that moves the money. And the contract is gated by breaking-change detection, so every
change had to be additive.

## Decision

1. **Payees on line items.** `LineItem.payee?` is `{ kind: artist|club|platform|other, ref, address? xor
   scriptHex? }`. Scripts are the identity; addresses are decoded to scripts for the configured network and
   never compared as strings.
2. **A `psbt` payment method.** `PsbtProvider` derives the expected outputs from the payee line items (one
   output per distinct payee script, values summed), publishes them in the intent's checkout details, and
   evaluates an observed transaction by scripts and values: paid, overpaid within tolerance, underpaid (naming
   what arrived and what is missing), pending (RBF-signalling or below the confirmation depth). Polling uses the
   Esplora scripthash index. A transaction may settle at most one `psbt` intent, because payee scripts repeat
   across orders.
3. **Payout records.** When a `psbt` payment becomes paid, one `Payout` per payee output is created `settled`
   with the txid and output index, idempotent on (payment, txid, vout), listed per order and per payee, shown on
   receipts, and announced as `ledger.payout.settled`. Payouts are facts about the chain, never instructions.
4. **Response enums are open sets.** Widening a closed enum in a response is a breaking change under oasdiff, so
   `PaymentMethodValue` in responses is an extensible enum while the request enum stays closed. Existing response
   status enums are locked the same way; future additions follow the same pattern.
5. **Refund availability reserves pending refunds** and refund writes are version-checked, closing the race the
   platform audit reported.
6. **Attribution metadata** is a platform concern: `@bsh/inscription` encodes `{ artist, artwork, edition?,
   studio? }` as deterministic CBOR (RFC 8949 §4.2.1) into ord's metadata field, so every product writes the same
   bytes block.space reads.

## Alternatives considered

- **Model the royalty as a refund or transfer.** Rejected: refunds return the customer's own money; a royalty is
  money that never belonged to the house.
- **Have the ledger build or broadcast the funding transaction.** Rejected: it would make the ledger custodial in
  effect. The product builds the PSBT; the ledger records what the chain shows.
- **Compare addresses.** Rejected: one script has several encodings and address strings come from third-party
  indexers; scripts are what the chain enforces.

## Consequences

- Products that pay third parties declare payees on line items and let the ledger derive the outputs, so the
  quote, the PSBT and the receipt cannot disagree.
- `API_VERSION` is 1.1.0; the OpenAPI and AsyncAPI contracts are 1.1.0 and additive.
- The SQLite migration rebuilds the `payments` table (SQLite cannot widen a CHECK constraint); the runbook
  documents it.
- The degent mint service consumes this through a pin bump (degent roadmap p3.4).
