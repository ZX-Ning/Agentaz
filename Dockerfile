FROM denoland/deno:debian-2.9.0 AS base

WORKDIR /project

COPY . .

RUN deno install

RUN deno task build:web-ui && deno task build:server

RUN cd build && deno install

RUN apt-get update -y && apt-get install -y patch

WORKDIR /project/build

RUN deno -A /project/scripts/utils/patch-pi-package.js < node_modules/@earendil-works/pi-coding-agent/package.json > tmp.json \
    && mv tmp.json node_modules/@earendil-works/pi-coding-agent/package.json

FROM denoland/deno:alpine-2.9.0

COPY --from=base /project/build /app

WORKDIR /app

ENV PI_CODING_AGENT_DIR="/root/.agentaz/agent"
ENV PI_WEB_CWD="/root/agentaz-workspace/"
ENV STATIC_FILE_DIR="/app/dist"
ENV AGENTAZ_PI_NODE_MODULES_DIR="/app/node_modules"

ENTRYPOINT [ "deno", "serve", "--host=0.0.0.0", "--port=3000", "-A", "main.js"]
