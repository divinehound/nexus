# Stage 1: Install dependencies
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/database/package.json packages/database/
COPY packages/types/package.json packages/types/
COPY packages/holder-analysis/package.json packages/holder-analysis/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile || pnpm install

# Stage 2: Build
FROM base AS build
# Optional: baked into the web bundle as a fallback for the runtime WALLETCONNECT_PROJECT_ID.
ARG VITE_WALLETCONNECT_PROJECT_ID
COPY . .
RUN pnpm build

# Stage 3: API production image
FROM node:22-slim AS api
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules

WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/main"]

# Stage 4: Web production image: the built SPA, served by nginx, which also proxies /api to the API
FROM nginx:1.29-alpine AS web
COPY apps/web/docker/nginx.conf.template /etc/nginx/nexus.conf.template
# nginx's entrypoint skips scripts that aren't executable.
COPY --chmod=755 apps/web/docker/40-nexus-config.sh /docker-entrypoint.d/40-nexus-config.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 3000
