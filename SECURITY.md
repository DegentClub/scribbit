# Security policy

This repository (DegentClub/scribbit) builds software that constructs and signs Bitcoin transactions. We treat a vulnerability
report as the most valuable contribution you can make, and we want it privately first.

## Report a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

1. Preferred: GitHub private vulnerability reporting. Go to the **Security** tab of this repository and choose
   **Report a vulnerability** (<https://github.com/DegentClub/scribbit/security/advisories/new>). Only the maintainers and
   you can see the advisory; we can collaborate on a fix in a private fork and credit you in the published advisory.
2. If you cannot use GitHub: email **security@blockspace.holdings**
   <!-- TODO(confirm): security inbox, who reads it, and whether we publish a PGP key -->.

Please include: the affected component (see `catalog/catalog.json`) and commit, the network you tested on, the
steps or a proof of concept, what an attacker gains (funds, keys, signatures, data, availability), and any
suggested fix. A regtest or signet reproduction is ideal. **Never send private keys, seed phrases or real
customer data**; if a report needs a key to demonstrate, use a freshly generated test key.

## What we care about most

Signing paths first. A bug that can make a user or one of our services sign, broadcast or pay for something
other than what they were shown is our highest severity, whatever its CVSS score.

| Priority | Component | Examples |
|---|---|---|
| 1 | `platform/inscription` | commit/reveal construction, sighash modes, parent attachment, rescue paths |
| 2 | `platform/wallet-kit` | what we ask a wallet to sign, address/network checks, PSBT codec |
| 3 | `platform/signer` | policy checks before signing, key providers, audit log, the HTTP service |
| 4 | `products/scribbit/packages/counters-mint` and `products/scribbit/apps/mint` | Counterparty commit/reveal, reveal keys, PSBTs the user signs |
| 5 | `platform/ledger` | order and payment state, provider webhooks, refunds, xpub address derivation |
| 6 | `platform/identity`, `platform/edge` | Sign in with Bitcoin, BIP-322, sessions, API keys, rate limits |
| 7 | everything else | `platform/events`, `platform/notify`, `products/scribbit/services/*`, `tools/catalog` |

The market and the degent.club mint live in [DegentClub/degent](https://github.com/DegentClub/degent/security/advisories/new); block.space services in [DegentClub/blockspace](https://github.com/DegentClub/blockspace/security/advisories/new). Report there.

Also in scope: secrets or credentials in this repository or its history, supply-chain weaknesses in our build and
CI (`.github/`), and flaws in our contracts (`contracts/`) that let one product mislead another.

Out of scope: vulnerabilities in third-party wallets or dependencies with no impact on how our code uses them
(report them upstream; tell us if our code should defend against them), findings that need a compromised user
device, missing hardening headers or rate limits without a demonstrated impact, social engineering of staff or
users, and denial of service by volume.

## What to expect

| Step | Target |
|---|---|
| Acknowledge your report | 2 business days |
| Triage: severity, affected versions, a named owner | 5 business days |
| Fix released for a critical issue | 30 days |
| Other issues | Scheduled by severity, within the disclosure window |

We keep you updated at least every 7 days until the issue is fixed, and we tell you before anything is published.

## Coordinated disclosure

We ask for **90 days** from your report (or until a fix is released, if sooner) before public disclosure. If a fix
needs longer, we will explain why and agree a date with you. If the issue is being exploited in the wild, we may
disclose earlier, with you. We publish a GitHub Security Advisory (and request a CVE where it applies) for every
confirmed vulnerability and credit you unless you prefer otherwise. There is currently no paid bug bounty.

## Rules for testing

- Test on **regtest, signet or testnet4**, or against your own local deployment. Every service here runs locally
  with in-memory adapters (see each package's README).
- **Never test on mainnet with other people's funds, keys, orders or accounts.** Do not move, lock or burn assets
  you do not own, and do not interact with other users' inscriptions or listings.
- Do not degrade our public services (no load testing, no fuzzing of production endpoints), and do not access,
  modify or retain data that is not yours. If you reach real user data or a live key, stop, and report it at once.
- Do not use social engineering, phishing or physical attacks.

## Safe harbour

<!-- TODO(confirm): legal review of the safe-harbour wording before the repositories go public. -->
If you make a good-faith effort to follow this policy, we consider your research authorised. We will not pursue or
support legal action against you, including under anti-hacking or anti-circumvention laws, and if a third party
takes action against you for research that followed this policy, we will make it known that you acted with our
authorisation. If in doubt about whether something is allowed, ask us first through the channels above.

## Supported versions

Components are pre-1.0 and ship from `main`: security fixes land on `main` and in the latest minor version of each
package (see [SUPPORT.md](SUPPORT.md)). Older versions are not patched.
