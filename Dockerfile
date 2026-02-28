FROM node:22-trixie

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

# Install codex binary
ARG CODEX_VERSION=rust-v0.94.0
RUN curl -fsSL "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/codex.tgz && \
    tar -xzf /tmp/codex.tgz -C /tmp && \
    install -m 0755 /tmp/codex-x86_64-unknown-linux-gnu /usr/local/bin/codex && \
    rm -rf /tmp/codex.tgz /tmp/codex-x86_64-unknown-linux-gnu

# Install goplaces binary
ARG GOPLACES_VERSION=v0.3.0
RUN curl -fsSL "https://github.com/steipete/goplaces/releases/download/${GOPLACES_VERSION}/goplaces_${GOPLACES_VERSION#v}_linux_amd64.tar.gz" -o /tmp/goplaces.tar.gz && \
    tar -xzf /tmp/goplaces.tar.gz -C /tmp && \
    install -m 0755 /tmp/goplaces /usr/local/bin/goplaces && \
    rm -rf /tmp/goplaces.tar.gz /tmp/goplaces

# Install gogcli binary
ARG GOGCLI_VERSION=v0.11.0
RUN curl -fsSL "https://github.com/steipete/gogcli/releases/download/${GOGCLI_VERSION}/gogcli_${GOGCLI_VERSION#v}_linux_amd64.tar.gz" -o /tmp/gogcli.tar.gz && \
    tar -xzf /tmp/gogcli.tar.gz -C /tmp && \
    install -m 0755 /tmp/gog /usr/local/bin/gog && \
    rm -rf /tmp/gogcli.tar.gz /tmp/gog

WORKDIR /app
RUN chown node:node /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
# Copy Matrix extension for native dependency installation
COPY --chown=node:node extensions/matrix ./extensions/matrix
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
USER root
ARG OPENCLAW_INSTALL_BROWSER="1"
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /opt/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      CHROME_BIN=$(find /opt/ms-playwright -name chrome -type f | head -n1) && \
      ln -sf "$CHROME_BIN" /usr/bin/chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright


USER node
COPY --chown=node:node . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# adding openclaw to path and making it executable
USER root
RUN chmod +x /app/openclaw.mjs && ln -sf /app/openclaw.mjs /usr/local/bin/openclaw
ENV NODE_ENV=production

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
