# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f apps/worker/Dockerfile -t gym-worker .

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# --- prune: copy only what the worker needs
FROM base AS prune
RUN npm install -g turbo@2.11.10
COPY . .
RUN turbo prune worker --docker

# --- build: bundles everything into apps/worker/dist/index.mjs
FROM base AS build
RUN apk add --no-cache openssl && npm install -g pnpm@11.25.0
COPY --from=prune /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
RUN pnpm turbo run build --filter=worker

# --- run: just Node and the bundle
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production WORKER_HEALTH_PORT=4100
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs worker
COPY --from=build --chown=worker:nodejs /app/apps/worker/dist ./dist
USER worker
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.mjs"]
