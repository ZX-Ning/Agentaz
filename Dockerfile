FROM denoland/deno:ubuntu-2.9.0 AS base

WORKDIR /project

COPY . .

RUN deno install

RUN deno task build:web-ui && deno task build:server

RUN cd build && deno install

FROM denoland/deno:alpine-2.9.0

COPY --from=base /project/build /app

WORKDIR /app

ENV PI_CODING_AGENT_DIR="/root/.agentaz/agent"
ENV PI_WEB_CWD="/root/agentaz-workspace/"
ENV STATIC_FILE_DIR="/app/dist"
ENV AGENTAZ_PI_NODE_MODULES_DIR="/app/node_modules"

ENTRYPOINT [ "deno", "serve", "--host=0.0.0.0", "--port=3000", "-A", "main.js"]
