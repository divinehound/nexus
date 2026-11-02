# Builds the web app on its own. The root Dockerfile's `web` target produces the same image.
FROM node:22-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Optional: baked into the bundle as a fallback for the runtime WALLETCONNECT_PROJECT_ID.
ARG VITE_WALLETCONNECT_PROJECT_ID

# Same install as the root Dockerfile, so the lockfile matches every workspace package.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/database/package.json packages/database/
COPY packages/types/package.json packages/types/
COPY packages/holder-analysis/package.json packages/holder-analysis/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @nexus/web build

FROM nginx:1.29-alpine
COPY apps/web/docker/nginx.conf.template /etc/nginx/nexus.conf.template
# nginx's entrypoint skips scripts that aren't executable.
COPY --chmod=755 apps/web/docker/40-nexus-config.sh /docker-entrypoint.d/40-nexus-config.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 3000
