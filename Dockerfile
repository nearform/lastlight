# Agent image for the lastlight harness.
#
# This IS the deployed artifact: production runs the docker-compose stack and
# the `agent` service builds from this Dockerfile (see docker-compose.yml and
# CLAUDE.md's Deployment section). The aspirational native/systemd model in
# deploy/native/ is inactive. The same image is also used for local prod-like
# smoke testing and the LASTLIGHT_SANDBOX=docker fallback path.
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
#
# UID pinned to 10001 to match the `otel/opentelemetry-collector` image's
# user (see OTEL_COLLECTOR_UID in src/sandbox/egress-firewall-config.ts). The
# harness writes the OTLP collector config (which can carry backend auth
# headers) mode 0600 onto the shared agent-data volume; the collector reads it
# as UID 10001. Sharing the UID lets it read a 0600 file without running the
# collector as root or making the secret world-readable. If the collector
# image ever changes its UID, bump both together.
RUN useradd -m -s /bin/bash -u 10001 lastlight && usermod -aG docker lastlight

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
COPY --chown=lastlight:lastlight config/ config/
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
VOLUME ["/app/data"]

ENV STATE_DIR=/app/data
ENV LASTLIGHT_SESSIONS_DIR=/app/data/agent-sessions
ENV HOME=/home/lastlight
ENV NODE_ENV=production

# Build-stamp the core git SHA + date so the running harness knows its version
# (surfaced by GET /admin/api/server/info for the dashboard drift banner).
# `lastlight server update` passes --build-arg GIT_SHA=$(git rev-parse HEAD);
# absent the arg these stay empty → "unknown". Declared late so changing the
# SHA doesn't bust the source/build cache layers above.
ARG GIT_SHA=""
ARG BUILD_DATE=""
ENV LASTLIGHT_GIT_SHA=$GIT_SHA
ENV LASTLIGHT_BUILD_DATE=$BUILD_DATE

EXPOSE 8644

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "dist/index.js"]
