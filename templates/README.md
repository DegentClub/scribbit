# Component templates

Copyable skeletons for new workspace components. They live outside the `pnpm-workspace.yaml` globs,
so they are never installed, tested or validated in place.

| Template | Kind | Copy to |
|---|---|---|
| `library/` | library | `products/<product>/packages/<name>/` or `platform/<name>/` |
| `service/` | service | `products/<product>/services/<name>/` |
| `app/` | app | `products/<product>/apps/<name>/` |

```bash
cp -r templates/service products/scribbit/services/ledger
cd products/scribbit/services/ledger
grep -rl '__component__\|__product__' . | xargs sed -i 's/__component__/scribbit-ledger/g; s/__product__/scribbit/g'
# platform/<name>: change tsconfig "extends" to ../../tsconfig.base.json
cd - && pnpm install && pnpm validate && pnpm catalog
```

Then fill in `summary`, `depends_on` and (for services) `provides` / `consumes` / `secrets`, and run `pnpm check`.
