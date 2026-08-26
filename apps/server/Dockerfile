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

# No compiler toolchain: the state layer moved from better-sqlite3 (node-gyp)
# to @libsql/client, which ships prebuilt bindings for linux glibc. If a
# transitive dep ever node-gyps on install, the fix is to find that dep — not
# to put python3/make/g++ back.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack — the version comes from the root `packageManager` field.
RUN corepack enable

WORKDIR /repo

# Workspace manifests first — deps layer changes only when these change.
# lastlight-core depends on the in-repo packages lastlight-shared,
# lastlight-workflow-engine, and agentic-pi (all workspace:*), so their
# manifests must be present for the filtered frozen install to resolve the
# workspace links AND install each one's own deps (agentic-pi's are needed to
# build it below — it's vendored, not pulled from npm anymore).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server/dashboard/package.json apps/server/dashboard/package.json
COPY packages/workflow-engine/package.json packages/workflow-engine/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agentic-pi/package.json packages/agentic-pi/package.json
RUN pnpm install --frozen-lockfile --filter lastlight-core... --filter @lastlight/dashboard...

# Workspace source: the server (with its nested dashboard) + its package deps.
COPY apps/server/ apps/server/
COPY packages/workflow-engine/ packages/workflow-engine/
COPY packages/shared/ packages/shared/
COPY packages/agentic-pi/ packages/agentic-pi/

# Build in dependency order (turbo's ^build graph, done explicitly here):
# agentic-pi + engine (leaves) → shared → core + dashboard. core's tsc imports
# agentic-pi's types from its dist, so it must be built first.
RUN pnpm --filter agentic-pi build \
 && pnpm --filter lastlight-workflow-engine build \
 && pnpm --filter lastlight-shared build \
 && pnpm --filter lastlight-core build \
 && pnpm --filter @lastlight/dashboard build

# Shape the runtime tree at /app (prod deps only, files per `files` field —
# pnpm deploy bundles the workspace deps' built dist into /app/node_modules).
#
# `drizzle/` (the generated migrations) rides that `files` field too — it is not
# a dependency, so nothing else puts it in the image, and `dist/state/db.js`
# resolves its migrationsFolder as `new URL("../../drizzle/sqlite", …)` =
# /app/drizzle/sqlite. Dropping "drizzle" from `files` is therefore a boot-time
# crash here as well as a broken npm tarball.
RUN pnpm --filter lastlight-core deploy --prod /app

# ── lastlight CLI build stage ────────────────────────────────────────────────
# WHY THE AGENT IMAGE CARRIES THE CLI: on the in-process sandbox backends
# (gondolin — the shipped default — and none), a workflow `type: bash` phase is
# NOT executed in the sandbox image at all. `InProcessSandbox.runCommand`
# (src/sandbox/sandbox.ts) spawns it on the host worktree via
# `spawnSync("sh", ["-c", …])` — i.e. inside THIS container. pr-review.yaml's
# deterministic phases resolve `command -v lastlight-facts`, so the bin must be
# on PATH here or the review evidence pipeline silently degrades in prod.
#
# We vendor the WHOLE `lastlight` CLI bundle (user rule: no standalone facts
# binary distribution — `lastlight facts` is a CLI subcommand and the
# `lastlight-facts` bin exists only as the CLI's dependency bin, from
# `lastlight-code-facts`). Same pattern as the sandbox images' vendored
# agentic-pi: workspace build → `pnpm deploy` bundle → content-addressed COPY,
# so the whole tree is exactly what the lockfile resolved and CI tested. The
# bundle also carries its own pinned `typescript`, enforcing WP1's
# pinned-compiler rule (never the target repo's).
FROM node:22-slim AS lastlight-cli-build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# The CLI's `prepare` script (scripts/copy-plugin.mjs) stages the repo-root
# plugin dirs into the package and pnpm runs it during install — so the script
# and both source dirs must be present BEFORE the frozen install.
COPY plugins/ plugins/
COPY .claude-plugin/ .claude-plugin/
COPY packages/cli/package.json packages/cli/package.json
COPY packages/cli/scripts/ packages/cli/scripts/
COPY packages/code-facts/package.json packages/code-facts/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/workflow-engine/package.json packages/workflow-engine/package.json
RUN pnpm install --frozen-lockfile --filter lastlight...
COPY packages/cli/ packages/cli/
COPY packages/code-facts/ packages/code-facts/
COPY packages/shared/ packages/shared/
COPY packages/workflow-engine/ packages/workflow-engine/
# Build in dependency order: code-facts + engine (leaves) → shared → cli.
RUN pnpm --filter lastlight-code-facts build \
 && pnpm --filter lastlight-workflow-engine build \
 && pnpm --filter lastlight-shared build \
 && pnpm --filter lastlight build \
 && pnpm --filter lastlight deploy --prod /cli-bundle

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

