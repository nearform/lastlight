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

`ExecutorConfig` (`src/engine/github/profiles.ts:17–64`) carries:

| Field | Meaning |
|---|---|
| `cwd?` | Agent's working directory |
| `model?` | Provider/model — e.g. `anthropic/claude-sonnet-4-6` |
| `variant?` | Reasoning effort — `off | minimal | low | medium | high | xhigh` |
| `sandbox?` | Backend — `gondolin` (default) / `docker` / `smol` / `none` |
| `sessionsDir?` | Where the JSONL event log lands |
| `unrestrictedEgress?` | Opt out of the strict allowlist |
| `webSearch?` | Enable agentic-pi's web tools for this phase |
| `webSearchProvider?` | Force a specific provider (Tavily / Brave / Exa) |
| `agentContextDir?` | Where `agent-context/*.md` is read from |

`ExecutionResult` (`profiles.ts:69–91`) returns `success`, `output`,
`turns`, `error`, `durationMs`, `sessionId`, `costUsd`, token counts,
and `stopReason`.

## Backends

Four modes, all behind the **Sandbox port** (`src/sandbox/sandbox.ts`):
`provision` / `stageSkills` / `runAgent` / `runCommand` / `dispose`. The
`sandboxFor(backend, opts)` factory returns one of four adapters —
`DockerSandbox`, `SmolSandbox`, `InProcessSandbox` (`mode: gondolin | none`),
or the test-only `FakeSandbox`. Each adapter owns its isolation mechanism and
translates the intent-only `EgressPolicy` to its own controls.

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
  "issues-write": { contents: "read",  issues: "write", pull_requests: "read",  metadata: "read" },
  "review-write": { contents: "read",  issues: "write", pull_requests: "write", metadata: "read" },
  "repo-write":   { contents: "write", issues: "write", pull_requests: "write", workflows: "write", metadata: "read" },
};
```

Per phase:

1. `refreshGitAuth()` (`git-auth.ts`) mints a GitHub App installation
   token downscoped to the profile's permissions. Optionally scoped to
   a specific repository allowlist.
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
   `allowMcpAppAuth: true` — currently only `repo-write` does. The
   container entrypoint then copies `/data/secrets/app.pem` into the
   agent's home directory.
4. Low-trust sandboxes get `GITHUB_APP_PRIVATE_KEY_PATH=""` explicitly
   to short-circuit any inadvertent reads (`agent-executor.ts:80–82`).

The triage profile literally cannot push code, even if a prompt-
injected attacker convinced the agent to try.

## Agent-side tools

### Built-in github tools

The standalone `mcp-github-app` MCP server has been **removed** in the
agentic-pi migration. The agent now uses agentic-pi's built-in
`github_*` tools, gated by the `profile` option passed to `agenticRun()`.
agentic-pi auto-injects `GITHUB_TOKEN` / `GH_TOKEN` when the profile is
set.

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

## Container entrypoint (docker)

`deploy/sandbox-entrypoint.sh`, executed as root before privilege drop:

1. **Fix workspace ownership** — `chown -R agent:agent "$WORKSPACE"`.
2. **Materialize app.pem if high-trust** — copy
   `/data/secrets/app.pem` to `$AGENT_HOME/.config/app.pem` only when
   `ALLOW_APP_PEM=1`. Otherwise `GITHUB_APP_PRIVATE_KEY_PATH=""`.
3. **Write AGENTS.md** — `cat /app/agent-context/*.md > "$WORKSPACE/AGENTS.md"`.
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
4. **Teardown** — `docker rm -f` on completion or error.
5. **Boot-time cleanup** — `cleanupOrphanedSandboxes()` (`sandbox/index.ts:12–26`)
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
| Shared executor helpers (staging, accumulator, finalize) | `src/engine/executors/shared.ts` |
| `ExecutorConfig`, `GitAccessProfile`, profiles | `src/engine/github/profiles.ts` |
| Token minting + downscope | `src/engine/github/git-auth.ts` |
| Docker container driver (wrapped by the DockerSandbox adapter) | `src/sandbox/docker.ts` |
| smol micro-VM driver (wrapped by the SmolSandbox adapter, experimental) | `src/sandbox/smol.ts` |
| Sandbox dispatch + orphan cleanup | `src/sandbox/index.ts` |
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
