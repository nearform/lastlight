#!/usr/bin/env bash
# Regenerate / verify sandbox/agentic-pi.pin — the two-line
# (version, sha512 integrity) pin the sandbox images use to install agentic-pi.
#
# WHY a committed pin file instead of COPYing package-lock.json into the sandbox
# build: the lockfile's content hash changes on EVERY release (`npm version`
# bumps its root `version` field), which busted the sandbox image's agentic-pi
# layer — and, because sandbox-qa is FROM the base sandbox, re-downloaded its
# ~300 MB Chromium — on every version bump. This tiny pin file changes ONLY when
# agentic-pi's version/integrity actually changes, so the layer (and Chromium)
# stays cached across ordinary releases. The Dockerfiles COPY this file; manual
# `docker compose build` needs no build-args.
#
# A drift guard (tests/agentic-pi-pin.test.ts) asserts this file matches the
# lockfile, so a forgotten regeneration fails CI rather than silently installing
# a stale agentic-pi.
#
# Usage:
#   scripts/agentic-pi-pin.sh            # regenerate sandbox/agentic-pi.pin
#   scripts/agentic-pi-pin.sh --check    # exit non-zero if it's out of date
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/package-lock.json"
PIN="$ROOT/sandbox/agentic-pi.pin"

pin_from_lock() {
  node -e "const p=require('$LOCK').packages['node_modules/agentic-pi']; \
           if(!p) throw new Error('agentic-pi missing from lockfile'); \
           process.stdout.write(p.version + '\n' + p.integrity + '\n')"
}

expected="$(pin_from_lock)"

if [ "${1:-}" = "--check" ]; then
  if [ ! -f "$PIN" ] || [ "$(cat "$PIN")" != "$expected" ]; then
    echo "sandbox/agentic-pi.pin is out of date — run scripts/agentic-pi-pin.sh" >&2
    exit 1
  fi
  echo "sandbox/agentic-pi.pin is up to date"
  exit 0
fi

mkdir -p "$ROOT/sandbox"
printf '%s\n' "$expected" > "$PIN"
echo "Wrote $PIN:"
cat "$PIN"
