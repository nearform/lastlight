# Test-only image for the lastlight harness.
#
# Production runs lastlight natively under systemd on a KVM-capable Linux
# host (see deploy/native/). This Dockerfile is kept for local prod-like
# smoke testing and for the LASTLIGHT_SANDBOX=docker fallback path; it is
# not the deployed artifact.
FROM node:22-slim

# System deps: git, ripgrep, docker CLI (for the docker-sandbox fallback
# only), gosu, python3/make/g++ (for native modules like better-sqlite3).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gosu \
    python3 make g++ \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user. Add to docker group so the harness can spawn
# sibling sandbox containers via socket when LASTLIGHT_SANDBOX=docker.
RUN useradd -m -s /bin/bash lastlight && usermod -aG docker lastlight

WORKDIR /app

# Harness deps — change when package.json changes
COPY package.json package-lock.json* ./
COPY dashboard/package.json dashboard/package.json
RUN npm install --prefer-offline --no-audit \
    && npm cache clean --force

# TypeScript config
COPY tsconfig.json ./

# Harness source — changes often
COPY src/ src/

# Dashboard source
COPY dashboard/ dashboard/

# Build TypeScript harness + dashboard
RUN npm run build && npm run build:dashboard

# Deploy scripts — rarely change
COPY deploy/ deploy/
RUN chmod +x /app/deploy/entrypoint.sh

# Frequently changing content — copied last for best cache hits, owned by lastlight
COPY --chown=lastlight:lastlight skills/ skills/
COPY --chown=lastlight:lastlight agent-context/ agent-context/
COPY --chown=lastlight:lastlight workflows/ workflows/
COPY --chown=lastlight:lastlight CLAUDE.md ./

# Let lastlight user write to /app (for mcp-config.json at startup)
# Only chown /app itself, not recursively — node_modules etc. are read-only and fine as root
RUN chown lastlight:lastlight /app

# State directory — mount as Docker volume
# Entrypoint handles chown on /app/data at runtime
RUN mkdir -p /app/data/sessions /app/data/logs
VOLUME ["/app/data", "/app/secrets"]

ENV STATE_DIR=/app/data
ENV LASTLIGHT_SESSIONS_DIR=/app/data/agent-sessions
ENV HOME=/home/lastlight
ENV NODE_ENV=production
EXPOSE 8644

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "dist/index.js"]
