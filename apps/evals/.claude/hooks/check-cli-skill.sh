#!/bin/sh
# PostToolUse drift guard: when the CLI surface (src/run.ts / src/init.ts /
# src/add-case.ts) changes, remind whoever's editing to review the
# `lastlight-evals` agent skill,
# which documents that surface and lives in the same monorepo (the `lastlight`
# plugin, under packages/cli). Pure POSIX sh — no jq / node dependency.
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

# Resolve where the skill lives. It's in the same monorepo, under packages/cli.
# The hook file sits at apps/evals/.claude/hooks/, so the monorepo root is four
# levels up from its own dir — independent of CLAUDE_PROJECT_DIR. Honour
# $LASTLIGHT_CORE_DIR as an override (also the monorepo root).
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mono_root=${LASTLIGHT_CORE_DIR:-$(CDPATH= cd -- "$hook_dir/../../../.." && pwd)}
skill_rel="plugins/lastlight/skills/lastlight-evals/SKILL.md"
skill_path="$mono_root/$skill_rel"

if [ -f "$skill_path" ]; then
  location="$skill_path (+ its references/)"
else
  # Different layout: point at the canonical in-repo path instead.
  location="$skill_rel in nearform/lastlight (the lastlight plugin); set LASTLIGHT_CORE_DIR to the monorepo root to resolve it locally"
fi

reminder="You edited the lastlight-evals CLI surface ($file_path). The 'lastlight-evals' agent skill documents this CLI (run/init/add-case/serve subcommands + flags) and lives in the same monorepo: $location. If you changed any subcommand, flag, default, or example, update the skill (SKILL.md and references/) in the same change so it doesn't drift."

# Emit as PostToolUse additionalContext so the reminder reaches the agent.
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' \
  "$(printf '%s' "$reminder" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed 's/^/"/; s/$/"/')"

exit 0
