# Verity re-executor worker. Replays assigned submissions and votes on-chain
# with its own key (REEXECUTOR_SECRET_KEY).
#
# Submitted functions run in a WebAssembly sandbox inside the worker process,
# so this image needs no container runtime, socket or extra privileges.
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
      --filter @verity/reexecutor-agent...

COPY backend/src/chain/generated backend/src/chain/generated
RUN pnpm --filter escrow-gate build
COPY reexecutor-agent reexecutor-agent

ENV NODE_ENV=production
WORKDIR /app/reexecutor-agent
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]
