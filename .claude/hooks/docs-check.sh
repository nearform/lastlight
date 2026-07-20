#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Fires before every Bash tool call.
#
# Purpose: when Claude is about to `git commit` a change that touches code
# paths whose docs live elsewhere (workflows, skills, routes, connectors,
# state, env, CLI), nudge it to run the `docs-sync` skill first — so the
# in-repo apps/server/spec/*.md and the apps/www site (same repo) don't drift.
#
# This is a NUDGE, not a gate. It exits 2 (feedback-to-Claude) only when
# doc-relevant code is staged with NO accompanying spec/ edit. To proceed
# without a docs update (genuine internal refactor), set the bypass:
#   LASTLIGHT_SKIP_DOCS_CHECK=1
# in the commit command's env. Manual commits in your own terminal never hit
# this hook — Claude Code hooks only fire on the agent's tool calls.

set -euo pipefail

# Read the tool call JSON from stdin and pull out the command. Node is always
# available in this repo; avoids a jq dependency.
payload="$(cat)"
cmd="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||"")}catch{process.stdout.write("")}})' 2>/dev/null || true)"

# Only act on git commits.
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# Honour the bypass.
if [ "${LASTLIGHT_SKIP_DOCS_CHECK:-}" = "1" ] || printf '%s' "$cmd" | grep -q 'LASTLIGHT_SKIP_DOCS_CHECK=1'; then
  exit 0
fi

repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repo_root" 2>/dev/null || exit 0

staged="$(git diff --cached --name-only 2>/dev/null || true)"
[ -z "$staged" ] && exit 0

# High-signal paths whose documentation lives in apps/server/spec/*.md and/or
# the apps/www site. Post-monorepo the server package sits under apps/server/,
# the CLI under packages/cli/, and the shared config/provider/overlay helpers
# under packages/shared/, so the patterns are prefixed accordingly.
trigger_re='^(apps/server/workflows/.*\.ya?ml|apps/server/config/default\.yaml|apps/server/skills/|apps/server/agent-context/|apps/server/src/connectors/|apps/server/src/state/|apps/server/src/engine/router\.ts|apps/server/src/engine/chat|apps/server/src/sandbox/|apps/server/src/config/|packages/cli/src/|packages/shared/src/(providers|overlay-bootstrap|overlay-assets|workflow-loader)\.ts)'

doc_relevant="$(printf '%s\n' "$staged" | grep -E "$trigger_re" || true)"
[ -z "$doc_relevant" ] && exit 0

# If a spec doc was also staged, assume docs were considered — let it pass.
if printf '%s\n' "$staged" | grep -qE '^apps/server/spec/.*\.md$'; then
  exit 0
fi

# Doc-relevant code staged with no spec/ edit → nudge (exit 2 feeds stderr to Claude).
{
  echo "📝 docs-sync check: this commit stages doc-affecting paths but no spec/*.md update:"
  printf '%s\n' "$doc_relevant" | sed 's/^/    - /'
  echo ""
  echo "Run the docs-sync skill to update apps/server/spec/ AND the apps/www site,"
  echo "then re-commit. If this change genuinely needs no docs (internal refactor),"
  echo "re-run the commit with LASTLIGHT_SKIP_DOCS_CHECK=1 prefixed."
} >&2
exit 2
