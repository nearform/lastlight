# Sandbox image for Last Light agent tasks.
# Immutable assets baked at /app/. Entrypoint wires them into the workspace
# after volumes are mounted, then drops to the runtime user.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gettext-base gosu \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep \
    && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
       | tar -xz -C /usr/local/bin gitleaks \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

# Install OpenCode CLI (pinned; see .spike/PHASE0-FINDINGS.md). Global npm
# install puts the binary on PATH at /usr/local/bin/opencode for all users.
RUN npm install -g --no-audit --no-fund opencode-ai@1.15.5

# MCP server (baked at /app/)
COPY mcp-github-app/package.json /app/mcp-github-app/package.json
RUN cd /app/mcp-github-app && npm install --prefer-offline --no-audit && npm cache clean --force
COPY mcp-github-app/ /app/mcp-github-app/

# Agent context (baked at /app/ — entrypoint cats into workspace/AGENTS.md)
COPY agent-context/ /app/agent-context/

# Entrypoint + OpenCode config template
COPY deploy/sandbox-entrypoint.sh /app/sandbox-entrypoint.sh
COPY deploy/opencode-config.tmpl.json /app/opencode-config.tmpl.json
RUN chmod +x /app/sandbox-entrypoint.sh

# Own app dir for agent user
RUN chown -R agent:agent /app /home/agent

WORKDIR /home/agent/workspace

# Entrypoint runs as root, fixes permissions, then drops to agent via gosu
ENTRYPOINT ["/app/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
