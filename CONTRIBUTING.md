# Contributing

Thank you for helping. This page is the contract between contributors and maintainers: what we need from a pull
request and what you can expect from review. Agents: read [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) too.

- Questions and ideas: [Discussions](https://github.com/DegentClub/scribbit/discussions) (see [SUPPORT.md](SUPPORT.md)).
- Bugs, features and wallet compatibility reports: [issue forms](https://github.com/DegentClub/scribbit/issues/new/choose).
- Vulnerabilities: **never** in public; see [SECURITY.md](SECURITY.md).
- Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence of contributions

This repository is licensed under the [Apache License 2.0](LICENSE); documentation and specifications under
[CC BY 4.0](LICENSE-docs). By contributing you agree that your contribution is licensed under the same terms
("inbound = outbound", Apache-2.0 section 5). We do not ask for a CLA. Brand names and logos are not licensed; see
[TRADEMARKS.md](TRADEMARKS.md).

## Sign-off (DCO)

Every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
a `Signed-off-by:` trailer whose name and email match the commit author. The `dco` check fails the pull request
otherwise.

```bash
git config user.name  "Ada Lovelace"
git config user.email "ada@example.com"
git commit -s -m "inscription: reject reveal with mismatched postage"
# -> the commit message ends with:
#    Signed-off-by: Ada Lovelace <ada@example.com>

git rebase --signoff origin/main     # add sign-offs to commits you already made, then force-push
```

By signing off you certify the following:

```text
Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Code copied from elsewhere must be under a licence compatible with Apache-2.0, keep its copyright notice, and be
listed in [NOTICE](NOTICE) in the same pull request.

## Set up and run the checks

Node 22+ and pnpm (the version is pinned in `package.json` `packageManager`; `corepack enable` installs it).

```bash
git clone https://github.com/DegentClub/scribbit.git
corepack enable
pnpm install
pnpm check        # validate manifests + boundaries + typecheck + tests: exactly what CI runs
```

Every package answers to the same verbs: `pnpm --filter <pkg> test | typecheck | build | dev`. Run `pnpm check`
before you push; CI runs it, plus the catalog and CODEOWNERS freshness checks, CodeQL, dependency review, the
gitleaks secret scan over the full history and the DCO check.

## The rules the checks enforce

1. **Every package has a manifest.** A `component.yaml` next to `package.json`, valid against
   `schemas/component.schema.json` (`pnpm validate`). It declares owner, lifecycle, `depends_on`, the contracts
   it `provides`/`consumes`, and secret *paths* (never values).
2. **Boundaries.** A package imports another `@bsh/*` package only if it is in its `depends_on`; products never
   import each other; platform code never imports product code; relative imports never leave the package
   (`pnpm lint:boundaries`).
3. **Contract first.** Anything another component or product relies on (HTTP APIs, events) is defined in
   `contracts/` before the code changes, in the same pull request. Breaking changes need a new major version;
   CI runs `oasdiff breaking` on changed OpenAPI files.
4. **Catalog stays current.** If you touched a `component.yaml`, run `pnpm catalog` and commit
   `catalog/catalog.json` + `catalog/CATALOG.md` (`pnpm catalog --check` in CI), and regenerate CODEOWNERS
   (`pnpm --filter @bsh/catalog-tool run codeowners --org DegentClub`).
5. **Tests are the spec.** New behaviour ships with tests; fee and size maths ships with property-style tests
   against real signed transactions.
6. **Non-custodial by default.** Code never holds a user's private key. Anything that signs or builds something to
   be signed needs an ADR reference and a security-minded reviewer.
7. **No secrets.** Not in code, fixtures, tests or history. Test keys must be published test vectors or obviously
   fake constants, and new ones are allowlisted in `.gitleaks.toml` by exact value and path.

## Add a component

Copy a skeleton from `templates/` (`library`, `service` or `app`) to `platform/<name>/` (shared library), `products/scribbit/{packages,services,apps}/<name>/`:

```bash
cp -r templates/library products/<product>/packages/<name>
cd products/<product>/packages/<name>
grep -rl '__component__\|__product__' . | xargs sed -i 's/__component__/<product>-<name>/g; s/__product__/<product>/g'
cd - && pnpm install && pnpm validate && pnpm catalog && pnpm check
```

Then fill in `summary`, `depends_on` and (for services) `provides` / `consumes` / `secrets`, write the README's
Quickstart for real, and propose the owner team in the pull request. A new service, data flow or security-relevant
decision needs an ADR in `docs/adr/` (numbered globally across DegentClub/scribbit, degent and blockspace).

## Commits and pull requests

- **Commit messages:** `<component>: <imperative summary>` in at most 72 characters, e.g.
  `wallet-kit: refuse signPsbt without inputsToSign`. The body says *why*, and states any breaking change
  explicitly (`BREAKING: ...`). Reference the issue (`Fixes #123`). Every commit is signed off.
- **One change per pull request**, small enough to review in one sitting. Refactors separate from behaviour
  changes. Keep the history clean (squash fix-ups before review ends).
- Fill in the [pull request template](.github/pull_request_template.md), including the contract and DCO items.

## What reviewers look for

1. **Correctness on money paths:** what gets signed, by whom, with which sighash; fees and sizes; network checks;
   nothing that can lose or strand funds. Tests that would fail without the change.
2. **Contract discipline:** contract changed first, compatible or versioned, consumers considered.
3. **Boundaries and manifests:** imports match `depends_on`, catalog regenerated, no product-to-product coupling.
4. **Security hygiene:** input validation at the edge, no secrets, no new dependency without a reason (and a
   look at its maintenance and licence), least privilege in workflows.
5. **Docs:** the package README (including its Quickstart) and any ADR updated with the behaviour.

Each package's owning team (from `component.yaml` `owner`, enforced through CODEOWNERS) must approve. We aim to
give a first review within 3 business days; ping the pull request if we have not.

## Good first issues

Look for these labels:

| Label | Meaning |
|---|---|
| `good first issue` | Small, well-scoped, with pointers to the code and tests to change |
| `help wanted` | We would like help; may need more context, ask in the issue |
| `docs` | README, Quickstart, ADR wording, examples |
| `wallet-compat` | Reproduce or verify a wallet behaviour (see the wallet compatibility form) |
| `tests` | Missing tests or fixtures, especially against real signed transactions |

Comment on an issue before starting so two people do not do the same work.
