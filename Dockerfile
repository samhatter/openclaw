# --- build gogcli with Go 1.25 ---
FROM golang:1.25-bookworm AS gogcli-build
RUN apt-get update && apt-get install -y --no-install-recommends git make ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/steipete/gogcli.git /src/gogcli
WORKDIR /src/gogcli
RUN make

# --- build goplaces with Go 1.25 ---
FROM golang:1.25-bookworm AS goplaces-build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/steipete/goplaces.git /src/goplaces
WORKDIR /src/goplaces
RUN go build -o /tmp/goplaces ./cmd/goplaces


# --- download codex binary ---
FROM alpine:3.21 AS codex-download
RUN apk add --no-cache curl ca-certificates
ARG CODEX_VERSION=latest
RUN mkdir -p /tmp/codex && \
    if [ "$CODEX_VERSION" = "latest" ]; then \
      DOWNLOAD_URL=$(curl -s https://api.github.com/repos/openai/codex/releases/latest | grep -oP '"browser_download_url": "\K[^"]*linux-x86_64[^"]*' | head -1); \
    else \
      DOWNLOAD_URL=$(curl -s https://api.github.com/repos/openai/codex/releases/tag/$CODEX_VERSION | grep -oP '"browser_download_url": "\K[^"]*linux-x86_64[^"]*' | head -1); \
    fi && \
    if [ -n "$DOWNLOAD_URL" ]; then \
      curl -fsSL "$DOWNLOAD_URL" -o /tmp/codex.tar.gz && \
      cd /tmp && tar -xzf codex.tar.gz && \
      find /tmp -name "codex" -type f -executable && \
      cp /tmp/codex /tmp/codex-bin || true; \
    fi


FROM node:22-bookworm

# ---- Browser deps (Chromium) ----
# Installs a real Chromium executable + common runtime libs + fonts.
# Keep this near the top so it layers well and is present for runtime.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libgtk-3-0 \
      libgbm1 \
      libasound2 \
      libxkbcommon0 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Common env var used by a bunch of tooling (Playwright/Puppeteer wrappers, etc.)
# On Debian/Bookworm, chromium is typically here:
ENV CHROME_BIN=/usr/bin/chromium

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app
RUN chown node:node /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Switch to node user and set ownership of /app
RUN chown node:node /app

USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

RUN pnpm install

RUN pnpm build
COPY --chown=node:node . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build

# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# bring in codex (as root)
USER root
COPY --from=codex-download /tmp/codex-bin /usr/local/bin/codex || true
RUN chmod +x /usr/local/bin/codex || true

# bring in gogcli (as root)
COPY --from=gogcli-build /src/gogcli/bin/gog /usr/local/bin/gog

# bring in goplaces (as root)
COPY --from=goplaces-build /tmp/goplaces /usr/local/bin/goplaces

# Security hardening: Run as non-root user
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
