FROM ghcr.io/pnpm/pnpm:11 AS base

RUN pnpm runtime set node 24 -g

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine

WORKDIR /app

COPY --from=base /app/apps/web/.output /app/dist

ENV PI_CODING_AGENT_DIR="/root/.pi/agent"
ENV PI_WEB_CWD="/root/agentaz-workspace/"

ENTRYPOINT [ "node", "dist/server/index.mjs" ]
