# @bsh/__component__

One paragraph: what this library does, who uses it, and what it deliberately does not do.

## Quickstart

<!-- Replace with the smallest REAL program that uses this package's exports, and keep it runnable.
     `pnpm readiness` fails until the README has a "Quickstart" heading and enough content. -->

In a workspace package: add `"@bsh/__component__": "workspace:*"` to `package.json` and `__component__` to
`depends_on` in `component.yaml`, then:

```ts
import { hello } from '@bsh/__component__';

console.log(hello('world'));
```

## Use

```bash
pnpm --filter @bsh/__component__ test
pnpm --filter @bsh/__component__ typecheck
```

## Interfaces

- Depends on: see `depends_on` in `component.yaml`.
- Contracts: none (libraries expose a TypeScript API)

---

_Created from `templates/library`. Destination: `products/<product>/packages/<name>  (or platform/<name>)`._
