# Verity backend: API, chain indexer and keeper. Also used, with a different
# command, to run the database migrations.
#
# The backend runs its TypeScript sources through tsx — the same way the
# local dev runner starts it, so the image exercises the one code path that
# is run every day.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY backend/package.json backend/package.json
COPY backend/src/chain/generated/escrow-gate/package.json backend/src/chain/generated/escrow-gate/package.json
COPY backend/src/chain/generated/zk-verifier-registry/package.json backend/src/chain/generated/zk-verifier-registry/package.json
COPY frontend/package.json frontend/package.json
COPY reexecutor-agent/package.json reexecutor-agent/package.json
COPY db/package.json db/package.json
# Downloaded packages are kept in a build cache shared by the three images,
# so a rebuild, or a retry after a dropped connection, does not start over.
RUN --mount=type=cache,id=verity-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store \
      --config.fetch-retries=5 --config.fetch-timeout=120000 \
      --filter @verity/backend...

COPY db db
COPY backend backend
RUN pnpm --filter escrow-gate --filter zk-verifier-registry build \
 && mkdir -p /app/backend/.artifacts \
 && chown -R node:node /app/backend/.artifacts

ENV NODE_ENV=production
WORKDIR /app/backend
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/health/live >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "src/index.ts"]
