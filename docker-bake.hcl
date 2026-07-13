# Build definition for the four locally-built Last Light images, driven by
# the `images` job of .github/workflows/publish.yml via `docker buildx bake`.
#
# WHY BAKE: the sandbox leaves (sandbox, sandbox-qa) are `FROM
# lastlight-sandbox-base:latest`. Building each leaf as a separate `docker buildx
# build` FROM the *pushed* base tag keyed their layer cache on the base's image
# DIGEST — which drifts every build (image-config `created` timestamp + the
# provenance attestation) even when the base layers are byte-identical. That
# busted the registry cache on every release and re-ran the ~300 MB Chromium
# download (proven: sandbox-base:v0.12.7 and :v0.12.8 had different digests
# despite all 6 layers CACHED). Building the leaves in the SAME bake graph and
# wiring `FROM lastlight-sandbox-base:latest` to `target:sandbox-base` (below)
# keys the leaf cache on the base's CONTENT, not its pushed digest — so a
# content-identical base lets the leaves cache-hit across releases. All images
# keep their provenance + SBOM attestations (no reproducible-build hacks needed).
#
# The `contexts` key MUST match the leaves' `FROM` after ARG substitution — both
# default `ARG BASE_IMAGE=lastlight-sandbox-base:latest`, so we do NOT override
# BASE_IMAGE here (that's only for host `--local` / compose builds).

variable "REGISTRY" { default = "ghcr.io/nearform" }
variable "TAG" { default = "latest" }
variable "GIT_SHA" { default = "" }
variable "BUILD_DATE" { default = "" }
# Set true only on a real, non-prerelease Release, to also move :latest.
variable "PUSH_LATEST" { default = false }

function "tags" {
  params = [name]
  result = PUSH_LATEST ? ["${REGISTRY}/${name}:${TAG}", "${REGISTRY}/${name}:latest"] : ["${REGISTRY}/${name}:${TAG}"]
}

function "cache_from" {
  params = [name]
  result = ["type=registry,ref=${REGISTRY}/${name}:buildcache"]
}

function "cache_to" {
  params = [name]
  result = ["type=registry,ref=${REGISTRY}/${name}:buildcache,mode=max,image-manifest=true,oci-mediatypes=true"]
}

# The required set — must all succeed. sandbox-base is built once here and shared
# (as a content-keyed context) by the sandbox target.
group "core" {
  targets = ["agent", "sandbox-base", "sandbox"]
}

# Only the agent Dockerfile takes GIT_SHA / BUILD_DATE (the drift banner).
target "agent" {
  dockerfile = "Dockerfile"
  context    = "."
  tags       = tags("lastlight-agent")
  args       = { GIT_SHA = GIT_SHA, BUILD_DATE = BUILD_DATE }
  cache-from = cache_from("lastlight-agent")
  cache-to   = cache_to("lastlight-agent")
}

target "sandbox-base" {
  dockerfile = "sandbox-base.Dockerfile"
  context    = "."
  tags       = tags("lastlight-sandbox-base")
  cache-from = cache_from("lastlight-sandbox-base")
  cache-to   = cache_to("lastlight-sandbox-base")
}

target "sandbox" {
  dockerfile = "sandbox.Dockerfile"
  context    = "."
  # Override the Dockerfile's BASE_IMAGE to a bare placeholder and link that
  # name to the sandbox-base target — a bare, tag-less context name matches
  # `FROM ${BASE_IMAGE}` reliably (a registry-style `name:tag` key normalizes to
  # docker.io/... and won't match). Host `--local`/compose builds keep the
  # Dockerfile default (lastlight-sandbox-base:latest).
  args       = { BASE_IMAGE = "sandbox-base" }
  contexts   = { sandbox-base = "target:sandbox-base" }
  tags       = tags("lastlight-sandbox")
  cache-from = cache_from("lastlight-sandbox")
  cache-to   = cache_to("lastlight-sandbox")
}

# Non-fatal, optional tier — built in its own bake invocation (see the workflow)
# so a failure can't block the core images. It rebuilds sandbox-base as a
# content-keyed context dependency (cache-restored in seconds), which is what
# keeps its Chromium layer cached across releases.
target "sandbox-qa" {
  dockerfile = "sandbox-qa.Dockerfile"
  context    = "."
  args       = { BASE_IMAGE = "sandbox-base" }
  contexts   = { sandbox-base = "target:sandbox-base" }
  tags       = tags("lastlight-sandbox-qa")
  cache-from = cache_from("lastlight-sandbox-qa")
  cache-to   = cache_to("lastlight-sandbox-qa")
}
