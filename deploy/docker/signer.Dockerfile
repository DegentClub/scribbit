# syntax=docker/dockerfile:1.7
# Production image for @bsh/signer (platform/signer): the platform policy signer
# (holds keys behind a policy check; mint/studio call it over HTTP with a scoped
# @bsh/edge API key). This is the highest-trust service in the estate -- keep it
# on its own host/container, never colocated with a public-facing service.
#
# Build context MUST be the repository root:
#
#   docker build -f deploy/docker/signer.Dockerfile -t scribbit-signer:local .
#
# Health check: GET /v1/health.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @bsh/signer build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3060
WORKDIR /app
# Key material paths (see env.schema.json) live under /keys, mounted read-only where
# possible; audit log / state under /data.
RUN mkdir -p /data /keys && chown -R node:node /data /keys /app
COPY --from=build --chown=node:node /workspace/platform/signer/dist/main.js ./main.js
USER node
EXPOSE 3060
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3060)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
