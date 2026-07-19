# Shared heavy base for the Last Light sandbox images.
#
# This image holds everything STABLE and SLOW: the Debian toolchain, fnm +
# multiple Node versions, semgrep/gitleaks, uv, and the pinned `agent` user.
# Both leaf images build FROM it and add only their thin, frequently-changing
# tail (agentic-pi + agent-context + entrypoint):
#
#   sandbox-base  (this file)         node24 + fnm + semgrep/gitleaks + uv
#     ├── sandbox.Dockerfile          FROM base + agentic-pi + agent-context
#     └── sandbox-qa.Dockerfile       FROM base + Chromium/Playwright + tail
#
# The split exists for build-cache reasons: sandbox-qa bakes a ~300 MB Chromium.
# When Chromium sat on top of the frequently-changing base (agentic-pi pin,
# agent-context), every version bump re-downloaded it. Making Chromium a child
# of THIS stable base instead means an agent-context edit or agentic-pi bump
# rebuilds only the small tail — Chromium stays cached.
#
# Nothing frequently-changing belongs in this file. If you add a layer here,
# it invalidates BOTH leaf images (including the Chromium download), so keep it
# to genuinely-stable toolchain only.
#
# Build order matters — build this first:
#   docker compose --profile build-only build sandbox-base sandbox sandbox-qa
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gettext-base gosu \
    build-essential pkg-config python3 unzip \
    && rm -rf /var/lib/apt/lists/*

# fnm for ON-DEMAND Node switching so repos pinning a specific Node via .nvmrc /
# package.json#engines just work. The base's own system Node (24, from the
# node:24-slim image at /usr/local/bin) is the default; we deliberately DON'T
# pre-bake extra Node versions — that baked ~430 MB of toolchains for versions
# most runs never touch. Instead a repo pinning another version triggers
# `fnm install` + `fnm use` via the bashrc hook below, fetching from nodejs.org
# (on the sandbox egress allowlist, so it works under strict mode).
#
# CRITICAL: FNM_DIR is root-owned but the agent runs NON-ROOT (uid 10001), and
# `fnm install` writes the fetched Node into `$FNM_DIR/node-versions/`. `chmod
# -R a+rX` alone (read/execute, no write) means that on-demand install EACCESes
# and the hook silently falls back to system Node 24 — so a repo's .nvmrc pin is
# ignored. Both mutable dirs (`multishells` per-shell symlinks, `node-versions`
# on-demand installs) must be world-writable; sticky (1777) like /tmp.
ENV FNM_DIR=/usr/local/share/fnm
ENV PATH=$FNM_DIR/aliases/default/bin:$PATH
RUN curl -fsSL https://fnm.vercel.app/install \
      | bash -s -- --install-dir "$FNM_DIR" --skip-shell \
 && ln -s "$FNM_DIR/fnm" /usr/local/bin/fnm \
 && chmod -R a+rX "$FNM_DIR" \
 && mkdir -p "$FNM_DIR/multishells" "$FNM_DIR/node-versions" \
 && chmod 1777 "$FNM_DIR/multishells" "$FNM_DIR/node-versions"

# Source fnm in every bash invocation (interactive or not). BASH_ENV makes
# non-interactive `bash -c` read this file — that's how opencode's bash tool
# inherits the right node version when it runs `npm ci` inside a repo with
# an .nvmrc pinning Node 24.
RUN printf '%s\n' \
    'export FNM_DIR=/usr/local/share/fnm' \
    'export PATH="$FNM_DIR:$PATH"' \
    '# --shell bash is required: when sourced via BASH_ENV the parent process' \
    '# is not a shell so fnm cannot auto-detect.' \
    'eval "$(fnm env --shell bash --use-on-cd --version-file-strategy=recursive)"' \
    '# The cd hook fires only on cd. Tools often launch `bash -c "..."` with' \
    '# cwd already set via the spawn options — no cd happens — so also' \
    '# auto-switch on shell start when the cwd has a version file.' \
    'if [ -f "$PWD/.nvmrc" ] || [ -f "$PWD/.node-version" ]; then' \
    '  fnm use --silent-if-unchanged 2>/dev/null \' \
    '    || { fnm install 2>/dev/null && fnm use --silent-if-unchanged 2>/dev/null; } \' \
    '    || true' \
    'fi' \
    > /etc/bash.bashrc.fnm \
 && printf '\n[ -r /etc/bash.bashrc.fnm ] && . /etc/bash.bashrc.fnm\n' >> /etc/bash.bashrc \
 && ln -s /etc/bash.bashrc.fnm /etc/profile.d/fnm.sh
# Source the fnm file directly — Debian's /etc/bash.bashrc bails early on
# non-interactive shells (`[ -z "$PS1" ] && return`), so pointing BASH_ENV
# at it would skip our setup for `bash -c` invocations (which is the path
# the agent's bash tool uses).
ENV BASH_ENV=/etc/bash.bashrc.fnm

# pnpm / yarn via corepack. The base ships only npm, but repos pinning pnpm
# (pnpm-lock.yaml + a `packageManager` field) need a `pnpm` on PATH. `corepack
# enable` — run HERE as root — drops root-owned pnpm/yarn shims into
# /usr/local/bin; the non-root agent user can't do this itself at runtime (both
# `npm i -g pnpm` and `corepack enable` EACCES on the root-owned /usr/local, the
# exact failure seen when a build hit `pnpm: command not found`). The shims
# resolve each repo's pinned version at run time into the agent's writable
# corepack cache (~/.cache/node), and are Node-version-agnostic so they keep
# working after fnm switches Node. COREPACK_ENABLE_DOWNLOAD_PROMPT=0 keeps that
# first-run fetch non-interactive (a y/N prompt would hang the bash tool).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep \
    && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
       | tar -xz -C /usr/local/bin gitleaks \
    && apt-get purge -y python3-pip \
    # Drop the pip/pipx download + build caches semgrep's install leaves behind
    # (~tens of MB baked into this layer otherwise).
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/pip-* /tmp/*.whl

# uv — fast, isolated Python runner for `type: script` (runtime: python) phases.
# Single static binary; `uv run script.py` honours PEP 723 inline dependency
# blocks and resolves them into a cached venv (UV_CACHE_DIR is pointed at the
# shared /cache volume at runtime, mirroring the npm/pnpm/yarn cache wiring).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
 && uv --version

# Create non-root agent user, UID/GID pinned to 10001 to MATCH the harness
# `lastlight` user (see Dockerfile: `useradd -u 10001 lastlight`). The
# entrypoint chowns the bind-mounted workspace to `agent`; per-PR workspaces
# are persistent and reused across runs (issue #107), so the harness re-stages
# AGENTS.md + skills into them on the next run. If `agent` lands on the default
# uid (1001) those files become unwritable by the harness (10001) on reuse —
# EACCES, and the review silently runs with no skill/AGENTS.md. Sharing the uid
# keeps the reused workspace mutually writable by both the agent (in-container)
# and the harness (host). Also self-heals dirs left at 1001 by older images:
# the entrypoint's `chown -R agent:agent` re-owns them to 10001 on next reuse.
RUN groupadd -g 10001 agent && useradd -m -s /bin/bash -u 10001 -g 10001 agent
