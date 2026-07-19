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
