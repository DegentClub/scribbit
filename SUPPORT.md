# Support

## Where to ask

| You have | Go to |
|---|---|
| A question, an idea, or want to show what you built | [Discussions](https://github.com/DegentClub/scribbit/discussions) |
| A bug | [Bug report](https://github.com/DegentClub/scribbit/issues/new?template=bug.yml) |
| A wallet that behaves differently from what we document | [Wallet compatibility report](https://github.com/DegentClub/scribbit/issues/new?template=wallet-compatibility.yml) |
| A feature request | [Feature request](https://github.com/DegentClub/scribbit/issues/new?template=feature.yml) |
| A security vulnerability | **Privately**, via [Report a vulnerability](https://github.com/DegentClub/scribbit/security/advisories/new); see [SECURITY.md](SECURITY.md) |
| A conduct concern | See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

Before asking, check the package's README (every package has a Quickstart) and `catalog/catalog.json` to find the
right component. Include the component, the commit or version, and the network.

Never post private keys, seed phrases, API keys or customer data in an issue or discussion. If you already did,
treat the key as compromised: move the funds and rotate the credential.

## What is supported

- Components are pre-1.0 and released from `main`. We support the **latest minor version** of each package (for
  unpublished packages: the latest commit on `main`). Fixes are not backported.
- A component's `lifecycle` in its `component.yaml` tells you how much to rely on it: `experimental` may change
  without notice, `beta` is stable in intent with breaking changes called out, `production` follows semver
  strictly, `deprecated` is on its way out.
- Networks: mainnet, testnet4, signet and regtest where the package says so.
- Node.js 22 or later; the evergreen versions of Chrome, Firefox and Safari for browser packages.

Support is best effort by the maintainers ([GOVERNANCE.md](GOVERNANCE.md)); there is no paid support or SLA
for community users.
