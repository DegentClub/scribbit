# Runbook — blockspace-tutor (Ask Blockspace API)

## What it is

A stateless public HTTP service answering blockspace questions, grounded in the committed
`@bsh/blockspace-tutor-kb` index. No database, no keys, no custody. Safe to run many replicas behind a load
balancer; the only state is an in-memory rate-limit bucket per instance.

## Start / stop

```bash
pnpm --filter @bsh/blockspace-tutor start   # reads env (env.schema.json)
```

Exit code `2` means a configuration error (message on stderr) — usually `LIVE_FACTS` on without
`LIVE_FACTS_URL`, or `CHAT_PROVIDER` on without all three `CHAT_*` values.

## Health

- `GET /healthz` → `{ status: "ok", mode, model, liveFacts }`. `mode: "extractive"` means no model is
  configured (expected default). `mode: "chat"` means a real provider is wired.
- `GET /` for full capabilities and limits.

## Common issues

| Symptom | Likely cause | Action |
|---|---|---|
| Every answer is `groundedness: "weak"` | Index missing/corrupt | `pnpm --filter @bsh/blockspace-tutor-kb refresh`, redeploy. |
| `429 rate_limited` | Per-IP bucket exhausted | Expected under load; raise `TUTOR_RATE_LIMIT_PER_MIN` or add a proxy bucket. |
| Answers cite but read oddly | Extractive mode | Configure `CHAT_PROVIDER` + `CHAT_BASE_URL`/`CHAT_API_KEY`/`CHAT_MODEL`. |
| `liveFacts` never present | Live facts off, or upstream down | Set `LIVE_FACTS=on` + `LIVE_FACTS_URL`; the port fails soft to `[]`. |
| Browser calls blocked by CORS | Origin not allowlisted | Add the widget host to `TUTOR_CORS_ORIGINS`. |

## Diagnosis only (never remediate on a live host)

- `curl -s $HOST/healthz` — mode and version.
- `curl -s $HOST/v1/ask -d '{"question":"what is a sat"}' -H 'content-type: application/json'` — smoke test.
- Refusals (`refused: true`) are correct behaviour, not errors — do not "fix" them.

## Secrets

Only `CHAT_API_KEY` is sensitive; it is a path (`services/blockspace-tutor/chat-api-key`), injected at runtime,
never logged. The service holds no user keys and no wallet material by design.
