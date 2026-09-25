# syntax=docker/dockerfile:1.7
# Production image for @bsh/scribbit-mcp (products/scribbit/services/mcp): the
# scribb.it MCP server (HTTP transport via src/main.ts; `stdio` is a separate,
# non-networked entry point for local agent use and is not containerized here).
#
# Build context MUST be the repository root:
#
#   docker build -f deploy/docker/mcp.Dockerfile -t scribbit-mcp:local .
#
# Bundled with esbuild (see the package's "build" script) so the runtime stage
# ships no TypeScript toolchain. Health check: GET /healthz.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @bsh/scribbit-mcp build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3050
WORKDIR /app
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /workspace/products/scribbit/services/mcp/dist/main.js ./main.js
USER node
EXPOSE 3050
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3050)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
