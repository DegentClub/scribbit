# @bsh/__component__

One paragraph: what this service does, who uses it, and what it deliberately does not do.

## Quickstart

<!-- Replace with the real commands and the smallest request that shows the service working, and keep them runnable.
     `pnpm readiness` fails until the README has a "Quickstart" heading and enough content. -->

```bash
pnpm install
pnpm --filter @bsh/__component__ start   # {"status":"ok","service":"__component__"}
```

## Use

```bash
pnpm --filter @bsh/__component__ test
pnpm --filter @bsh/__component__ typecheck
pnpm --filter @bsh/__component__ dev
```

## Interfaces

- Depends on: see `depends_on` in `component.yaml`.
- Contracts: see `provides` / `consumes` in `component.yaml`.

---

_Created from `templates/service`. Destination: `products/<product>/services/<name>`._
