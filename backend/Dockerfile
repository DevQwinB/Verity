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
RUN pnpm install --frozen-lockfile --filter @verity/backend...

FROM deps AS build
COPY tsconfig.base.json ./
COPY db db
COPY backend backend
RUN pnpm --filter escrow-gate build \
 && pnpm --filter zk-verifier-registry build \
 && pnpm --filter @verity/backend build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/db/node_modules ./db/node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/db ./db
COPY --from=build /app/backend ./backend
WORKDIR /app/backend
EXPOSE 3001
CMD ["node", "dist/index.js"]
