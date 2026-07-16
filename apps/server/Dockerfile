# Agent image for the lastlight harness.
#
# This IS the deployed artifact: production runs the docker-compose stack and
# the `agent` service builds from this Dockerfile (see docker-compose.yml and
# CLAUDE.md's Deployment section). The aspirational native/systemd model in
# deploy/native/ is inactive. The same image is also used for local prod-like
# smoke testing and the LASTLIGHT_SANDBOX=docker fallback path.
#
# Monorepo layout (Phase 2): the BUILD CONTEXT is the repo root; the server
# package lives at apps/server/. A multi-stage pnpm workspace build compiles
# harness + dashboard in /repo, then `pnpm deploy --prod` shapes /app exactly
# like the pre-monorepo image (dist/, config/, workflows/, skills/,
# agent-context/, deploy/, node_modules/, package.json — pnpm deploy selects
# files per the package `files` field). dashboard/dist and CLAUDE.md are NOT
# in `files` (the npm tarball list is a fence) so they're restored with
# explicit COPYs. Runtime cwd stays /app, which is what keeps the admin SPA's
# cwd-relative `serveStatic({ root: "dashboard/dist" })` working (fence F3).

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

# python3/make/g++ for native modules (better-sqlite3) compiled during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack — the version comes from the root `packageManager` field.
RUN corepack enable

WORKDIR /repo

# Workspace manifests first — deps layer changes only when these change.
# @lastlight/core depends on the in-repo packages @lastlight/shared +
# @lastlight/workflow-engine (workspace:*), so their manifests must be present
# for the filtered frozen install to resolve the workspace links.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server/dashboard/package.json apps/server/dashboard/package.json
COPY packages/workflow-engine/package.json packages/workflow-engine/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @lastlight/core... --filter @lastlight/dashboard...

# Workspace source: the server (with its nested dashboard) + its package deps.
COPY apps/server/ apps/server/
COPY packages/workflow-engine/ packages/workflow-engine/
COPY packages/shared/ packages/shared/

# Build in dependency order (turbo's ^build graph, done explicitly here):
# engine → shared → core + dashboard. core's tsc + the dashboard need the
# built dist of the packages they import.
RUN pnpm --filter @lastlight/workflow-engine build \
 && pnpm --filter @lastlight/shared build \
 && pnpm --filter @lastlight/core build \
 && pnpm --filter @lastlight/dashboard build

# Shape the runtime tree at /app (prod deps only, files per `files` field —
# pnpm deploy bundles the workspace deps' built dist into /app/node_modules).
RUN pnpm --filter @lastlight/core deploy --prod /app

# ── Runtime stage ────────────────────────────────────────────────────────────
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

COPY --from=build /app /app
# pnpm deploy packs per the `files` field — restore what it omits (do NOT
# widen `files`: the npm tarball file list is a fence).
COPY --from=build /repo/apps/server/dashboard/dist /app/dashboard/dist
COPY --from=build /repo/apps/server/CLAUDE.md /app/CLAUDE.md

RUN chmod +x /app/deploy/entrypoint.sh

# Let lastlight user write to /app (for mcp-config.json at startup) and own
# the frequently-read asset dirs (previously COPY --chown'd).
# Only chown /app itself, not node_modules — read-only and fine as root.
RUN chown lastlight:lastlight /app \
    && chown -R lastlight:lastlight /app/config /app/skills /app/agent-context /app/workflows /app/CLAUDE.md

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
