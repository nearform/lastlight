# Sandbox dependency services — design

Let a workflow phase run against a real **postgres / redis / mssql / vault**,
declared by the target repo, so a test suite that needs a database can actually
run in the sandbox.

Today it cannot, and the harness knows it: `skills/fixing/SKILL.md` instructs
the agent to read CI's `services:` block, name the gap, and record it as a
permanent fact about the repo — the skill even ships the canned example
(line 140):

> `constraint: the e2e job needs a postgres service; it can never run in this sandbox`

That note is the system correctly documenting a capability gap. No amount of
prompt work closes it: "run the e2e suite" needs a postgres to exist.

Sizing evidence — which repos need this, and the four findings that shaped the
design — is in [00-evidence.md](00-evidence.md). Read it first; several
decisions below are direct consequences of it.

## What is actually blocking it today

The framing that prompted this plan was *"sandboxes run inside docker, so they
can't spin up dependencies — maybe docker-in-docker?"*. The conclusion is
right; the stated cause is not, and the difference decides the cost.

**Sandboxes are siblings, not children.** The harness holds
`/var/run/docker.sock` (`apps/server/docker-compose.yml:36`) and calls
`docker run -d` against the *host* daemon (`src/sandbox/docker.ts:223`). There
is no nested daemon anywhere in the picture, so docker-in-docker solves a
problem this architecture does not have.

What actually stops an agent, in the order it would bite:

| # | Blocker | Evidence |
|---|---|---|
| 1 | **No `docker` binary in the sandbox image at all** | `sandbox-base.Dockerfile` installs `git ripgrep curl jq ca-certificates gettext-base gosu build-essential pkg-config python3 unzip`, plus fnm, corepack, semgrep, gitleaks, uv. No docker, podman, containerd or buildah |
| 2 | **No socket, even if there were a client** | `docker.ts:223-234` builds the complete `docker run` arg list — data volume, workspace, `/cache`, git mounts, env, memory caps, network, DNS — and never mounts the socket |
| 3 | **Non-root, so no install path** | entrypoint drops to `agent` (uid 10001) via gosu. Note the block is *privilege*, not the firewall: `debian.org` is on the egress allowlist (`egress-allowlist.ts:88`), so the packages are reachable |
| 4 | **Nothing to fall back on** | base is `node:24-slim` plus a dev toolchain. No database server of any kind |

On the kubernetes backend it is tighter still: no socket,
`automountServiceAccountToken: false`, `runAsNonRoot`,
`allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]`
(`src/sandbox/k8s/pod.ts:92-152`).

**None of these are defences erected against dependency containers.** They are
the ordinary consequences of a least-privilege sandbox scoped to "run the agent
and the repo's toolchain". Nobody blocked this — it was never built.

That diagnosis sets the price. If nesting were the blocker the fix would be
DinD, sysbox or a rootless nested daemon: privileged, invasive, a real security
downgrade. Because the blocker is "the harness never offered it", the fix is
**the harness provisioning a sibling on the agent's behalf**. The sandbox gains
no new privilege — no socket, no root, no docker binary. Postgres simply
appears on `localhost:5432`.

## Locked decisions

Settled in a design interview on 16 Aug 2026. Recorded with reasoning because
three were decided against the first-instinct answer.

