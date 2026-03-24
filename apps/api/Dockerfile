FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/types/package.json packages/types/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter @nexus/database build
RUN pnpm --filter @nexus/types build
RUN pnpm --filter @nexus/api build
RUN pnpm deploy --filter @nexus/api --prod --legacy /app/out

FROM base AS runner
WORKDIR /app
COPY --from=build /app/out .
COPY --from=build /app/apps/api/dist ./dist

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/main"]
