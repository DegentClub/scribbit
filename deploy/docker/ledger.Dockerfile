# syntax=docker/dockerfile:1.7
# Production image for @bsh/ledger (platform/ledger): the platform ledger service
# (order intents, payee line items, receipts).
#
# Build context MUST be the repository root:
#
#   docker build -f deploy/docker/ledger.Dockerfile -t scribbit-ledger:local .
#
# Health check: GET /v1/health.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @bsh/ledger build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3050
WORKDIR /app
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /workspace/platform/ledger/dist/main.js ./main.js
USER node
EXPOSE 3050
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3050)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
