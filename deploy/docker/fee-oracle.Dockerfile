# syntax=docker/dockerfile:1.7
# Production image for @bsh/scribbit-fee-oracle
# (products/scribbit/packages/scribbit-fee-oracle): aggregates fee-rate estimates
# from multiple sources for mint-api / mcp.
#
# Build context MUST be the repository root:
#
#   docker build -f deploy/docker/fee-oracle.Dockerfile -t scribbit-fee-oracle:local .
#
# Health check: GET /healthz.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @bsh/scribbit-fee-oracle build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /workspace/products/scribbit/packages/scribbit-fee-oracle/dist/main.js ./main.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
