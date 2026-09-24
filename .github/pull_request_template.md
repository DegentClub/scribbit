## Summary

<!-- What changes and why, in two or three sentences. Link the ticket. -->

## Component(s)

<!-- Names from catalog/catalog.json, e.g. `degent-mint`, `inscription`. Query: jq '.components[].name' catalog/catalog.json -->

-

## Contract changes

<!-- contracts/ is the only coupling between products. Contract first, then code. -->

**Contract changed?** <!-- yes / no -->

- [ ] No contract changes
- [ ] Contract changed (path + summary below), and the contract was changed first, in this PR; `oasdiff breaking` reports no breaking change, **or** this is a new major version with a migration note

## Tests

<!-- What proves this works? New behaviour ships with tests; fee/size maths ships with property-style tests. -->

- [ ] `pnpm check` passes locally (validate + boundaries + typecheck + test)
- [ ] `pnpm catalog` re-run and committed if any component.yaml changed

## ADR

<!-- Link the ADR for any architectural decision (new component, data flow, security, signing). "n/a" otherwise. -->

- ADR:

## Sign-off and licence

<!-- CONTRIBUTING.md: every commit needs a DCO "Signed-off-by" matching its author (`git commit -s`). -->

- [ ] Every commit is signed off (`Signed-off-by: Name <email>`, DCO 1.1); the `dco` check is green
- [ ] Code copied from elsewhere (if any) is Apache-2.0 compatible and listed in `NOTICE`