| # | Decision | Why |
|---|---|---|
| 1 | **The repo declares services in `.lastlight/`** — not derived from CI, not requested by the agent at runtime | Deriving from CI dies on the evidence: 25% of the sample interpolates the image from a matrix, `temporal_tables` across ten postgres versions, with no defensible default; and to be safe it would have to read the default branch anyway, which is what it was meant to improve on. A runtime agent tool is blocked outright by decision 3 — see below |
| 2 | **Services share the sandbox's network namespace** — k8s native sidecars, docker `--network container:<sandbox>` | Eliminates DNS, Service objects, cross-run name collisions and network-policy holes *by construction* rather than by handling them. Same namespace also means the traffic never reaches Cilium or the coredns sinkhole at all |
| 3 | **Lifecycle is per phase**, matching the existing sandbox bracket | `withSandbox` (`executors/orchestrator.ts:102-124`) provisions and disposes per phase, and egress posture + image are per-phase inputs (lines 109/114). Per-run services would need a namespace that outlives the phase: on docker a run-scoped netns holder, which freezes `--dns` and so **loses per-phase `unrestricted_egress`**; on k8s a separate Pod + Service + Cilium rule + reaping, since namespaces cannot be shared across pods. Per-phase costs nothing and preserves both |
| 4 | Per-phase is also the **correct CI semantic** | Actions scopes `services:` to a *job*, and a Last Light phase is far closer to a job than to a step — own image, own egress posture, own deadline, own agent invocation. Any suite that passes in CI is self-seeding, because CI hands it a virgin database every job. Fresh-per-phase *is* the CI baseline, not a regression from it |
| 5 | **Ports are honoured by a userspace forwarder** in the shared namespace; the declaration keeps Actions' `ports:` form verbatim | Port publishing cannot work here: it translates *across* a namespace boundary, and client and server share one namespace, so no host rule is ever consulted (docker rejects `-p` with `--network container:` outright; k8s `containerPort` is documentation only). A forwarder needs no capabilities and no per-image knowledge. Remapping is 37% of the sample and is dev/CI parity, not vestigial — see 00-evidence §3 |
| 6 | **No per-image knowledge table.** Reconfiguring a service to listen elsewhere becomes a `command:` passthrough the repo may set | The forwarder removes the *reason* for the table. Two residual cases survive — port collisions between same-port services, and self-advertising services (Kafka `advertised.listeners`, Mongo replica sets) — neither present in the sample, and both covered by the escape hatch at ~zero cost |
| 7 | **The operator image allowlist is registry-qualified** | `fastify-mssql` pulls from `mcr.microsoft.com`. A `docker.io/library/*` allowlist would silently drop it |
| 8 | **docker + kubernetes only.** `gondolin`, `none`, `smol` warn once and run without services | The two container backends are what real deployments use. `gondolin` stays the packaged default, so this is inert on a fresh install — consistent with how `repoConfig` already ships |
| 9 | **Every failure degrades to today's behaviour** | Image not allowlisted, health check timed out, backend without support: the run proceeds without the service and the agent writes the same `constraint:` note it writes now. A repo's config can never fail a run — the existing rule, honoured |
| 10 | **Testcontainers is explicitly out of scope** | It creates containers programmatically from test code, which needs a socket in the sandbox — root on the host, a categorically larger trust decision. Survey found one org-wide hit, a docs mention. See [Out of scope](#what-is-deliberately-not-in-this-plan) |

## The declaration

`.lastlight/lastlight.yml` in the target repo — Actions' vocabulary minus
expressions:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: sqlmap
    ports: ["5433:5432"]      # Actions form, honoured by the forwarder
    healthCmd: pg_isready
    command: []               # escape hatch — decision 6
```

Four fields cover all eight surveyed repos. `image` must be fully resolved: no
`${{ }}`, so a repo matrixing ten postgres versions in CI picks the one it
wants the agent to use.

**Trust comes for free.** The `.lastlight/` layer is already read from the
repo's **default branch only**, never a PR head — precisely so a PR cannot
reconfigure the agent reviewing it. A malicious PR therefore cannot inject an
image without any new mechanism.

**Operator bound** — gated like `allowedModels`, not like the `policy-downgrade`
clamps. A capability grant has no operator base to fall back to, so an
allowlist is the right shape; dropping a disallowed entry still fails in the
safe direction (no service):

```yaml
repoConfig:
  allowKeys: [..., services]
  services:
    allowedImages:
      - "docker.io/library/postgres:*"
      - "docker.io/library/redis:*"
      - "mcr.microsoft.com/mssql/server:*"
    maxPerRun: 2
```

Inert out of the box: `allowedImages` defaults empty, so nothing runs until an
operator opts in.

## How it is provisioned

A new **intent-only** `ServiceSpec[]` on `SandboxFactoryOpts`, translated by
each adapter — the same seam `EgressPolicy` already uses, where the port
carries *what* is wanted and each adapter owns *how*
(`src/sandbox/sandbox.ts:90-102`).

One free consequence: both `runSandboxedAgent` and `runSandboxedCommand` go
through `withSandbox`, so extending `provision()` covers `type: bash` test
phases with no second code path.

**Kubernetes** — one native sidecar per service: an `initContainers` entry with
`restartPolicy: Always`. This is load-bearing, not stylistic. A service placed
in `containers[]` would never exit, and with `restartPolicy: Never`
(`pod.ts:91`) the pod would sit `Running` forever and `pod-lifecycle.ts` would
never see terminal state. Native sidecars are exempt from pod-completion
accounting and are torn down when the main container exits. `healthCmd` becomes
a `startupProbe`, so the agent container does not start until the service
answers.

**Docker** — one sibling per service, `docker run -d --network
container:<sandbox>`. The sandbox container is long-lived within the phase
(`docker run -d`, entrypoint ends at `sleep infinity`, phases are `docker
exec`), so its namespace exists for the whole bracket. The harness polls
`docker exec <svc> <healthCmd>` before returning from `provision()`.

**Ports** — a service always binds its own native port in the shared namespace
(postgres on 5432). When a declaration remaps (`ports: ["5433:5432"]`), the
harness adds **one small forwarder container per remapped service**, in the same
namespace, listening on the left-hand port and forwarding to the right:

```
socat TCP-LISTEN:5433,fork,reuseaddr TCP:127.0.0.1:5432
```

No capabilities are needed — the listen port is above 1024 — and the forwarder
is image-agnostic, which is what removes the per-image knowledge table
(decision 6). It is added only for services that actually remap: three of the
eight surveyed repos, none of the other five.

**Both** — the agent finds the service on `localhost`, and learns the
coordinates through injected env (`PGHOST` / `PGPORT` style), exactly as CI
does it.

## Consequences worth stating up front

- **k8s capacity changes.** A pod's metered request is `max(largest init
  container, sum of app containers)` (`pod.ts:16-21`), and native sidecars
  count toward that sum. A postgres sidecar genuinely raises the pod's
  footprint, so the same `ResourceQuota` admits fewer concurrent runs. Correct
  behaviour, but a capacity change and not only a feature.
- **Images are pulled onto your infrastructure.** In docker by the host daemon,
  in k8s by kubelet — in both cases outside the sandbox's egress policy. That
  is the whole reason decision 7 exists, and why `allowedImages` defaults empty.
- **One flat port space per phase.** A shared namespace means all services in a
  phase share one port space. Two same-port services (a primary/replica pair)
  collide, and the forwarder cannot help because the *backend* port is what
  collides. Not present in the sample; covered by `command:` if it arises.
- **A k8s version floor.** Native sidecars are beta-by-default from 1.29 and GA
  in 1.33. **Unverified against the target clusters** — confirm before
  implementation, since a cluster below the floor silently gets a service in
  `initContainers` that blocks pod startup instead of running alongside.

## What is deliberately not in this plan

- **Testcontainers, and anything else that talks to a daemon from test code.**
  Needs a Docker socket in the sandbox, which is root on the host. The survey
  found this is not a real constraint for Nearform (one org-wide hit, a docs
  mention), so the honest scope of this feature is *CI-style declarative
  services* — not "sandboxes can run containers". Worth restating in any
  release note, so the capability is not over-read.
- **Cross-phase state continuity.** Decision 3/4 make each phase's services
  fresh. If a workload ever needs to hand seeded data forward, the cheap bridge
  needs none of the per-run machinery: the **workspace directory already
  persists across phases**, so a phase can `pg_dump` into it and the next phase
  restores. Explicit, debuggable, identical on every backend.
- **Deriving the service set from the repo's CI.** Eliminated by decision 1 —
  but note it is not foreclosed. It could later become a *producer* of the same
  `ServiceSpec[]`, validated through this design's schema and allowlist. This
  design is the substrate either way.
- **A runtime `start_service` agent tool.** Blocked by decision 3: with
  per-phase services provisioned at pod creation, and a running Pod's container
  set immutable, there is nothing for a mid-phase call to attach to. It would
  need both a separate-pod topology and a longer lifetime, and it would still
  need this design's allowlist — it is a strict superset, not an alternative.

## Deferred

| Item | Blocked on | Note |
|---|---|---|
| Verify k8s native-sidecar support on the target clusters | nothing — just a check | Prerequisite, not an enhancement. Gates the whole k8s half |
| Rerun the survey against the real managed-repo list | an admin API call to a running instance | Org-wide numbers are a proxy; see 00-evidence "Method" |
| Multi-service port-collision handling | a real workload needing it | `command:` covers it manually today |
| Self-advertising services (Kafka, Mongo replica sets) | a real workload needing it | Same escape hatch; may need per-image guidance in a skill rather than code |
| Socket-backed testcontainers support | a trust decision nobody has asked for | Explicitly out of scope above |

## Status

Design only. No implementation plan yet — the phase docs (`01-…`, `02-…`)
follow once this document is reviewed.
