#!/usr/bin/env bash
#
# Wrapper around `gondolin build` for the agentic-pi-dev image.
#
# Usage:
#   ./scripts/build-image.sh                # host arch only
#   ./scripts/build-image.sh --arch x86_64  # specific arch
#   ./scripts/build-image.sh --all          # both arches
#
# Output: images/agentic-pi-dev/out-<arch>/

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/images/agentic-pi-dev/build-config.json"

# Auto-prepend known tool locations to PATH so users don't need to do it
# manually. (1) `node_modules/.bin` exposes the bundled gondolin CLI;
# (2) Homebrew keg-only e2fsprogs ships mkfs.ext4 under its own sbin.
if [[ -x "$ROOT/node_modules/.bin/gondolin" ]]; then
  PATH="$ROOT/node_modules/.bin:$PATH"
fi
if [[ "$(uname -s)" == "Darwin" && -d "/opt/homebrew/opt/e2fsprogs/sbin" ]]; then
  PATH="/opt/homebrew/opt/e2fsprogs/sbin:$PATH"
fi
export PATH

host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo aarch64 ;;
    x86_64|amd64) echo x86_64 ;;
    *) echo "Unsupported host arch: $(uname -m)" >&2; exit 2 ;;
  esac
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    case "$(uname -s)" in
      Darwin) echo "  Install with: brew install $2" >&2 ;;
      Linux)  echo "  Install with: apt install $2  (or your distro equivalent)" >&2 ;;
    esac
    exit 2
  fi
}

# Preflight: tools the gondolin build pipeline needs.
require gondolin "@earendil-works/gondolin"
require lz4 lz4
require qemu-img qemu
require cpio cpio
case "$(uname -s)" in
  Darwin) require mkfs.ext4 e2fsprogs || true ;;  # e2fsprogs ships mkfs.ext4
  Linux)  require mkfs.ext4 e2fsprogs ;;
esac

ARCHES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCHES+=("$2"); shift 2 ;;
    --all)  ARCHES=(aarch64 x86_64); shift ;;
    -h|--help)
      grep -E "^# " "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ ${#ARCHES[@]} -eq 0 ]]; then
  ARCHES=("$(host_arch)")
fi

for arch in "${ARCHES[@]}"; do
  if [[ "$arch" != "aarch64" && "$arch" != "x86_64" ]]; then
    echo "invalid --arch: $arch (expected aarch64 or x86_64)" >&2
    exit 2
  fi
  out="$ROOT/images/agentic-pi-dev/out-$arch"
  echo "==> Building agentic-pi-dev for $arch → $out"
  rm -rf "$out"
  gondolin build \
    --config "$CONFIG" \
    --arch "$arch" \
    --output "$out"
  echo "==> Built $out"
done

echo
echo "Done. To use the image:"
echo "  agentic-pi run --sandbox gondolin \\"
echo "    --sandbox-image \"\$(realpath images/agentic-pi-dev/out-${ARCHES[0]})\" \\"
echo "    --model anthropic/claude-haiku-5-5"
