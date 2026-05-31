FROM ghcr.io/pnpm/pnpm:11 AS base
RUN pnpm runtime set node 24 -g
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine
WORKDIR /app
COPY --from=base /app/apps/web/.output /app/dist
ENTRYPOINT [ "node", "dist/server/index.mjs" ]