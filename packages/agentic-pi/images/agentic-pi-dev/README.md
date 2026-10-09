# agentic-pi-dev image

Custom Gondolin micro-VM image for agentic-pi sandboxed runs. Boots
Alpine 3.23 with the development toolchain baked in (git, gh, node,
python, rust) so agents can `git clone && npm install && cargo build`
from the first turn — no `apk add` round-trip.

Used by `agentic-pi run --sandbox gondolin` by default. Override with
`--sandbox-image gondolin-builtin` (stock alpine-base) or
`--sandbox-image <abs-path>` (point at a local build).

## What's in it

| Tool | Source | Purpose |
| --- | --- | --- |
| `git`, `github-cli`, `openssh-client` | Alpine 3.23 | clone, push, auth via `GH_TOKEN`/`GITHUB_TOKEN` |
| `nodejs`, `npm` | Alpine 3.23 (Node 22 LTS) | JS/TS builds |
| `python3`, `py3-pip` | Alpine 3.23 (Python 3.12) | Python builds |
| `rust`, `cargo` | Alpine 3.23 (stable) | Rust builds |
| `build-base`, `musl-dev` | Alpine 3.23 | native compilation prereqs |
| `bash`, `curl`, `wget`, `jq`, `ripgrep`, `fd`, `file`, `ca-certificates` | Alpine 3.23 | general scripting + introspection |

All packages come from the Alpine 3.23 mirror — no custom `postBuild`
steps. The image is reproducible from `build-config.json` + the mirror
state at build time; the authoritative signature is the per-arch SHA256
recorded in `src/sandbox/images/manifest.ts`.

## Rebuilding locally

```bash
# Host arch only (fastest):
./scripts/build-image.sh

# Both arches (uses Docker for the non-native one on macOS):
./scripts/build-image.sh --all

# Specific arch:
./scripts/build-image.sh --arch x86_64
```

Output lands in `images/agentic-pi-dev/out-<arch>/`. Point agentic-pi
at it with:

```bash
agentic-pi run --sandbox gondolin \
  --sandbox-image "$(realpath ./images/agentic-pi-dev/out-aarch64)" \
  --model anthropic/claude-haiku-5-5
```

Pre-requisites: `gondolin` CLI on PATH (installed transitively via
`npm install`), plus host tooling `lz4`, `qemu-img`, `cpio`,
`e2fsprogs`. On macOS: `brew install lz4 qemu cpio e2fsprogs`. On
Debian/Ubuntu: `apt install lz4 qemu-utils cpio e2fsprogs`.

## Release flow

Image releases run via `.github/workflows/image.yml`, triggered by
pushing a tag matching `image-v*` (separate stream from the `v*` npm
release tags). The workflow builds both arches in parallel on
`ubuntu-latest`, attaches the tarballs + a `manifest.json` to the
GitHub Release, and that's it — there is no npm artifact for the
image.

After a release, copy the per-arch URLs + sha256s into
`src/sandbox/images/manifest.ts` and ship a new npm version so
end-users pick up the new `default` image.
