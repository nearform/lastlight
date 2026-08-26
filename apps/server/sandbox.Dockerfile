# Sandbox image for Last Light agent tasks (LASTLIGHT_SANDBOX=docker
# fallback only — the default production sandbox is gondolin, invoked
# in-process by agentic-pi without docker).
#
# The heavy, stable toolchain (Debian deps, fnm + Node versions, semgrep/
# gitleaks, uv, the `agent` user) lives in the shared sandbox-base image so it
# stays cached across releases. This file adds only the THIN, frequently-changing
# tail: the vendored agentic-pi bundle + the baked agent-context + the entrypoint.
# Keep it that way — the same tail is duplicated in sandbox-qa.Dockerfile so
# Chromium stays a cached child of the base rather than of this churn.
#
# Build order matters (sandbox-base must exist first):
#   docker compose --profile build-only build sandbox-base sandbox
#
# BASE_IMAGE defaults to the local tag (host `--local` builds + docker compose
# resolve it from the local image store). CI overrides it to the just-pushed
# GHCR ref (`--build-arg BASE_IMAGE=ghcr.io/nearform/lastlight-sandbox-base:<tag>`)
# because the buildx docker-container driver resolves FROM from a registry, not
# the local store. See .github/workflows/docker-publish.yml.
ARG BASE_IMAGE=lastlight-sandbox-base:latest

# ── agentic-pi build stage ───────────────────────────────────────────────────
# The sandbox runs `agentic-pi run` (the harness `docker exec`s it per phase).
# We VENDOR agentic-pi from the in-repo workspace — build it here from source and
# COPY the deploy bundle below — instead of `npm install -g`ing the published
# tarball. Now that agentic-pi lives in this monorepo, installing from npm bought
# nothing but a drift hazard: `npm install -g` ignores pnpm-lock.yaml, so a caret
# transitive (e.g. `pi-coding-agent@^0.80.x`) resolved to whatever was latest at
# image-build time — which is how an upstream breaking change reached prod on a
# routine rebuild. Building from the workspace pins the WHOLE tree to exactly what
# CI resolved + tested. The npm package still publishes independently
# (.github/workflows/agentic-pi-npm.yml) for external consumers — that stream is
# now fully decoupled from what the sandbox runs.
#
# Mirrors the agent image's vendored build (apps/server/Dockerfile): manifests
# first so the install layer caches until deps change, then source, then
# `pnpm deploy` shapes a self-contained, lockfile-resolved tree.
FROM node:24-slim AS agentic-pi-build
# node:24 matches the sandbox base's runtime Node (node:24-slim), so any native
# deps compile for the ABI agentic-pi actually runs under.
# python3/make/g++ so optional native deps (e.g. ssh2's cpu-features, pulled in
# transitively via gondolin) compile instead of erroring out of the install.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/agentic-pi/package.json packages/agentic-pi/package.json
RUN pnpm install --frozen-lockfile --filter agentic-pi...
COPY packages/agentic-pi/ packages/agentic-pi/
RUN pnpm --filter agentic-pi build \
 && pnpm --filter agentic-pi deploy --prod /bundle

# ── lastlight CLI build stage ────────────────────────────────────────────────
# The review evidence pipeline's deterministic phases run `lastlight-facts`
# (pr-review.yaml resolves it via `command -v`), and the user rule is: NO
# standalone facts binary distribution — `lastlight facts` is a subcommand of
# the normal `lastlight` CLI and the `lastlight-facts` bin exists only as the
# CLI's dependency bin (`lastlight-code-facts` is a dependency of packages/cli).
# So we vendor the WHOLE CLI bundle, exactly like agentic-pi above: build from
# the workspace, `pnpm deploy` a self-contained lockfile-resolved tree, COPY it
# in content-addressed. This also enforces WP1's pinned-compiler rule — the
# bundle carries its own `typescript`, so facts never resolve the target repo's.
FROM node:24-slim AS lastlight-cli-build
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
 && pnpm --filter lastlight deploy --prod /bundle

# ── Sandbox image ────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE}

# agentic-pi, vendored from the build stage above. The bundle is a self-contained
# package tree (dist + prod node_modules, deps resolved from the lockfile);
# symlink its bin onto PATH so the harness can `docker exec … agentic-pi run …`.
# This COPY layer is content-addressed on the bundle, so it only busts when
# agentic-pi actually changes — sandbox-qa's Chromium (baked in the base) stays
# cached across ordinary releases, exactly as with the old pin file.
COPY --from=agentic-pi-build /bundle /opt/agentic-pi
RUN chmod +x /opt/agentic-pi/dist/cli.js \
 && ln -sf /opt/agentic-pi/dist/cli.js /usr/local/bin/agentic-pi

# lastlight CLI (carries `lastlight facts` + the lastlight-facts dependency
# bin), vendored from the build stage above — same content-addressed pattern.
# The wrappers pin the IMAGE's system node (/usr/local/bin/node) explicitly:
# fnm switches the `node` on PATH per repo .nvmrc, and a `#!/usr/bin/env node`
# shim would run the facts engine under whatever the target repo pins (possibly
# < 22, below the CLI's engines floor). /opt/lastlight/bin is also the baked
# fallback path pr-review.yaml echoes when `command -v lastlight-facts` fails —
# with these symlinks on /usr/local/bin it never should.
COPY --from=lastlight-cli-build /bundle /opt/lastlight
RUN mkdir -p /opt/lastlight/bin \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/lastlight/dist/cli.js "$@"\n' \
      > /opt/lastlight/bin/lastlight \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/lastlight/node_modules/lastlight-code-facts/dist/cli.js "$@"\n' \
      > /opt/lastlight/bin/lastlight-facts \
 && chmod +x /opt/lastlight/bin/lastlight /opt/lastlight/bin/lastlight-facts \
 && ln -sf /opt/lastlight/bin/lastlight /usr/local/bin/lastlight \
 && ln -sf /opt/lastlight/bin/lastlight-facts /usr/local/bin/lastlight-facts

# Agent context (baked at /app/ — entrypoint cats into workspace/AGENTS.md)
COPY apps/server/agent-context/ /app/agent-context/

# Entrypoint
COPY apps/server/deploy/sandbox-entrypoint.sh /app/sandbox-entrypoint.sh
RUN chmod +x /app/sandbox-entrypoint.sh

# Own app dir for agent user
RUN chown -R agent:agent /app /home/agent

WORKDIR /home/agent/workspace

# Image-level env so every `docker exec` (the entrypoint just runs once at
# container start) sees these. Exporting them in sandbox-entrypoint.sh only
# affects PID 1 — subsequent `docker exec agentic-pi run …` calls get a
# fresh environment and would otherwise miss these paths.
ENV LASTLIGHT_WORKSPACE=/home/agent/workspace
ENV LASTLIGHT_GIT_CREDENTIALS=/home/agent/.lastlight-git-credentials

# Entrypoint runs as root, fixes permissions, then drops to agent via gosu
ENTRYPOINT ["/app/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
