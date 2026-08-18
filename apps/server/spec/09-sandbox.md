---
title: "Sandbox"
order: 9
description: "Where all agent work happens. The agentic-pi runtime, gondolin/docker/none backends, the SNI-peek egress firewall, the built-in GitHub and web-search tools, LLM provider routing, and per-run GitHub App token downscoping."
---

## Purpose

Every workflow phase from [Workflow Engine](/spec/06-workflow-engine)
that runs an agent does so by calling into this layer. The Sandbox is
the security boundary: it isolates the agent from the host, applies a
default-deny network egress policy, downscopes the GitHub App token to
what the workflow's profile allows, and forwards LLM provider keys so
the agent can actually reason.

The [Chat](/spec/11-chat) path does *not* go through this layer — it
runs in-process. Everything else does.

## Execution model: agent inside the boundary

Last Light puts the **entire agent process inside the isolation
boundary** — the `agentic-pi` runtime, its reasoning, and every tool it
calls (`bash`, `read`, `edit`, `write`, network egress) all run on the
inside. The harness mints a downscoped token and forwards provider keys
*into* the sandbox; the sandbox enforces default-deny egress from the
outside. This is deliberately **not** the tools-in-sandbox model, where
the agent runs on the host and only its write-capable tool calls are
marshalled out (e.g. via `docker exec`). Wrapping the runtime instead of
each tool keeps containment structural: there is no host-side code path
an agent tool could escape through, so a `read`-profile triage run cannot
reach the host even if a prompt injection convinces it to try. See
[ADR-0001](https://github.com/nearform/lastlight/blob/main/docs/adr/0001-agent-in-sandbox.md)
for the decision and the rejected alternative.

## Public contract

```ts
// src/engine/agent-executor.ts
export async function executeAgent(
  prompt: string,
  config: ExecutorConfig,
  opts?: {
    taskId?: string;
    onSessionId?: (sessionId: string) => void;
    githubAccess?: GitSandboxAccess;
  },
): Promise<ExecutionResult>;
```

`ExecutorConfig` (defined in `packages/workflow-engine/src/core/types.ts`,
re-exported through `src/engine/github/profiles.ts`) carries:

| Field | Meaning |
|---|---|
| `cwd?` | Agent's working directory |
| `model?` | Provider/model — e.g. `anthropic/claude-sonnet-4-6` |
| `variant?` | Reasoning effort — `off | minimal | low | medium | high | xhigh` |
| `sandbox?` | Backend — `gondolin` (default) / `docker` / `smol` / `none` / `kubernetes` |
| `sessionsDir?` | Where the JSONL event log lands |
| `unrestrictedEgress?` | Opt out of the strict allowlist |
| `webSearch?` | Enable agentic-pi's web tools for this phase |
| `webSearchProvider?` | Force a specific provider (Tavily / Brave / Exa) |
| `agentContextDir?` | Legacy — a single `agent-context/` directory. Accepted for call-site compatibility and ignored by `loadAgentContext`, which resolves layer-wise |
| `agentContext?` | **The run's already-composed `AGENTS.md` body.** Set by the runner when a repo layer applies; used verbatim by every delivery path (issue #180 — see "Agent context" below) |

`ExecutionResult` (`profiles.ts`) returns `success`, `output`,
`turns`, `error`, `durationMs`, `sessionId`, `costUsd`, token counts,
and `stopReason`.

## Backends

Five backends, all behind the **Sandbox port** (`src/sandbox/sandbox.ts`):
`provision` / `stageSkills` / `runAgent` / `runCommand` / `dispose`. The
`sandboxFor(backend, opts)` factory returns `DockerSandbox`, `SmolSandbox`,
`InProcessSandbox` (`mode: gondolin | none`, so it covers two backends),
`KubernetesSandbox`, or the test-only `FakeSandbox`. Each adapter owns its
isolation mechanism and translates the intent-only `EgressPolicy` to its own
controls.

The **orchestrator** (`src/engine/executors/orchestrator.ts`) drives any
adapter through that port: `withSandbox` brackets provision → work → dispose,
and `runSandboxedAgent` / `runSandboxedCommand` hold the skill staging,
build-artifact stage/harvest, the `RunResultAccumulator` + shim +
`recordPiEvent` event loop, and the single converged fallback path — written
once, over shared building blocks in `src/engine/executors/shared.ts`.
`executeAgent` / `executeCommand` (`agent-executor.ts`) mint the token, build
the env, and delegate. (This replaced the per-backend `executeDocker` /
`executeSmol` / `executeInProcess` twins.)

### `gondolin` — default

Agentic-pi's QEMU micro-VM. Invoked in-process via the `agenticRun()`
call inside `InProcessSandbox.runAgent` (`src/sandbox/sandbox.ts`,
`mode: gondolin`). The agent's working directory is
the host worktree mounted at `/workspace` inside the VM. Network
isolation is at the VM layer — agentic-pi's HTTP interceptor 502s any
outbound request whose host isn't on `allowedHttpHosts`.

### `docker` — container backend

Spawns a Docker container via `DockerSandbox` (`src/sandbox/docker.ts`).
The container runs `agentic-pi run --sandbox none` internally — the
isolation comes from the container plus the egress firewall, not from
agentic-pi's VM. Container name: `lastlight-sandbox-{taskId}-{uuid}`.

- Worktree bind-mounted at `/home/agent/workspace`.
- `/data` mounted from the shared data volume.
- Network: `lastlight_sandbox-egress` (internal — no host route).
- DNS: `--dns 172.30.0.10` (strict) or `--dns 172.30.0.11` (open).
- Memory: `--memory 2g --memory-swap 2g` by default.
- Timeout: 30 min default; runs longer than that are killed.
- Image: the lean `lastlight-sandbox:latest` (`sandbox.Dockerfile`) by
  default — built `FROM` the shared `lastlight-sandbox-base:latest`
  (`sandbox-base.Dockerfile`: `node:24-slim` as the default Node, with `fnm` for
  on-demand version switches when a repo pins one via `.nvmrc` / `.node-version`
  (fetched from nodejs.org, on the egress allowlist) — no extra Node versions are
  pre-baked — plus `python3`, `semgrep`/`gitleaks`, and `uv` for `type: script`
  `runtime: python`). The base
  holds the heavy, stable toolchain; each leaf image adds only a thin agentic-pi
  (vendored from the workspace via a `pnpm deploy` bundle built in the
  Dockerfile) + agent-context + entrypoint tail, so ordinary releases don't
  rebuild the sandbox images. The shared `/cache` package-manager volume
  is mounted with `npm_config_cache`/`YARN_CACHE_FOLDER`/`UV_CACHE_DIR` pointed
  at it; `UV_PYTHON_DOWNLOADS=never` pins `uv` to the baked-in `python3` so it
  never fetches an interpreter off-allowlist. A phase declaring
  `sandbox_image: qa` runs instead on
  `lastlight-sandbox-qa:latest` (`sandbox-qa.Dockerfile` — `FROM` the shared
  `lastlight-sandbox-base:latest`, so Chromium is a cached child of the stable
  base and survives ordinary releases; adds Playwright + a pinned Chromium
  baked at build time for the browser-QA
  path, and `ffmpeg` for the `demo` workflow's video-compositing step
  (`skills/demo/scripts/compose-demo.sh` transcodes the Playwright screen
  recording into a titled, size-capped mp4 — all offline); the egress allowlist
  never permits the Playwright CDN, so nothing is fetched at runtime). Both
  image names are fixed constants in
  `src/sandbox/images.ts`; `qaImageAvailable()` there lets the runner skip a
  `sandbox_image: qa` phase (a non-failing skip) when that image isn't built,
  so browser QA degrades gracefully on a lean host. Built only when QA is
  enabled — build the shared base first, then the leaves:
  `docker compose --profile build-only build sandbox-base` then
  `docker compose --profile build-only build sandbox sandbox-qa`.

### `smol` — micro-VM (smolvm), experimental

> **Spike / opt-in.** Not the default; enable with `LASTLIGHT_SANDBOX=smol`.
> Local-only: needs a host hypervisor (Apple Silicon Hypervisor.framework /
> Linux KVM) and the `smolvm` CLI on `PATH`. Verified against smolvm 1.2.5.

Structural peer of `docker`: Last Light owns the boundary via `SmolSandbox`
(`src/sandbox/smol.ts`), a wrapper over the **smolvm CLI** (`machine
create/start/exec/delete`), and runs `agentic-pi run --sandbox none` inside the
micro-VM. Isolation is a real kernel (libkrun), so it's stronger than a
container; the driver is the CLI because the embedded Node SDK is unpublished
and doesn't expose the egress allowlist.

- Worktree bind-mounted at `/workspace` — smolvm's special path, so the host
  dir is shared directly (no `virtiofs` carve-out other targets get). A
  boot-time probe (`resolveHostWorkspace`) confirms the host-side path and the
  harness clones/stages into it.
- **Image** (`SMOLVM_IMAGE`, default `lastlight-sandbox:latest`): smolvm's `-I`
  accepts a local `docker save` archive (`./img.tar`) or rootfs dir as well as
  a registry ref. The archive form needs no registry, so it loads offline under
  the strict allowlist — the locally-built sandbox image is consumed via
  `docker save lastlight-sandbox:latest -o img.tar`.
- **Egress**: native per-machine `--allow-host`, sourced from the same
  `egress-allowlist.ts`. No coredns/nginx sidecars. **Caveat:** smolvm resolves
  each host to IP(s) *at VM start* and aborts `create` on an unresolvable
  entry, so apex-only entries with no A record (e.g. `githubusercontent.com`)
  are pre-resolved and dropped. The filter is therefore **IP-pinned, not
  apex+subdomain** like docker (SNI) / gondolin (hostname) — `--allow-host
  github.com` does not cover `api.github.com` or rotating CDN IPs. A faithful
  policy would enumerate concrete subdomains; this is a known spike gap. There
  is also no SSRF metadata floor in `unrestrictedEgress` mode.
- **Secrets** (provider keys, `GITHUB_TOKEN`) injected via `--secret-env
  GUEST=HOST` so values never appear on the argv.
- `SMOLVM_BIN` overrides the binary path; `smolAvailable()` self-skips when
  absent. Teardown is `machine delete -f`.

### `kubernetes` — Kubernetes backend, in development

> **In development, not yet the default.** Enable with
> `LASTLIGHT_SANDBOX=kubernetes`. See
> [`deploy/k8s/README.md`](https://github.com/nearform/lastlight/blob/main/apps/server/deploy/k8s/README.md)
> for the cluster prerequisites and a ready-to-apply manifest set.

Runs each workflow phase as its own bare Pod via `KubernetesSandbox`
(`src/sandbox/k8s/kubernetes-sandbox.ts`) — a structural peer of `docker`
and `smol` behind the same `Sandbox` port, using per-namespace Pod
isolation instead of a shared host. `KubernetesSandbox` is a thin
orchestrator: it wires the collaborators that own the real work —
`WorkspaceProvisioner` (PVC vs `emptyDir`), `RunSecrets` (creds/prompt
Secret lifecycle), `EgressEnsurer` (the `CiliumNetworkPolicy` pair), and
the free functions in `pod-lifecycle.ts` (wait/stream/reap) — behind the
same `provision` / `stageSkills` / `runAgent` / `runCommand` / `dispose`
shape every other backend implements.

#### Pod lifecycle

Each `runAgent`/`runCommand` call becomes exactly one Pod, built by
`buildPodManifest` (`pod.ts`) and driven through `pod-lifecycle.ts`'s free
functions:

1. **Create** — `runPod` (`kubernetes-sandbox.ts`) creates the run's Secret(s)
   first (a Pod naming a missing Secret fails to start — see Credentials),
   builds the manifest, then calls `createNamespacedPod`. A `403 exceeded
   quota` rejection is caught and rethrown as a typed `QuotaExceededError`
   (see Concurrency below) instead of surfacing as an ordinary failure; on any
   other create failure the already-created Secret(s) are best-effort deleted
   so a rejected create never orphans one.
2. **Wait for container start** — `waitForContainerStart` polls
   `readNamespacedPodStatus` (budget ~180×1s ≈ 180s — sized for a cold pull of
   the ~400 MB sandbox image straight from GHCR to a node with no
   Spegel-mirrored layer yet) until the container leaves `waiting` with a
   non-fatal reason. A fatal `waiting` reason (bad image, config error) or a
   failed clone initContainer fails fast with the real reason instead of
   waiting out the whole budget. This gate exists because the kubelet log
   endpoint 400s until the container has actually started, so it's what makes
   the next step safe to call.
3. **Stream** — `streamPodLog` (`log-stream.ts`) follows the Pod's stdout and
   hands each line to a per-call callback: for `runAgent` that's agentic-pi's
   JSONL event stream (the container runs `agentic-pi run --sandbox none`),
   parsed through the same `parseLine` path the docker backend uses; for
   `runCommand` it's the command's raw stdout, captured verbatim.
4. **Reap** — `dispose()` deletes the Pod (Secrets cascade-GC via ownerRef —
   see Credentials), then `waitForPodGone` polls until the API 404s it
   (budget ~30×1s) before returning, so a sequential next-phase Pod reusing
   the same RWO PVC on a different node never races the still-detaching
   volume (an RWO Multi-Attach failure).

**Bare Pod, not a Job.** The workflow runner already owns run lifecycle —
ledger-driven resume, cancellation, admission — so a Job's own
retry/backoff/TTL semantics would duplicate and fight that. One Pod, created
and deleted by the harness (`restartPolicy: Never`), keeps a single source of
truth for "what's running."

**`activeDeadlineSeconds`** is a wall-clock cap stamped on every Pod
(`runCommand`'s `opts.timeoutSeconds`, or `runAgent`'s factory-level timeout,
default 1800s), so the kubelet itself kills a hung Pod at the budget;
`streamPodLog` resolves once the Pod terminates, so no separate
application-level timeout watchdog is needed.

**`type: bash` only, for now.** Deterministic phases run through `runCommand`
(`sh -c <cmd>`, stdout captured verbatim). A `type: script` phase is **rejected
up front** on this backend (`runSandboxedCommand`, `engine/executors/orchestrator.ts`):
the harness stages a script by writing its bytes into the run's host-shared
workspace, which every other backend bind-mounts into the guest — k8s has no
host-shared workspace (skills and `AGENTS.md` reach the pod over the HTTP
init-fetch channels below), and no channel yet stages the script into the pod,
so the phase fails fast with an actionable error rather than letting the Pod hit
`No such file or directory` at runtime. Delivering script bytes into the pod
(mirroring the skill bundle) is a tracked follow-up. No built-in workflow uses
`type: script` today.

#### Credentials

Every run's secrets travel in a **per-run creds Secret**, created before the
Pod (`RunSecrets.create`, `run-secrets.ts`) and consumed via `envFrom:
[{ secretRef }]` on both the agent container and every init container — never
inline pod-spec env, which is `kubectl get pod -o yaml`-visible (issue #223).
A `runAgent` call also creates a second **prompt Secret** holding the prompt
text, mounted read-only as a file at `/lastlight/prompt` and piped into
`agentic-pi run`'s stdin — never a CLI arg (`ps`-visible) or inline env.

- **Cascade GC.** Once the Pod exists, `RunSecrets.patchOwnerRefs` patches
  each Secret's `ownerReferences` to the Pod's uid, so deleting the Pod
  cascades to its Secret(s) automatically; `dispose()` also best-effort
  deletes them directly as a backstop.
- **Hard rule #8: the App PEM never crosses.** Only the harness, host-side,
  holds the GitHub App private key;
  per phase it mints a short-lived scoped installation token via
  `refreshGitAuth()` — identical to every other backend, see [Permissions and
  tokens](#permissions-and-tokens) above — and that minted token, never the
  PEM, is the only GitHub credential written into the creds Secret
  (`GIT_TOKEN`/`GITHUB_TOKEN`), alongside provider keys and whichever
  skill/agent-context/artifact fetch tokens the run needs. The k8s adapter
  has no code path that mounts, copies, or forwards the PEM into a sandbox
  Pod.
- **`automountServiceAccountToken: false`** on every sandbox Pod — an agent
  has no business calling the Kubernetes API, so it gets no ServiceAccount
  token at all. A compromised agent inside a Pod cannot talk to the API
  server, full stop.

#### Egress

The harness renders a strict/open **`CiliumNetworkPolicy`** pair per
namespace from the *same* `egress-allowlist.ts` every backend reads
(`egress-policy.ts` → `egress-apply.ts`, applied via `EgressEnsurer.ensure`,
once per namespace per harness process). Each sandbox Pod is labeled
`egress-policy: strict|open` (`egressModeFor`, derived from the phase's
intent-only `EgressPolicy.unrestricted`) — the label both policies'
`endpointSelector` match against.

- **Strict** = a DNS-proxy rule (port 53 to kube-dns, with `rules.dns:
  [{matchPattern:"*"}]` — load-bearing: without it Cilium's `toFQDNs` never
  learns an IP to allow) plus the allowlist's `toFQDNs` (apex `matchName` +
  `*.`-prefixed `matchPattern` per host) on 443/TCP. Default-deny everything
  else.
- **Open** = the same DNS rule plus a broad `0.0.0.0/0`/`::/0` allow on
  80/443, **minus** an except-list of private/link-local/loopback CIDRs
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
  `127.0.0.0/8`, plus the IPv6 equivalents) — the private-CIDR SSRF floor.
  Because Cilium's DNS proxy only ever permits connecting to an IP a Pod was
  *allowed to resolve*, a hostname whose A record points into private space
  is unreachable even in open mode — closing the gap the docker backend's
  SNI-peek firewall admits it cannot (see its Honest caveat above).
- Both policies add a **`toEndpoints` identity rule** scoping sandbox→harness
  traffic to the harness Pod's namespace + labels on the harness port — an
  identity selector, not a CIDR hole — so a sandbox Pod (under either egress
  mode) can always reach the three HTTP channels below.

**Current mechanism, not a permanent hard requirement.** Applying a
`CiliumNetworkPolicy` needs the `cilium.io` CRD verb on the harness's Role. On
a cluster where it's missing (no Cilium, or the verb isn't granted),
`EgressEnsurer.ensure` catches the resulting `403`, logs one warning per
namespace, and the run proceeds on the cluster's default network posture
instead of failing — no regression, just no enforcement; the identical code
enforces the moment the RBAC verb exists. A CNI-agnostic egress path (a plain
`NetworkPolicy` plus an out-of-band forward proxy, or a Gateway API
implementation) is a tracked follow-up, not yet built — see
`deploy/k8s/README.md`'s requirements matrix, which frames Cilium the same
way: today's implementation, not a design commitment.

#### Workspace

Two shapes, chosen per run by whether `provision()` receives a pre-clone
descriptor (`WorkspaceProvisioner`, `workspace-provisioner.ts`):

- **No pre-clone descriptor** → an ephemeral `emptyDir`, nothing touched
  cluster-side.
- **A pre-clone descriptor** → a stable **per-(repo,PR) RWO PVC**, named
  `ws-<owner>-<repo>-pr<N>` (sanitized, `pvcNameFor`), created once
  (404-then-create) and **reused by every later Pod for that PR** — RWO is
  safe because only one sandbox Pod per PR runs at a time. The agent's cwd
  becomes `<WORKSPACE_DIR>/<repo>`, the path the clone initContainer writes
  into.

The **clone initContainer** (`buildCloneInitContainer`, `init-clone.ts`) does
the checkout: shallow-clones the PR branch (falling back to cloning the
default branch and cutting the branch locally, for a build-style first run
with no remote branch yet). Owner/repo/branch/cwd/base/runId — the branch name
is attacker-controlled for an external PR — arrive as `sh` positional args
(`$1`..`$7`) to a fixed script, never interpolated into shell text, the same
command-injection-safe contract `run-agent-script.ts` uses.

**Reuse is marker-gated**, mirroring the host `prePopulateWorkspace`
(`src/sandbox/index.ts`). When the PVC already holds a checkout (`.git`
exists) the script compares a `<WORKSPACE_DIR>/.lastlight-run` marker (stamped
with the owning run id, kept outside the repo so `git clean` can't touch it)
against the run id passed as argv:

- **Same run** (marker matches, or no run id) → **preserve** the checkout — HEAD,
  the index and the work tree are left exactly as they are. Each workflow phase
  is its own Pod against the shared per-(repo,PR) PVC, so a later phase must read
  what an earlier one wrote (the architect's `plan.md`, the executor's edits) —
  an unconditional refresh would destroy that handoff. The one thing this path
  *does* refresh is `origin/<base>` (`ensure_base`, below): it writes
  remote-tracking refs only, so it cannot disturb the uncommitted scratch the
  path exists to keep. It is deliberately **not** paired with `reset_scratch` —
  this is not a new run.
- **Different run** (a fresh run reusing the PR's dir) → **refresh the head**:
  `git fetch` the head ref, `checkout -B` + `reset --hard` to it, then
  `git clean -fdx -e node_modules` (keeping the dependency tree warm). This is
  best-effort — a failed fetch preserves the existing checkout rather than
  leaving a half-reset tree — and closes the stale-checkout gap where a re-review
  after new commits reviewed the old head.
- **Different run + `recreateFromBase`** (`build`, issue #153) → discard the
  stale checkout and re-clone the default branch, cutting the feature branch
  locally off it, so a re-triggered incomplete build starts again off current
  `main` rather than a stale feature branch.

For PR-diff workflows the base branch (`PrePopulateSpec.baseBranch`, threaded
into the clone init) is fetched as a real `origin/<base>` ref and both refs are
deepened until they share a merge-base (depth 50 → 500 → `--unshallow`), so
`git diff origin/<base>...HEAD` — the three-dot PR diff the review agent and
post-review anchor against — resolves. `ensure_base` runs on **every** path:
the fresh clone, the different-run refresh, *and* the same-run preserve.

That last one is not redundant. Without it `origin/<base>` is frozen at whatever
the run's *first* phase fetched, so a fix phase merging it tens of minutes later
lands a base that is already superseded — which leaves the PR `dirty`, and GitHub
cannot compute a merge ref for a `dirty` PR, so no `pull_request` workflow is
created at all and `checksState` then reads green off whatever commit-status app
is left. `ensure_base` also adds the base to `remote.origin.fetch` (`git remote
set-branches --add`) before fetching, because `--depth` implies
`--single-branch`: without the extra refspec the agent's own `git fetch origin
<base>` moves `FETCH_HEAD` and nothing else, leaving the next `git merge
origin/<base>` on the stale ref. Every fetch passes an explicit `--depth`, since
a bare fetch into a shallow repository can deepen much further than intended.

Best-effort throughout (mirrors the host `ensureBaseAvailable`); skipped for a
`recreateFromBase` run.

RWO-only is a consequence of the reference deployment's storage: the
cluster's block/local `StorageClass` (see `deploy/k8s/README.md`'s
requirements matrix) supports `ReadWriteOnce` but not `ReadWriteMany`, which
pushed the whole design toward a stateless-pod model instead of a shared
harness↔pod volume. `fsGroup: <runAsUser>` +
`fsGroupChangePolicy: OnRootMismatch` on the Pod's `securityContext` lets the
non-root agent UID write a root-owned-by-default PVC mount without paying a
full recursive chown on every reuse. Idle PVCs are bounded by the same
reclaim/sweep machinery covered under Deployment below — there's no separate
workspace-specific cleanup path.

#### Harness↔pod HTTP channels

A sandbox Pod can't see the harness's filesystem, so three things ride the
same pattern: a per-run bearer token minted by the harness, carried into the
Pod's creds Secret, and redeemed against an `/internal/*` route on the
harness's own Hono app.

| Channel | Route | Direction | Token env var | In-pod consumer |
|---|---|---|---|---|
| Skill bundle | `GET /internal/skill-bundle` | harness → pod | `LASTLIGHT_SKILL_TOKEN` | `skills` initContainer (`init-skills.ts`) |
| Agent context (`AGENTS.md`) | `GET /internal/agent-context` | harness → pod | `LASTLIGHT_AGENT_CONTEXT_TOKEN` | `agent-context` initContainer (`init-agent-context.ts`) |
| Build artifacts | `POST /internal/sandbox-artifacts` | pod → harness | `LASTLIGHT_ARTIFACT_TOKEN` | tail of the generated run script (`run-agent-script.ts`) |

- **Skill bundle.** `stageSkills()` tars the phase's resolved skill dirs (core
  or overlay — resolution stays on the harness) via the system `tar` binary
  and registers the bytes under a fresh token in the (injectable,
  TTL-backstopped) `skillBundleRegistry` (`skill-bundle.ts`). The `skills`
  initContainer `curl`s the route with the token and unpacks into a shared
  `skills` emptyDir (`/lastlight-skills`) the agent reads via `--skill <dir>`.
- **Agent context.** This is the Task 14b addition (nearform#240) that
  replaced an earlier prompt-Secret ride-along: k8s has no host-shared
  workspace to write `AGENTS.md` into directly the way docker's entrypoint
  does (`cat /app/agent-context/*.md > $WORKSPACE/AGENTS.md`). The text is
  **not** re-composed here — it is handed to the adapter by the orchestrator
  through the `AgentContextSink` capability (`setAgentContext(text)`, declared in
  `src/engine/github/profiles.ts` beside the loader rather than on the `Sandbox`
  port, because exactly one backend needs it). `runAgent` registers whatever was
  handed over with `agentContextRegistry` (`agent-context-registry.ts`) — a
  dedicated registry, not a reuse of the skills one, because agent-context is
  **per-run-constant and must reach a no-skills phase too** — and the
  `agent-context` initContainer fetches it and writes it to
  `<WORKSPACE_DIR>/AGENTS.md` (the workspace root, never a cwd-relative path,
  so a repo-write phase's `git add -A` can't accidentally commit the bot's own
  persona file). Only when no caller offered a value does it fall back to the
  module-level `loadAgentContext()` — the pre-issue-#180 behaviour. An empty
  context registers no token and adds no initContainer.

  **Why the sink exists.** Agent context is resolved *layer-wise*, and a run may
  carry a layer the module-level loader has never heard of: the target repo's
  own `.lastlight/agent-context/*.md` (issue #180, see
  [Configuration](/spec/02-configuration)). The runner composes the text **once**,
  off that run's `AssetResolver` — built with `agentContextAdditiveOnly: true`,
  which is what drops a repo file whose basename an operator-owned layer already
  provides — and threads it as `ExecutorConfig.agentContext`. The orchestrator's
  `deliverAgentContext` then picks the delivery for the backend:
  `provideAgentContext(sandbox, text)` for kubernetes, a plain
  `writeFileSync(<hostWorkspaceDir>/AGENTS.md)` for every host-shared backend
  (docker / gondolin / none / smol), whose `hostWorkspaceDir` is a real host path.
  **Security-relevant:** the value is used verbatim on both paths. Re-composing
  it in an adapter would either drop the repo layer or — worse — include it
  without the additive-only filter, letting a managed repo neuter the operator's
  `security.md` / `rules.md` by committing a file of the same name. The
  per-instance field is per-run state (the orchestrator constructs one adapter
  per run), so it cannot leak between concurrent runs.
- **Build artifacts.** `runAgent` also mints an artifact-upload token from the
  (injectable) `artifactStore` up front; the generated run script's tail
  (present only when the run has a token) best-effort tars `.lastlight/` and
  `curl -X POST`s it to the route after the agent exits (`|| true` — an
  upload hiccup must never turn a successful agent run into a reported
  failure), bearer-authenticated with the same token pattern in reverse. The
  `artifactStore` is **host-local on every backend** (`LocalArtifactBackend`),
  so the uploaded bytes land at `<sandboxDir>/<taskId>/.lastlight/` on the
  *harness*, not in-cluster — which is why they need harness-side reclaiming
  (see below), independent of the Pod/PVC teardown.

**Host-side artifact reclaim.** Because those bytes are host-local, three paths
reclaim them: reap-on-success (`simple.ts`, ephemeral runs) and the admin
cancel route both `artifactStore.gc(taskId)` explicitly, and the backstop sweep
(`sweepK8sSandboxes`, below) age/LRU-reaps `<sandboxDir>/<taskId>` for the rest
(cancel-missed / failed / reuse-success) — since the host-dir sweep
(`src/cron/sandbox-sweep.ts`) is disabled on this backend, the k8s sweep covers
that surface too, not just cluster PVCs. Without it, host artifact storage would
grow unbounded on k8s.

All three routes 401 on a missing/wrong/unregistered token and are otherwise
backend-agnostic — with no k8s runs in flight, nothing is ever registered, so
every request is rejected. `dispose()` evicts whichever tokens the run minted
(skill, agent-context, artifact) from their registries regardless of
success/failure. The `toEndpoints` egress rule (see Egress above) is what
makes all three channels reachable from inside either egress policy.

#### Concurrency

The backend enforces no concurrency cap of its own — the cluster
namespace's `ResourceQuota` is the sole authority, and the app never reads
or tunes its value:

- The harness admits k8s-backend runs freely, gated only by an
  absurdly-high sanity fuse (`K8S_SANITY_FUSE = 1000`,
  `src/workflows/admission.ts`) — a runaway-loop backstop, not a tuned
  concurrency limit.
- Each phase attempts its own Pod create. When the namespace
  `ResourceQuota` is full, the API server rejects the create with
  `403 ... exceeded quota ...` (or, for a compute quota the pod doesn't meter,
  `403 ... failed quota: ... must specify ...`); `isQuotaExceeded`
  (`src/sandbox/k8s/quota.ts`) matches both phrasings and `KubernetesSandbox`
  maps the rejection to a typed `QuotaExceededError`, distinct from every other
  create failure. Sandbox pods (and their init containers) declare CPU/memory
  **requests** (no limits — `SANDBOX_AGENT_REQUESTS` / `SANDBOX_INIT_REQUESTS`
  in `pod.ts`) so a compute `ResourceQuota` can meter them and the scheduler can
  bin-pack; the per-namespace concurrency ceiling stays the quota's job.
- The orchestrator (`src/engine/executors/orchestrator.ts`) catches
  `QuotaExceededError` and stamps the phase result
  `stopReason: "error_quota"` instead of failing the run.
- `runWorkflow` (`src/workflows/runner.ts`) detects
  `stopReason: "error_quota"` and returns a
  `WorkflowResult & { backpressure: true }` — a server-layer
  intersection, not an engine change (see [Workflow Engine → Concurrency
  cap and
  admission](/spec/06-workflow-engine#concurrency-cap-and-admission)).
  `simple.ts` reacts to `backpressure` by calling
  `db.runs.requeueRunning()`, flipping the run `running → queued` instead
  of `failed` — the run stays live and waits for a slot instead of
  terminating.
  - **Ordering invariant.** The engine is backend-agnostic: on any phase
    failure it calls the `failWorkflow` reporter port, which normally
    finalizes the run `failed`. Because `requeueRunning` is CAS-guarded on
    `status = 'running'`, that finalize MUST be suppressed for a backpressure
    failure — otherwise the row is already `failed` when `simple.ts`/`resume.ts`
    calls `requeueRunning`, the CAS matches nothing, and the run is stuck
    `failed` instead of re-queued. `runner.ts` tracks a `quota.hit` flag (set
    the moment a phase returns `error_quota` OR throws `QuotaExceededError`) and
    makes both `failWorkflow` and the terminal `❌ failed` ping no-op while it
    is set, so the run is left `running` for the requeue to win. The same
    `runWorkflow` wrapper backs the fresh-dispatch and admission-drain
    (`resume.ts`) paths, so both are covered. (This is the fail-flip #8/#11
    missed: they converted the quota RESULT/THROW to backpressure but not the
    `failWorkflow` finalize that ran first.)
- The `AdmissionController` (`src/workflows/admission.ts`) runs in a
  **backpressure mode** for this backend
  (`backpressureMode: config.sandbox === "kubernetes"`): it gates
  promotion on `K8S_SANITY_FUSE` instead of `maxWorkflows`, and promotes
  at most **one** queued run per `admitNext()` call — each promotion is
  itself a quota probe (the promoted run re-queues immediately if the
  quota is still full), so probing one at a time avoids a burst of
  simultaneously rejected creates. Backlog drains at the periodic sweep
  cadence (15 s) plus real completions, whichever frees a slot first.

Real enforcement needs a namespace `ResourceQuota` object to actually exist —
see `deploy/k8s/sandbox-quota.yaml` for a ready-to-apply example (pod-count
only, paired with a `LimitRange` so the harness's deliberately
resource-request-only pod spec stays schedulable). Without one applied, the
mechanism is still build- and unit-tested, plus validated against a quota
staged manually via admin cluster credentials (the opt-in `KubernetesSandbox
Plan 6 quota-backpressure` case in
`tests/sandbox/k8s/kubernetes.integration.test.ts`, gated behind
`RUN_K8S_IT=1`).

#### Deployment

See [`apps/server/deploy/k8s/README.md`](https://github.com/nearform/lastlight/blob/main/apps/server/deploy/k8s/README.md)
for the full cluster-prerequisites matrix (RBAC, namespace/PodSecurity, the
`ResourceQuota`+`LimitRange` pair, an RWO `StorageClass`, Cilium, harness
reachability) and the `kubectl apply -k`-able manifest set
(`sandbox-namespace.yaml`, `sandbox-rbac.yaml`, `sandbox-quota.yaml`,
`harness-deployment.yaml`, `configmap.yaml`) that ships in
`apps/server/deploy/k8s/`.

### `none` — in-process

For local development. agentic-pi runs in the harness process with
`cwd` set to the host worktree, no isolation at all. Set via
`LASTLIGHT_SANDBOX=none`.

## agentic-pi invocation

```ts
result = await agenticRun({
  model,
  prompt,
  thinking,
  profile,                  // GitHub access profile — see below
  sandbox: backend === "gondolin" ? "gondolin" : "none",
  sandboxEnv,               // env forwarded into the agent's bash
  githubAuthEnv,            // THIS run's GitHub credential (see below) — never process.env
  cwd: agentCwd,            // the pre-cloned repo (workspace root if not pre-cloned)
  noSession: true,
  skillPaths,               // per-phase skill bundle dirs, absolute (see Skills §)
  allowedHttpHosts,         // egress allowlist or ["*"]
  webSearch: config.webSearch === true,
  webSearchProvider: config.webSearchProvider,
  onEvent: (record) => { shim.feed(record); /* ... */ },
  onWarn: (msg) => console.warn(`[agentic] ${msg}`),
});
```

The `onEvent` callback receives agentic-pi's `EmitterRecord` events —
`session`, `message_end`, `tool_execution_end`, `usage_snapshot`,
`fatal_error`. The shim (`src/engine/event-shim.ts`) translates them
into Claude-SDK-style JSONL envelopes — see [State §JSONL](/spec/10-state).

## Egress firewall

The same allowlist drives both backends. Defined in
`src/sandbox/egress-allowlist.ts`:

| Group | Hosts (apex + all subdomains) |
|---|---|
| `GITHUB_HOSTS` | `github.com`, `githubusercontent.com` |
| `PROVIDER_HOSTS` | `anthropic.com`, `openai.com`, `openrouter.ai` |
| `PACKAGE_REGISTRY_HOSTS` | `npmjs.org`, `yarnpkg.com`, `pypi.org`, `pythonhosted.org`, `crates.io`, `golang.org`, `rubygems.org`, `alpinelinux.org`, `debian.org` |

### gondolin enforcement

`allowedHttpHosts` is passed verbatim to `agenticRun()`. The VM's HTTP
interceptor returns 502 for any off-list request. Unrestricted egress
passes `["*"]`.

### docker enforcement — SNI peek

Four firewall services on the `sandbox-egress` network (subnet
`172.30.0.0/24`):

```
coredns-strict       172.30.0.10   allowlist hosts → nginx-strict IP; everything else NXDOMAIN
coredns-open         172.30.0.11   any host → nginx-open IP; SSRF hard-denies NXDOMAIN
nginx-egress-strict  172.30.0.20   ssl_preread SNI; tunnel allowlist hosts to upstream
nginx-egress-open    172.30.0.21   tunnel any SNI (DNS already gated)
```

The sandbox is given a coredns IP as its DNS resolver and *no proxy env*.
It dials real hostnames; the spoofed DNS routes them to nginx; nginx
peeks the TLS ClientHello SNI and tunnels to the real upstream via the
`proxy-egress` network. This works for every SDK regardless of whether
it honours `HTTP_PROXY` — the OpenAI and Anthropic SDKs don't, and
that's why the earlier tinyproxy approach failed.

Configs are generated by `src/sandbox/egress-firewall-config.ts` at
harness boot and bind-mounted read-only into the firewall containers.

### Strict vs open

`unrestricted_egress: true` on a phase opts into the `open` pair
(`coredns-open` + `nginx-egress-open`). The phase can reach hosts not
on the allowlist — useful for explore-style phases that need to read
arbitrary docs sites or hit a web-search API.

### SSRF floor

Even in open mode, the cloud-metadata literals are hard-blocked:

- `169.254.169.254`
- `metadata.google.internal`

`coredns-open` returns NXDOMAIN for these regardless. This is the
floor a misconfigured workflow cannot drop below.

### Honest caveat

TLS is not terminated. A hostname like `evil.example.com` whose A
record points at a private IP wouldn't resolve at all in strict mode
(coredns only knows allowlist hosts) — but in open mode it *would*
resolve to the open-nginx IP, and nginx would tunnel to whatever it
points at. Closing this requires real TLS termination (e.g.
Envoy + `dynamic_forward_proxy` with post-resolve IP checks). We haven't
pulled it in. The `nginx-egress-*` containers are not attached to any
network reachable from the harness process or the admin dashboard, so
the blast radius is contained to the sandbox network.

## Permissions and tokens

```ts
// src/engine/github/profiles.ts:93
export type GitAccessProfile = "read" | "issues-write" | "review-write" | "repo-write";

// :130–155
export const GITHUB_PERMISSION_PROFILES = {
  read:           { contents: "read",  issues: "read",  pull_requests: "read",  metadata: "read" },
  "issues-write": { contents: "read",  issues: "write", pull_requests: "write", metadata: "read" },
  "review-write": { contents: "read",  issues: "write", pull_requests: "write", metadata: "read" },
  "repo-write":   { contents: "write", issues: "write", pull_requests: "write", workflows: "write", metadata: "read" },
};
```

`issues-write` and `review-write` carry the **same token scopes**. Commenting
or labelling on a pull request requires `pull_requests: write` — GitHub
resolves `POST /repos/:owner/:repo/issues/:n/comments` against the *target's*
type (an issue checks `issues`, a PR checks `pull_requests`), and `write` is
the coarsest grain it offers. Without it a `pr-comment` / `verify` / `qa-test`
/ `demo` run 403s with "Resource not accessible by integration" the moment it
tries to post (issue #239). The two profiles stay distinct in the **tool set**
agentic-pi registers: only `review-write`+ gets
`github_create_pull_request` / `github_create_pull_request_review`. That
registration gate — not the token scope — is what stops a comment workflow
submitting a formal review.

Per phase:

1. `refreshGitAuth()` (`git-auth.ts`) mints a GitHub App installation
   token downscoped to the profile's permissions. Optionally scoped to
   a specific repository allowlist. **Whether to mint at all is decided from
   boot config** (`getRuntimeConfig().githubApp`, via `resolveGithubApp`), never
   from live `process.env` — see the invariant below.
2. The token (not the PEM) is forwarded into the sandbox via
   `GIT_TOKEN` and `GITHUB_TOKEN` env vars. Git operations authenticate
   with it through a **github.com-scoped `http.extraheader`** (Basic
   `x-access-token:<token>`) injected via `GIT_CONFIG_*` env in
   `agentGitIdentityEnv` (`sandbox/sandbox.ts`) — never a token in a clone
   URL, never a credentials file on disk. The header resolves via
   `git config --get-urlmatch` and is scoped to github.com only, so the
   token is never sent to package registries or other egress. The token can
   carry any character GitHub returns (`.`/`/`/`+`/`=`); it rides base64
   inside the header, so no charset guard is needed. See
   `sandbox/git-http-auth.ts`.
3. The PEM only reaches the sandbox if the profile sets
   `allowMcpAppAuth: true` — currently no profile does (see
   `gitSandboxAccessForWorkflow`). The container entrypoint would then copy
   `/data/secrets/app.pem` into the agent's home directory.

The triage profile literally cannot push code, even if a prompt-
injected attacker convinced the agent to try.

### Invariant: the published commit is built by GitHub, not by git

A commit object built inside the sandbox is unsigned, and the installation token
above cannot change that — the token authenticates the *push*, whereas a
signature is a property of the *commit object*. On a repo carrying GitHub's
`required_signatures` rule, one unsigned commit anywhere in the branch blocks
the pull request permanently and no later run can clear it (issue #268).

So every code-writing prompt publishes through **`github_publish`**
(`packages/agentic-pi/src/extensions/github/tools.ts`), registered only for the
`repo-write` profile — it is in `REPO_WRITE_TOOLS`, so `read` / `issues-write` /
`review-write` never see the tool at all. It diffs the working tree against the
branch's current remote tip and hands the change set to GraphQL
`createCommitOnBranch`, which builds and signs the commit server-side. The
committer is expected to be the App's `[bot]` identity under an installation
token — **unverified**: the probes behind this used a user PAT and got
`GitHub <noreply@github.com>`, so it stands until a real workflow phase is
checked end to end (`docs/plans/signed-commit-publish/00-findings.md` §5). No
signing key is held anywhere. Four consequences:

- **Local `git commit`s stay legitimate.** The tool publishes the *working
  tree*, so anything the agent committed locally is folded into the one signed
  commit rather than pushed as its own — which is what lets `dependabot-ci-fix`
  complete a base merge with `git add -A && git commit --no-edit` and still
  publish a signed result. Afterwards the tool `git fetch`es and
  `git reset --mixed`es the local branch onto the published commit, so the
  checkout a later phase inherits matches the branch.
- **The change set is scopeable.** `include` restricts the publish to a
  pathspec list — additions *and* deletions — and `exclude` subtracts pathspecs
  from whatever `include` left, so the two compose. The build family's artifact
  steps pass `include: [".lastlight"]`, so a phase's install or test run cannot
  sweep the rest of the checkout onto the branch.
- **It fails loudly rather than degrading.** A tip that moved is rejected, not
  merged over, at both ends: `expectedHeadOid` is non-null, so GitHub rejects a
  tip that moves after we read it (a `STALE_DATA` rejection is named as such,
  because GitHub's own REST-read/GraphQL-write lag can produce one with nobody
  racing), and the tool itself refuses a tip that had already moved *before* the
  read — `expectedHeadOid` accepts that one, and since the change set is the
  working tree measured against the tip, publishing it would record everything
  the other party added as a deletion. The check is `git merge-base
  --is-ancestor <tip> HEAD` against the sandbox checkout, and the refusal names
  a recovery per cause: `git reset --mixed` when the tip is a commit an earlier
  publish landed (the local sync having failed), and commit-then-merge when
  somebody else pushed — a bare `git merge` is not offered, because it aborts on
  the uncommitted changes this refusal always fires with. A change needing a file mode the
  API cannot express — a new executable file, a symlink, a submodule pointer, or
  a mode change on an existing file — is refused *before* anything remote is
  written, naming the files and, for a new script, the way out the agent can
  take itself (leave it non-executable, run it through its interpreter); a
  content-only edit to a file that is *already* executable is fine, because
  GitHub patches the base tree and keeps that entry's mode (measured in
  `docs/plans/signed-commit-publish/00-findings.md`). And the mutation's returned
  signature is asserted on every publish — `wasSignedByGitHub`, `isValid`, and
  the `signature: null` GraphQL returns for an unsigned commit. There is
  deliberately **no** fallback to `git push`: a fallback would publish exactly
  the unsigned commit the mechanism exists to prevent.
- **The branch need not exist yet.** It is created after every refusal check has
  run, so the build family never has to push a branch into existence first — at
  the newest commit the sandbox checkout and `base_branch` share (default: the
  repo's default branch), which is that branch's tip in the ordinary case and an
  older shared commit when the base branch moved on mid-run. Creating it at the
  *current* tip instead would leave the new branch ahead of the checkout, and
  the local `reset --mixed` above would then leave the workspace looking as
  though the base branch's newer files had been deleted.

The `http.extraheader` path above is unaffected and stays: `clone` / `fetch` /
`merge` still need the token, and the local scratch commits still need the
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` identity.

### Invariant: an in-process run mutates no globals

The container backends hand each run its own env, so they were always isolated.
The **in-process** backends (`gondolin` / `none`) are the sharp edge: the agent
runs *in the harness process*, and up to `concurrency.maxWorkflows` runs are live
in that one `process.env` at once. So `InProcessSandbox.runAgent` treats
`process.env` as **read-only** and passes everything per-run as an explicit
`agenticRun()` argument:

| Per-run value | Channel |
|---|---|
| The agent's `github_*` token | agentic-pi `githubAuthEnv` (`githubAuthEnvFrom(ctx.env)`) — **replaces** `process.env` inside agentic-pi, so an empty value means "no credential", not "fall back to the ambient env" |
| Git push/clone auth | `http.extraheader` via `GIT_CONFIG_*` in `agentGitIdentityEnv` (per-child env / the gondolin VM env) |
| The pre-clone | `PrePopulateSpec.token` (explicit argument) |
| Model credentials (OAuth store) | `authFile` (explicit argument) |
| Whether to mint at all | boot config (`getRuntimeConfig().githubApp`) |

The distinction that matters: a **credential scoped to one run** must be an
argument, whereas **process-wide configuration** — provider API keys, web-search
keys, OTEL settings — is ambient by nature. `prepareRun` copies those verbatim
*out of* `process.env` (see `getOtelEnvForSandbox`) for the container backends to
inject; agentic-pi and pi-ai read the same ambient env directly on the in-process
path. There is deliberately **no** write-back: the adapter used to splice that env
in and restore it afterwards, which was a no-op on the values (they were already
identical) with a race attached, and it made the env look per-run scoped when it
could not be. Deleting it removes the trap rather than narrowing it.

This is issue #215. The executor used to splice each run's token — plus
`GITHUB_APP_* = ""` — into the shared env for the duration of the agent turn,
which broke two ways: agentic-pi reads the env *late* (after `ModelRuntime.create()`
+ a `models.json` refresh), so a run starting inside that window captured a
sibling run's token — wrong repo, and read-only if that run's profile was narrower,
making every `github_*` write 403 with "Resource not accessible by integration"
while `git push` kept working; and interleaved restores permanently poisoned the
harness env (run B saved what run A had spliced, so B's restore reinstated A's),
leaving `GITHUB_APP_ID` falsy for good — after which the mint was **skipped
entirely** and a stale token forwarded to every subsequent run. Regression tests:
`tests/engine/agent-executor.concurrent-github-creds.test.ts` (overlapping runs
keep their own credential; `process.env` comes back byte-identical).

## Agent-side tools

### Built-in github tools

The standalone `mcp-github-app` MCP server has been **removed** in the
agentic-pi migration. The agent now uses agentic-pi's built-in
`github_*` tools, gated by the `profile` option passed to `agenticRun()`.
Their credential comes from `githubAuthEnv` (the harness's minted, downscoped
token — see the invariant above); on the gondolin backend agentic-pi also
auto-injects that same token into the VM as `GITHUB_TOKEN` / `GH_TOKEN` for the
agent's own `bash`.

### Web search — opt-in per phase

Three providers, auto-detected (Tavily > Exa > Brave). Keys are
forwarded into the sandbox *only when* the phase declares
`web_search: true`:

```ts
// agent-executor.ts:120–124
if (config.webSearch === true) {
  if (process.env.TAVILY_API_KEY)        env.TAVILY_API_KEY        = …
  if (process.env.BRAVE_SEARCH_API_KEY)  env.BRAVE_SEARCH_API_KEY  = …
  if (process.env.EXA_API_KEY)           env.EXA_API_KEY           = …
}
```

A phase that doesn't opt in cannot reach the search providers even if
the operator set the keys.

### Other built-ins

agentic-pi's standard kit: `bash`, `read`, `edit`, `write`, plus the
gated `web_search` and `github_*` families.

## LLM provider routing

Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`) are forwarded unconditionally
(`agent-executor.ts:112–114`). agentic-pi picks the provider from the
model string:

- `anthropic/...` → Anthropic Messages API
- `openai/...` → OpenAI Chat Completions
- `openrouter/<vendor>/<model>` → OpenRouter passthrough

Per-phase model and variant overrides resolve through
`config.models[phaseName]` and `config.variants[phaseName]` — see
[Configuration §models](/spec/02-configuration).

### Subscription (OAuth) providers — reach depends on the backend

Three providers authenticate by subscription login rather than a static key:
`anthropic` (Claude Pro/Max), `github-copilot`, and `openai-codex` (ChatGPT
Plus/Pro). They are registered in `OAUTH_PROVIDERS`
(`packages/shared/src/providers.ts`, separate from the API-key `PROVIDERS`),
and `lastlight oauth login` writes the credential store at
`$STATE_DIR/auth.json`. Where a token can reach the model call depends on
**where that call happens**:

| Backend | Model call runs | How the OAuth credential arrives |
|---|---|---|
| `gondolin` (default), `none` | Host-side, in the harness process | The orchestrator passes agentic-pi `authFile` = the credential store, and pi's `AuthStorage` resolves **every** OAuth provider from it, Codex included. Nothing is injected. |
| `docker`, `smol` | In-guest | The host path is unreadable there, so `agent-executor.ts` injects the provider's `sandboxEnvVar` (`ANTHROPIC_OAUTH_TOKEN` / `COPILOT_GITHUB_TOKEN`), refreshing it first. |

**Invariant: an OAuth provider with `sandboxEnvVar: null` is unusable on the
container backends only.** Codex is the one such provider — its chatgpt.com
backend has no in-guest env route — so a Codex model on `docker`/`smol` cannot
authenticate, and the executor logs a warning pointing at a host-side backend
rather than letting the run 401 mid-phase. It is **not** chat-only: on the
default `gondolin` backend it runs sandboxed phases like any other provider.
`OAUTH_ONLY_PROVIDERS` (Codex, Copilot) additionally have no API-key fallback,
so a missing login is warned about rather than silently degrading.

## Container entrypoint (docker)

`deploy/sandbox-entrypoint.sh`, executed as root before privilege drop:

1. **Fix workspace ownership** — `chown -R agent:agent "$WORKSPACE"`.
2. **Materialize app.pem if high-trust** — copy
   `/data/secrets/app.pem` to `$AGENT_HOME/.config/app.pem` only when
   `ALLOW_APP_PEM=1`. Otherwise `GITHUB_APP_PRIVATE_KEY_PATH=""`.
3. **Write AGENTS.md, if absent** — `cat /app/agent-context/*.md >
   "$WORKSPACE/AGENTS.md"`, guarded by `[ ! -f "$WORKSPACE/AGENTS.md" ]`. This is
   the **image-baked fallback**, not the normal path. The orchestrator writes the
   run's own composed context into the same host-shared path
   (`deliverAgentContext`, unconditionally overwriting) — and that is the only
   version that can include the target repo's additive `agent-context/*.md`, see
   "Agent context" above. An empty composition writes no file, which is exactly
   when this fallback matters.
4. **Signal readiness** — `touch "$WORKSPACE/.ready"`. The harness
   waits up to 15 s for this file before sending the first command.
5. **Drop privileges** — `exec gosu agent "$@"`.

The entrypoint no longer configures git identity or credentials: the bot
identity (`GIT_AUTHOR_*`/`GIT_COMMITTER_*`) and the github.com-scoped
`http.extraheader` auth both arrive as `GIT_CONFIG_*` env from
`agentGitIdentityEnv`, which reaches every `docker exec` — so there is no
`credential.helper store`, no on-disk credentials file, and no
`--system` git config. (`LASTLIGHT_GIT_CREDENTIALS` is now inert.)

## Lifecycle

1. **Pre-population** — if `prePopulateBranch` is set, the harness
   clones the repo into the worktree *before* starting the sandbox.
   The agent enters a workspace already checked out to the right
   branch, saving a `clone_repo` MCP call. The host clone uses a plain
   URL authenticated by a one-shot `-c http.extraheader` flag (nothing
   persisted), and `origin` is normalized to the credential-free URL on
   every path. Pre-clone errors are scrubbed (token **and** its base64)
   before logging (`sandbox/index.ts`).

   For a PR-diff workflow every path also runs `ensureBaseAvailable` — the fresh
   clone, the different-run refresh **and** the same-run preserve — so
   `origin/<base>` is current as of *this* phase rather than as of the run's
   first one. See the kubernetes backend's Workspace section above for why (a
   stale merge leaves the PR `dirty`, and GitHub builds no `pull_request`
   workflow for a `dirty` PR) and for the `remote.origin.fetch` refspec it adds
   so the agent's own `git fetch origin <base>` can refresh the ref too. It
   writes remote-tracking refs only — never HEAD, the index or the work tree.

   Every path that starts a **new** run also resets the two harness-owned
   files that live inside the checkout's own `.git/` — the fix loop's push
   gate (`.git/lastlight-verify.sh`, `resetVerifyScript`) and the PR journal
   (`.git/lastlight-notes`, `resetPrNotesJournal`). Both paths are stated
   once in `src/engine/fix-scratch.ts`.

   **Placement, not suppression, is what keeps them out of the pull request.**
   `.git/` is the repository, not the work tree: no pathspec walk enters it, so
   `git add -A` cannot see either file on any backend, with nothing to register
   anywhere. They used to sit at the root of the checkout and stay out of the PR
   because each backend added them to that checkout's local
   `.git/info/exclude` — and the kubernetes backend never got that code, so on
   k8s the harness's own scratch files were committed into the dependency PR
   (issue #256). A guarantee every new backend must re-implement is not a
   guarantee; the failure mode of forgetting is now a stale gate, which is
   recoverable and locally visible, rather than a committed file, which is
   neither.

   `.git/` rather than a workspace-root sibling because gondolin is the packaged
   default and mounts only cwd, so a `../` path is unreachable in the guest — a
   sibling gate would silently never run, and a sibling journal would silently
   never be written. `.git/` is *inside* cwd.

   The delete is therefore purely about **staleness**, and it is the only thing
   that clears either file: `git clean -fdx` does not enter `.git/`. The
   *same-run* preserve path deliberately skips both — a later phase of one run
   keeps the gate the first phase wrote, and the journal is drained per phase by
   the marker harvest rather than per run (see [State](/spec/10-state)). These
   two are the only things that path skips; the base-ref refresh above is not one
   of them, because it touches no file the checkout's phases can see. On the
   **kubernetes** backend the harness has no filesystem access to the PVC, so
   the same two deletes run inside the clone init container
   (`sandbox/k8s/init-clone.ts`), on exactly the same set of paths.

   The workflows invoke it as **`bash .git/lastlight-verify.sh`**, never
   `sh <script>`. The harness's own wrapper is `sh -c` (step 3 below) and
   `/bin/sh` in the sandbox image is dash, which rejects the `set -euo pipefail`
   the `fixing` skill has the agent open the script with — so `sh <script>` exited
   2 on line 2 and made the gate a constant RED in milliseconds, on every backend
   that runs this image. The loop still iterated, so it looked alive; what it
   could never do was go green. Naming the interpreter is what keeps the gate the
   harness scores identical to the one the agent ran and reported on — the agent
   executes the script directly, so its shebang is honoured there.

   That is the **unpushed** path, and it is the only path the harness-side gate
   still runs on. Both fix loops carry
   `until: "output.contains('outcome=pushed tried=')"` ahead of the
   `until_bash`, and `until` short-circuits it: once the agent reports
   `outcome=pushed`, the commit is on the branch, GitHub's checks are running
   against it, and a fresh container re-running a slower copy of that suite can
   change nothing — the gate's exit code only decides whether to spend another
   iteration. This deliberately leaves the agent's self-reported `gate=green` as
   the only local check *after* a push, which costs nothing that was not already
   given up: the gate runs after the push in this flow and so never gated it.
   See [Workflow engine](/spec/06-workflow-engine) → "The fix family's push
   short-circuit" for the full trade-off.

   The gate is also **recorded**: the marker harvest reads it (never drains it —
   it is the live gate the next iteration runs) onto
   `scratch.fixMarkers.verifyScript`, where the admin run detail panel renders
   it. The script is authored by the agent being gated and `until_bash` only
   reads its exit code, so recording it is the hardening 09-state-machine.md §S1
   asks for in place of validating its contents. That read resolves the checkout
   from the run ROW's `repo` column — not `context.repo`, which the dispatcher
   consumes and never persists, and which silently resolved every fix run's gate
   and journal to nothing. See [State](/spec/10-state).
2. **Spawn** — `docker run -d` or VM start. Container/VM mapped to the
   `taskId` in `activeContainers`.
3. **Run** — `docker exec -i -w <cwd> {container} sh -c "agentic-pi run ..."`
   with streaming stdout. Stderr captured to a tail buffer for error
   reporting. Deterministic `type: bash` / `type: script` phases (and the
   `generic_loop.until_bash` check) take the non-agent path:
   `DockerSandbox.runCommand` runs `docker exec --user agent -w <cwd> …
   sh -c <cmd>` and returns the exit code + captured stdout/stderr instead of
   an agent event stream. Script phases first write the inline source to a
   workspace-root sibling beside the skill bundle
   (`.lastlight-scripts/<phase>/script.<ext>`) and run it with
   `node` (js/ts) or `uv run` (python).
4. **Teardown** — `docker rm -f` on completion or error (the *container* only).
5. **Workspace reaping (issue #106)** — the on-disk clone under
   `$STATE_DIR/sandboxes/<taskId>/` is reaped separately from the container, by
   `reapSandboxWorkspace()` (`src/sandbox/reap.ts` — path-escape guard +
   live-container skip). An *ephemeral* run's dir is removed on terminal success
   (`reapOnSuccess`, `workflows/simple.ts`) and on admin cancel
   (`admin/routes.ts`); failures and the reusable/recreate per-target classes
   are left for the backstop. An hourly in-harness direct-cron sweep
   (`src/cron/sandbox-sweep.ts`, config `cleanup.sandbox.*`) removes non-live
   dirs older than `retentionHours` and LRU-evicts beyond `maxDirs`, bounding
   the reusable per-PR cache. Replaces the retired host cron
   (`scripts/cleanup-sandboxes.sh`, now manual-only).
6. **Boot-time cleanup** — `cleanupOrphanedSandboxes()` (`sandbox/index.ts:12–26`)
   kills any leftover `lastlight-sandbox-*` containers from prior
   crashes.

## Invariants

- **One container, one phase.** No sharing between phases or
  workflows. The container's blast radius is one phase's execution.
- **No host network for the sandbox.** The `sandbox-egress` network is
  declared `internal: true`. The sandbox can reach the egress firewall
  and nothing else — not the harness HTTP server, not the admin
  dashboard, not the proxy-egress network directly.
- **Allowlist is a single source of truth.** Both backends read the
  same constant. A change to allowed hosts is one file edit.
- **The PEM stays out unless explicitly allowed.** `allowMcpAppAuth`
  must be true *and* `ALLOW_APP_PEM=1` must be set on the container
  for the PEM to materialise. Default is no.
- **Provider keys are unconditional; web-search keys are gated.**
  The asymmetry is deliberate. The agent always needs to reason; it
  only sometimes needs the public web.
- **Pre-population is best-effort.** A pre-clone failure logs and
  proceeds; the agent will clone itself if needed.
- **TLS is not terminated.** Hostname-based filtering only — see the
  caveat above.

## Current implementation

| Piece | File |
|---|---|
| `executeAgent` / `executeCommand` + `prepareRun` (token mint, env) | `src/engine/agent-executor.ts` |
| Sandbox port + `sandboxFor` factory + adapters + `FakeSandbox` | `src/sandbox/sandbox.ts` |
| Orchestrator (`withSandbox` / `runSandboxedAgent` / `runSandboxedCommand`) | `src/engine/executors/orchestrator.ts` |
| Shared executor helpers (staging, accumulator, finalize, `withoutGitHubCredentials` / `githubAuthEnvFrom`) | `src/engine/executors/shared.ts` |
| `ExecutorConfig`, `GitAccessProfile`, profiles | `src/engine/github/profiles.ts` |
| Token minting + downscope | `src/engine/github/git-auth.ts` |
| Docker container driver (wrapped by the DockerSandbox adapter) | `src/sandbox/docker.ts` |
| smol micro-VM driver (wrapped by the SmolSandbox adapter, experimental) | `src/sandbox/smol.ts` |
| Sandbox dispatch + orphan cleanup | `src/sandbox/index.ts` |
| Workspace reaping (safe remove + live-container guard) | `src/sandbox/reap.ts` |
| Backstop TTL/LRU sweep (hourly direct cron) | `src/cron/sandbox-sweep.ts` |
| Sandbox image names + availability probe | `src/sandbox/images.ts` (`SANDBOX_IMAGE`, `SANDBOX_IMAGE_QA`, `qaImageAvailable`) |
| Browser-QA image | `sandbox-qa.Dockerfile`; bundled driver `skills/browser-qa/scripts/agent-browser.mjs` |
| Egress allowlist (source) | `src/sandbox/egress-allowlist.ts` |
| Firewall config generator | `src/sandbox/egress-firewall-config.ts` |
| Container entrypoint | `deploy/sandbox-entrypoint.sh` |
| Docker compose (firewall topology) | `docker-compose.yml` |
| Event shim (agent → JSONL) | `src/engine/event-shim.ts` |

## Rebuild notes

- **Pick your isolation level deliberately.** A re-implementation can
  choose container, VM, or unikernel — but the *contract* is the
  same: default-deny network, scoped token, isolated FS. Don't drop
  any of those by accident.
- **The whole agent goes in the box, not just its tools.** A reimpl
  that runs the agent on the host and marshals individual tool calls
  out to a sandbox (the tools-in-sandbox model) re-creates the
  host/container seam this design avoids — every tool then has to
  remember to route through the executor, and one that forgets gets
  host access. Wrap the runtime, not each tool. See ADR-0001.
- **Don't rely on HTTP_PROXY env vars.** Most SDKs ignore them. SNI
  peek + DNS sinkhole is what works generally; if you can do real
  TLS termination, do that — but only after exhausting the cheaper
  options.
- **The allowlist is data.** Keep it in one place, generate firewall
  configs from it, validate at boot. A drift between the harness's
  allowlist and the firewall's allowlist is silent and ugly.
- **Profile permissions are the audit trail.** A re-implementation
  should pick the smallest permission set that lets each workflow do
  its job. Over-broad profiles will be regretted the first time a
  prompt-injected attacker tries to escalate.
- **`unrestricted_egress` should be opt-in per phase, not per
  workflow.** Phases that need broad web access (explore research)
  should declare it; phases that don't (executor commits) inherit
  strict mode.
- **The PEM gate is not a knob; it's a wall.** A re-implementation
  that adds a "trust me, always materialize the PEM" option will be
  exploited.
- **Pre-population is an optimisation, not a contract.** The agent's
  prompt should assume the workspace might be empty; pre-population
  is a fast path, not the only path.
