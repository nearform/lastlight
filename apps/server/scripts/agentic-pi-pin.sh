#!/usr/bin/env bash
# Regenerate / verify sandbox/agentic-pi.pin — the two-line
# (version, sha512 integrity) pin the sandbox images use to install agentic-pi.
#
# WHY a committed pin file instead of COPYing pnpm-lock.yaml into the sandbox
# build: the lockfile's content hash changes on EVERY release (a version bump
# touches it), which busted the sandbox image's agentic-pi
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
# The single pnpm-lock.yaml lives at the WORKSPACE root (the monorepo root,
# two levels up from this package) — walk upward until we find it, so the
# script keeps working if the package ever moves again.
WORKSPACE_ROOT="$ROOT"
while [ ! -f "$WORKSPACE_ROOT/pnpm-lock.yaml" ]; do
  parent="$(dirname "$WORKSPACE_ROOT")"
  if [ "$parent" = "$WORKSPACE_ROOT" ]; then
    echo "pnpm-lock.yaml not found above $ROOT" >&2
    exit 1
  fi
  WORKSPACE_ROOT="$parent"
done
LOCK="$WORKSPACE_ROOT/pnpm-lock.yaml"
PIN="$ROOT/sandbox/agentic-pi.pin"
# The lockfile importer key for this package (`.` when the package IS the
# workspace root, else its relative path, e.g. `apps/server`).
IMPORTER="$(node -e "process.stdout.write(require('path').relative('$WORKSPACE_ROOT','$ROOT')||'.')")"

pin_from_lock() {
  node -e "const {parse}=require('$ROOT/node_modules/yaml'); \
           const fs=require('fs'); \
           const lock=parse(fs.readFileSync('$LOCK','utf-8')); \
           const dep=lock.importers?.['$IMPORTER']?.dependencies?.['agentic-pi']; \
           if(!dep) throw new Error('agentic-pi missing from lockfile'); \
           const version=dep.version.replace(/\(.*\$/,''); \
           const pkg=lock.packages?.['agentic-pi@'+version]; \
           if(!pkg?.resolution?.integrity) throw new Error('agentic-pi@'+version+' resolution missing from lockfile'); \
           process.stdout.write(version + '\n' + pkg.resolution.integrity + '\n')"
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
