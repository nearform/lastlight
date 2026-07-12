# Browser-QA sandbox image (Tier B) — lastlight-sandbox-qa:latest
#
# This is a SEPARATE, HEAVIER image, built only when headless-browser QA is
# enabled. Like the lean default sandbox it builds FROM the shared
# lastlight-sandbox-base image (fnm + Node + semgrep/gitleaks + uv + the agent
# user), then adds Playwright + a pinned Chromium and all the system libraries
# Chromium needs on Debian slim, and finally the same thin agentic-pi +
# agent-context + entrypoint tail as sandbox.Dockerfile.
#
# Build order matters — the shared base must exist first:
#   docker compose --profile build-only build sandbox-base sandbox-qa
#
# CACHE NOTE: Chromium (~300 MB) is installed BEFORE the agentic-pi/agent-context
# tail on purpose. Both this image and the lean sandbox build FROM the SAME
# stable base, so an agent-context edit or agentic-pi bump rebuilds only the
# small tail below — the Chromium layers stay cached. (Previously this image was
# FROM the lean sandbox, so those frequently-changing layers sat UNDER Chromium
# and re-downloaded it on every version bump.)
#
# Everything — the Chromium binary AND its shared-library dependencies — is
# baked at BUILD time. The strict HTTP egress allowlist
# (src/sandbox/egress-allowlist.ts) does NOT permit the Playwright/Chromium
# download CDN, so NOTHING may be fetched at runtime. A QA phase running in this
# image must be able to launch Chromium headless with no network access to the
# outside world (it only ever dials localhost / the repo's dev-server).

# BASE_IMAGE defaults to the local tag (host `--local` builds + docker compose
# resolve it from the local image store); CI overrides it to the just-pushed
# GHCR ref because the buildx docker-container driver resolves FROM from a
# registry, not the local store. See .github/workflows/docker-publish.yml.
ARG BASE_IMAGE=lastlight-sandbox-base:latest
FROM ${BASE_IMAGE}

# The base image ends as root; be explicit — we need root to apt-get install,
# npm install, and (in the tail below) chown.
USER root

# Chromium's runtime shared-library dependencies on Debian slim. This is the set
# `playwright install --with-deps chromium` would apt-get install on a
# Debian/bookworm base, listed explicitly so the install is deterministic and
# auditable (no implicit `--with-deps` network resolution beyond apt).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    libxi6 \
    libxtst6 \
    libglib2.0-0 \
    libdbus-1-3 \
    libexpat1 \
    libudev1 \
    fonts-liberation \
    fonts-unifont \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ffmpeg/ffprobe (installed above) back the `/demo` workflow's compositing step
# (skills/demo/scripts/compose-demo.sh): it transcodes the Playwright screen
# recording (webm) into a titled, trimmed, size-capped mp4. Baked at build time
# — the strict egress allowlist blocks runtime downloads, and compose runs fully
# offline. No Remotion / headless-render toolchain: the demo path is ffmpeg-only.
#
# Lock the contract compose-demo.sh depends on: the `drawtext` filter (title
# card + BEFORE/AFTER labels) and at least one Liberation font. Debian's ffmpeg
# ships drawtext (libfreetype) and fonts-liberation provides the TTFs, but assert
# it here so a future base/apt change can't silently produce an image that runs
# ffmpeg yet drops every text overlay. `grep -c` drains the output (no SIGPIPE).
RUN test "$(ffmpeg -hide_banner -filters 2>/dev/null | grep -c drawtext)" -ge 1 \
 && fc-list | grep -qi liberation \
 && echo "sandbox-qa: ffmpeg drawtext + Liberation fonts present"

# Install Playwright + Chromium into FIXED, world-readable paths so the non-root
# `agent` user (UID 10001, from the base image) can launch the browser.
#
# The package goes in a dedicated dir via a LOCAL `npm install` — deliberately
# NOT a global `npm install -g`. The base image puts fnm's node first on PATH
# (`ENV PATH=$FNM_DIR/aliases/default/bin:$PATH`), so a `-g` install lands in a
# versioned fnm global dir that's awkward to resolve. A local install in a fixed
# dir is deterministic regardless of which node/npm is active. The CLI imports
# it by the absolute path in $LASTLIGHT_PLAYWRIGHT (so resolution never depends
# on NODE_PATH / ESM bare-specifier rules).
#
# Playwright version pin: 1.49.1 (recent stable on the 1.49.x line). Pinning the
# package version also pins the Chromium revision Playwright downloads, so the
# baked browser is reproducible.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
ENV LASTLIGHT_PLAYWRIGHT=/opt/agent-browser/node_modules/playwright
ENV NODE_PATH=/opt/agent-browser/node_modules
RUN mkdir -p /opt/agent-browser \
 && cd /opt/agent-browser \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund playwright@1.49.1 \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
      /opt/agent-browser/node_modules/.bin/playwright install chromium \
 && chmod -R a+rX /opt/playwright-browsers /opt/agent-browser

# Validate at build time the same way the CLI loads playwright at runtime: a
# CJS `require` of the $LASTLIGHT_PLAYWRIGHT directory (require resolves a
# package dir via its package.json `main`; ESM `import()` of a directory is not
# supported). Fails the build early otherwise.
RUN node -e "const pw = require(process.env.LASTLIGHT_PLAYWRIGHT); if (!pw.chromium) throw new Error('playwright.chromium export missing'); console.log('playwright ok via ' + process.env.LASTLIGHT_PLAYWRIGHT);"

# ── Thin tail (kept in lockstep with sandbox.Dockerfile) ─────────────────────
# agentic-pi install from the committed pin + baked agent-context + entrypoint.
# These sit ABOVE the Chromium layers so an agent-context/agentic-pi change
# doesn't re-download the browser. See sandbox.Dockerfile for the full rationale.
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

# Image-level env so every `docker exec` sees these (see sandbox.Dockerfile).
ENV LASTLIGHT_WORKSPACE=/home/agent/workspace
ENV LASTLIGHT_GIT_CREDENTIALS=/home/agent/.lastlight-git-credentials

WORKDIR /home/agent/workspace

# Entrypoint runs as root, fixes permissions, then drops to agent via gosu
ENTRYPOINT ["/app/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
