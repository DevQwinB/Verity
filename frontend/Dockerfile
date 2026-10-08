# Verity dashboard (Next.js, standalone output).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
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
      --filter @verity/frontend...
COPY frontend frontend
# NEXT_PUBLIC_* values are compiled into the client bundle, so the network
# the wallet must be on is fixed when the image is built, not when it starts.
ARG NEXT_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ENV NEXT_PUBLIC_NETWORK_PASSPHRASE=$NEXT_PUBLIC_NETWORK_PASSPHRASE
RUN pnpm --filter @verity/frontend build

FROM base AS runner
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
# The standalone output mirrors the workspace layout: the server lives under
# frontend/, with the node_modules it traced at the root.
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/.next/static ./frontend/.next/static
COPY --from=build /app/frontend/public ./frontend/public
WORKDIR /app/frontend
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/icon.svg >/dev/null || exit 1
CMD ["node", "server.js"]
