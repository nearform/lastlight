# Sandbox image for Last Light agent tasks (LASTLIGHT_SANDBOX=docker
# fallback only — the default production sandbox is gondolin, invoked
# in-process by agentic-pi without docker).
#
# The heavy, stable toolchain (Debian deps, fnm + Node versions, semgrep/
# gitleaks, uv, the `agent` user) lives in the shared sandbox-base image so it
# stays cached across releases. This file adds only the THIN, frequently-changing
# tail: the pinned agentic-pi install + the baked agent-context + the entrypoint.
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
FROM ${BASE_IMAGE}

# Install agentic-pi globally so the harness can `docker exec ...
# agentic-pi run ...` against this container. The version + integrity come from
# `sandbox/agentic-pi.pin` (regenerated from lastlight's pnpm-lock.yaml by
# scripts/agentic-pi-pin.sh, drift-guarded by tests/agentic-pi-pin.test.ts). We
# COPY that tiny two-line file rather than the whole pnpm-lock.yaml on
# purpose: the lockfile's hash changes on every release and would rebust this
# layer (and sandbox-qa's Chromium) on every version bump; the pin changes only
# when agentic-pi actually does. `npm install -g <tarball>` doesn't consult a
# lockfile, hence the explicit integrity verification.
COPY sandbox/agentic-pi.pin /tmp/agentic-pi.pin
RUN version=$(sed -n '1p' /tmp/agentic-pi.pin) \
 && expected=$(sed -n '2p' /tmp/agentic-pi.pin) \
 && echo "Installing agentic-pi@${version} (${expected})" \
 && curl -fsSL "https://registry.npmjs.org/agentic-pi/-/agentic-pi-${version}.tgz" -o /tmp/agentic-pi.tgz \
 && actual="sha512-$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha512').update(f.readFileSync('/tmp/agentic-pi.tgz')).digest('base64'))")" \
 && if [ "$actual" != "$expected" ]; then \
      echo "agentic-pi tarball integrity mismatch:" >&2; \
      echo "  expected: $expected" >&2; \
      echo "  actual:   $actual" >&2; \
      exit 1; \
    fi \
 && npm install -g --no-audit --no-fund /tmp/agentic-pi.tgz \
 && rm /tmp/agentic-pi.tgz /tmp/agentic-pi.pin

# Agent context (baked at /app/ — entrypoint cats into workspace/AGENTS.md)
COPY agent-context/ /app/agent-context/

# Entrypoint
COPY deploy/sandbox-entrypoint.sh /app/sandbox-entrypoint.sh
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
