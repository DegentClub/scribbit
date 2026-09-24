# Governance

scribbit: the Blockspace Holdings platform and scribb.it is maintained by Blockspace Holdings with its community. This page says who decides what, and how
to become one of the people who decide.

## Maintainers

Maintainers are assigned **per component**. Each workspace package's `component.yaml` names an `owner` (a GitHub
team). That team maintains the component: it reviews and merges changes, triages its issues, and is on the hook for
its security fixes. `.github/CODEOWNERS` is generated from those owners
(`pnpm --filter @bsh/catalog-tool run codeowners`), so review routing always matches the manifests. Paths no
component owns (`.github/`, `schemas/`, `docs/`, `contracts/`, tooling) belong to `team-platform`.

To see who maintains something: `jq '.components[] | {name, owner}' catalog/catalog.json`.

## How decisions are made

- **Day-to-day changes:** by pull request. The owning team's approval (CODEOWNERS) plus green CI is sufficient.
  Maintainers seek consensus in the review; silence after a reasonable review period is consent (lazy consensus).
- **Significant decisions** (a new component or service, a change of data flow between components or products, a
  signing or custody model, security architecture, a breaking contract change, a new dependency on a service we
  do not run): an **Architecture Decision Record** in `docs/adr/`, proposed in a pull request, open for comment
  for at least 5 business days, and accepted by the owning team(s) with `team-platform` for anything that crosses
  products. ADR numbers are global across DegentClub/scribbit, degent and blockspace. An accepted ADR is never
  edited; a later ADR supersedes it.
- **Disagreements** that the owning team cannot resolve go to `team-platform`, whose decision is recorded in the
  pull request or ADR.
- **Licensing, trademarks and the Code of Conduct** are decided by Blockspace Holdings (the board); changes are
  announced in Discussions before they take effect.

## Becoming a maintainer

1. Contribute: sustained, high-quality pull requests and reviews in a component over roughly three months.
2. Be nominated by an existing maintainer of that component, in a Discussion that links your work.
3. The owning team approves by consensus and adds you to its GitHub team; `team-platform` confirms for platform
   and money-path components (signing, wallet, market, mint, ledger). Maintainers must use two-factor
   authentication.

Maintainers who are inactive for six months, or who ask to step down, move to emeritus status and lose write
access; they are welcome back through the same process.

## Security and conduct

Vulnerabilities are handled by the owning team with `team-platform` under [SECURITY.md](SECURITY.md). Conduct is
handled under the [Code of Conduct](CODE_OF_CONDUCT.md) by the people named there, not by the maintainers of the
component involved.
