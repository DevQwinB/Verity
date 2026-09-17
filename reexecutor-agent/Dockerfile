FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY backend/src/chain/generated/escrow-gate/package.json backend/src/chain/generated/escrow-gate/package.json
COPY backend/src/chain/generated/zk-verifier-registry/package.json backend/src/chain/generated/zk-verifier-registry/package.json
COPY frontend/package.json frontend/package.json
COPY reexecutor-agent/package.json reexecutor-agent/package.json
COPY db/package.json db/package.json
RUN pnpm install --frozen-lockfile --filter @verity/reexecutor-agent...

FROM deps AS runner
ENV NODE_ENV=production
COPY backend/src/chain/generated backend/src/chain/generated
RUN pnpm --filter escrow-gate build
COPY reexecutor-agent reexecutor-agent
WORKDIR /app/reexecutor-agent
CMD ["pnpm", "start"]
