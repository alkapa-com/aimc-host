# syntax=docker/dockerfile:1
#
# The aimc host agent, alone: Ollama runs in its own container or on the machine. Runs with a
# host token made on the website (see docker/README.md):
#
#   docker build -t aimc-host .
#   docker run --rm -e AIMC_SERVER_URL=https://your-server.example -e AIMC_HOST_TOKEN=... \
#     -e AIMC_OLLAMA_URL=http://ollama:11434 -e AIMC_MODELS=gemma3:12b aimc-host
#
# Built from this repository's sources, the same way npm installs the published packages.

# Node 24 (LTS) on Debian slim: glibc, so nvidia-smi from the NVIDIA container toolkit runs in it.
ARG NODE_IMAGE=node:24.22.3-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts/clean.mjs scripts/
COPY packages/protocol/package.json packages/protocol/
COPY packages/host/package.json packages/host/
RUN npm ci --no-audit --no-fund
COPY packages packages
# `npm pack` builds each package first (prepack), then packs exactly what npm would publish.
RUN mkdir /pkg && npm pack -w aimc-protocol -w aimc-host --pack-destination /pkg --silent

FROM ${NODE_IMAGE}
ARG IMAGE=alkapa/aimc-host
ARG VERSION=dev
LABEL org.opencontainers.image.title="aimc-host" \
      org.opencontainers.image.description="Lend your GPU: connects your Ollama to an aimc server. Outgoing HTTPS only, no open ports" \
      org.opencontainers.image.source="https://github.com/alkapa-com/aimc-host" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
# AIMC_CONTAINER: the agent waits for Ollama, and its update hint says to pull the new image.
# XDG_CONFIG_HOME: the settings folder is /config/ai-my-card-host, in the volume.
ENV NODE_ENV=production \
    AIMC_CONTAINER=1 \
    AIMC_IMAGE=${IMAGE} \
    AIMC_RUN=aimc-host \
    AIMC_LOG_DATES=1 \
    XDG_CONFIG_HOME=/config
RUN --mount=type=bind,from=build,source=/pkg,target=/pkg \
    npm install -g --no-audit --no-fund --omit=dev /pkg/*.tgz \
    && npm cache clean --force \
    && mkdir -p /config \
    && chown node:node /config
# The agent needs no rights: it only makes outgoing connections and writes its settings folder.
USER node
VOLUME /config
# Healthy while the agent runs and isn't stuck on something only you can fix (a refused token,
# another copy of this host connected). Waiting for approval or for Ollama counts as healthy.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const r=require('/config/ai-my-card-host/run.json');process.exit(Date.now()-Date.parse(r.updatedAt)<120000&&!['token_refused','blocked'].includes(r.state)?0:1)"]
ENTRYPOINT ["aimc-host"]
CMD ["start"]