# System deps: git, ripgrep, docker CLI (for the docker-sandbox fallback
# only), gosu. No compiler toolchain here either — nothing is compiled in this
# stage at all (the runtime tree arrives prebuilt from the build stage below),
# so the python3/make/g++ that used to sit here was ~200 MB of dead weight.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gosu \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# Analysis scanners for the review evidence pipeline's `patterns` family —
# without them in THIS image, gondolin/none `type: bash` phases (which run here,
# see the lastlight-cli-build stage note) report the family silently `missing`.
# Version defaults MUST match `packages/code-facts/toolchain.json` (the pinned
# manifest the facts envelope stamps). Fetched per-ARCH — both tools publish
# linux arm64 assets at these exact versions, so an arm64 dev-host build works;
# CI publishes amd64.
ARG TARGETARCH
ARG GITLEAKS_VERSION=8.21.2
ARG OPENGREP_VERSION=1.27.1
RUN case "${TARGETARCH:-amd64}" in \
      arm64) GITLEAKS_ARCH=arm64; OPENGREP_ARCH=aarch64 ;; \
      amd64|"") GITLEAKS_ARCH=x64; OPENGREP_ARCH=x86 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin gitleaks \
 && curl -sSfL -o /usr/local/bin/opengrep \
    "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_${OPENGREP_ARCH}" \
 && chmod +x /usr/local/bin/opengrep \
 && gitleaks version && opengrep --version

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

# The vendored `lastlight` CLI bundle (see the lastlight-cli-build stage note).
# Placed at /opt/lastlight, with /opt/lastlight/bin also being the baked
# fallback path pr-review.yaml echoes when `command -v lastlight-facts` fails —
# with the /usr/local/bin symlinks it never should. The wrappers pin this
# image's node explicitly rather than `#!/usr/bin/env node`, mirroring the
# sandbox images (where fnm can swap the PATH node per repo pin).
COPY --from=lastlight-cli-build /cli-bundle /opt/lastlight
RUN mkdir -p /opt/lastlight/bin \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/lastlight/dist/cli.js "$@"\n' \
      > /opt/lastlight/bin/lastlight \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/lastlight/node_modules/lastlight-code-facts/dist/cli.js "$@"\n' \
      > /opt/lastlight/bin/lastlight-facts \
 && chmod +x /opt/lastlight/bin/lastlight /opt/lastlight/bin/lastlight-facts \
 && ln -sf /opt/lastlight/bin/lastlight /usr/local/bin/lastlight \
 && ln -sf /opt/lastlight/bin/lastlight-facts /usr/local/bin/lastlight-facts

COPY --from=build /app /app
# pnpm deploy packs per the `files` field — restore what it omits (do NOT
# widen `files`: the npm tarball file list is a fence).
COPY --from=build /repo/apps/server/dashboard/dist /app/dashboard/dist
# NOTE: `/app` must never hold an `AGENTS.md` or `CLAUDE.md`. `$STATE_DIR` is
# `/app/data`, so every sandbox workspace lives UNDER this directory — and on the
# in-process backends (gondolin, the shipped default, and none) pi's resource
# loader walks up from the agent's cwd to `/` collecting context files and
# inlines each into the system prompt. A `/app/CLAUDE.md` (this package's
# ~100 KB dev guide, which nothing at runtime reads) was therefore prepended to
# every agent prompt. Pinned by
# `tests/sandbox/agent-context-visibility.test.ts`.

RUN chmod +x /app/deploy/entrypoint.sh

# Let lastlight user write to /app (for mcp-config.json at startup) and own
# the frequently-read asset dirs (previously COPY --chown'd). No /app/CLAUDE.md
# here — the COPY that produced it was removed on purpose (see the NOTE above),
# and the stale chown of it made this stage unbuildable.
# Only chown /app itself, not node_modules — read-only and fine as root.
RUN chown lastlight:lastlight /app \
    && chown -R lastlight:lastlight /app/config /app/skills /app/agent-context /app/workflows

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
