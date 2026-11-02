# Builds the web app on its own. The root Dockerfile's `web` target produces the same image.
FROM node:22-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN pnpm install --frozen-lockfile --filter @nexus/web...

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @nexus/web build

FROM nginx:1.29-alpine
COPY apps/web/docker/nginx.conf.template /etc/nginx/nexus.conf.template
COPY apps/web/docker/40-nexus-config.sh /docker-entrypoint.d/40-nexus-config.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 3000
