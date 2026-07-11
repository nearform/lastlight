#!/bin/sh
# PostToolUse drift guard: when the CLI surface (src/run.ts / src/init.ts /
# src/add-case.ts) changes, remind whoever's editing to review the
# `lastlight-evals` agent skill,
# which documents that surface and lives in a SEPARATE repo (the `lastlight`
# plugin). Pure POSIX sh — no jq / node dependency.
#
# Reads the hook JSON from stdin, fires only for the two CLI-surface files, and
# emits a PostToolUse `additionalContext` reminder. Silent (exit 0) otherwise.

set -eu

payload=$(cat)

# Extract tool_input.file_path without jq: grab the first "file_path":"..." pair.
file_path=$(printf '%s' "$payload" \
  | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n 1 \
  | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Only the CLI surface of record matters here.
case "$file_path" in
  */src/run.ts|*/src/init.ts|*/src/add-case.ts|src/run.ts|src/init.ts|src/add-case.ts) ;;
  *) exit 0 ;;
esac

# Resolve where the skill lives. It's in a sibling repo, so degrade gracefully:
#   $LASTLIGHT_CORE_DIR if set, else <this repo>/../lastlight.
repo_dir=${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
core_dir=${LASTLIGHT_CORE_DIR:-"$repo_dir/../lastlight"}
skill_rel="plugins/lastlight/skills/lastlight-evals/SKILL.md"
skill_path="$core_dir/$skill_rel"

if [ -f "$skill_path" ]; then
  location="$skill_path (+ its references/)"
else
  # Fresh clone / different layout: point at the canonical home instead.
  location="$skill_rel in nearform/lastlight (the lastlight plugin); set LASTLIGHT_CORE_DIR to resolve it locally"
fi

reminder="You edited the lastlight-evals CLI surface ($file_path). The 'lastlight-evals' agent skill documents this CLI (run/init/add-case/serve subcommands + flags) and lives in a SEPARATE repo: $location. If you changed any subcommand, flag, default, or example, update the skill (SKILL.md and references/) in the same change so it doesn't drift."

# Emit as PostToolUse additionalContext so the reminder reaches the agent.
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' \
  "$(printf '%s' "$reminder" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed 's/^/"/; s/$/"/')"

exit 0
