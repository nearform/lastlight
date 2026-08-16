# Phase 4 — the docker adapter

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> or `superpowers:executing-plans`. Steps use `- [ ]` checkboxes.

**Goal:** Translate a `ServiceSet` into sibling containers sharing the sandbox's network
namespace, and clean them up — which docker will not do for you.

**Spec:** [README.md](README.md). **Depends on:** [Phase 2](02-sandbox-port.md).

**Deliverable:** On `LASTLIGHT_SANDBOX=docker`, a phase whose repo declares postgres runs
with postgres on `localhost`, and nothing leaks when the phase ends or the harness dies.

**Global constraints:** as [Phase 1](01-service-model.md#global-constraints). Additionally:
the sandbox gains **no new privilege** — no socket, no root, no docker binary. Every
container is created by the harness, never by the agent.

## What the probe established

Verified locally (spec, Verification notes → Docker probe):

- `--network container:<sandbox>` gives the service the sandbox's namespace:
  `NetworkMode: container:<id>`, empty `IPAddress`, service reachable on `127.0.0.1`.
- `-p` **cannot** be combined with it — docker errors `conflicting options: port
  publishing and the container type network mode`. Ports are a forwarder's job.
- `docker exec <svc> <healthCmd>` is a working readiness seam (`pg_isready` in ~2 s).
- **Teardown is not free.** After `docker rm -f <sandbox>` the joined containers were
  **still running**, holding an orphaned namespace. `-f` bypasses the dependency check.

That last point is the whole reason Task 3 exists. Kubernetes needs no equivalent.

## File structure

| File | Responsibility |
|---|---|
| **Create** `apps/server/src/sandbox/service-containers-docker.ts` | Anti-corruption layer: `ServiceSpec` → `docker run` argv |
| **Modify** `apps/server/src/sandbox/docker.ts` | Start services after `create()`, poll health, remove on teardown |
| **Modify** `apps/server/src/sandbox/sandbox.ts` | `DockerSandbox.provision` passes the set; `dispose` removes services first |
| **Modify** `apps/server/src/sandbox/reap.ts` | Remove a task's orphaned service containers |
| **Modify** `apps/server/src/cron/sandbox-sweep.ts` | Sweep leaked service containers |
| **Create** `apps/server/tests/sandbox/service-containers-docker.test.ts` | argv tests |

## Labels are load-bearing

Every service container is stamped `lastlight.taskId=<taskId>` and
`lastlight.component=service`. That label is the **only** way a sweep can find a container
whose owning harness process died mid-phase. Stamp and select through one helper so the
two cannot drift — the same discipline `RunId.matchLabels()` enforces on the k8s side.

---

## Task 1: build the docker argv

**Files:**
- Create: `apps/server/src/sandbox/service-containers-docker.ts`
- Test: `apps/server/tests/sandbox/service-containers-docker.test.ts`

**Interfaces:**
- Consumes: `ServiceSet`, `ServiceSpec`, `PortMapping`.
- Produces:
  - `serviceContainerName(taskId: string, name: string): string`
  - `serviceLabelArgs(taskId: string): string[]`
  - `SERVICE_LABEL_SELECTOR: string` (`"lastlight.component=service"`)
  - `buildServiceRunArgs(set, opts: { taskId: string; sandboxContainer: string; forwarderImage: string }): { name: string; args: string[] }[]`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildServiceRunArgs, serviceLabelArgs } from "#src/sandbox/service-containers-docker.js";
import { ServiceSet, ImageAllowlist, PortMapping } from "lastlight-shared/sandbox-services";

const setOf = (...specs: Parameters<typeof ServiceSet.create>[0]) =>
  ServiceSet.create(specs, {
    allowlist: ImageAllowlist.of(["docker.io/library/postgres:*"]),
    maxServices: 3,
  }).set;

const pg = {
  name: "postgres", image: "postgres:16-alpine",
  env: { POSTGRES_PASSWORD: "probe" },
  ports: [PortMapping.parse("5432")!],
  healthCmd: ["pg_isready"],
};
const opts = { taskId: "t1", sandboxContainer: "ll-sbx-t1", forwarderImage: "alpine/socat:latest" };

describe("buildServiceRunArgs", () => {
  it("joins the sandbox's network namespace", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).toContain("--network");
    expect(svc!.args).toContain("container:ll-sbx-t1");
  });

  // Verified against the daemon: -p is rejected outright with a joined namespace.
  it("never publishes a port", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).not.toContain("-p");
    expect(svc!.args).not.toContain("--publish");
  });

  it("stamps the task label so a sweep can find an orphan", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).toEqual(expect.arrayContaining(serviceLabelArgs("t1")));
  });

  it("passes declared env through", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).toEqual(expect.arrayContaining(["-e", "POSTGRES_PASSWORD=probe"]));
  });

  it("adds a forwarder sibling only for a remapped port", () => {
    const out = buildServiceRunArgs(setOf({ ...pg, ports: [PortMapping.parse("5433:5432")!] }), opts);
    expect(out.map((c) => c.name)).toEqual([
      "lastlight-svc-t1-postgres",
      "lastlight-fwd-t1-postgres-5433",
    ]);
    expect(out[1]!.args).toEqual(
      expect.arrayContaining(["TCP-LISTEN:5433,fork,reuseaddr", "TCP:127.0.0.1:5432"]),
    );
  });

  // Declared once, honoured on both backends — otherwise the field means two
  // different things depending on where the phase happened to run.
  it("honours a declared runAsUser", () => {
    const [svc] = buildServiceRunArgs(setOf({ ...pg, runAsUser: 70 }), opts);
    expect(svc!.args).toEqual(expect.arrayContaining(["--user", "70"]));
  });

  it("leaves the image's own user alone when none was declared", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).not.toContain("--user");
  });

  it("is empty for an empty set", () => {
    expect(buildServiceRunArgs(setOf(), opts)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd apps/server && npx vitest run tests/sandbox/service-containers-docker.test.ts`

- [ ] **Step 3: Implement**

```typescript
import type { ServiceSet, ServiceSpec } from "lastlight-shared/sandbox-services";

/** Marks a container as a dependency service. The ONLY handle a sweep has on an orphan. */
export const SERVICE_LABEL_SELECTOR = "lastlight.component=service";

export function serviceContainerName(taskId: string, name: string): string {
  return `lastlight-svc-${taskId}-${name}`;
}

/** Stamp and select go through this one helper so they cannot drift. */
export function serviceLabelArgs(taskId: string): string[] {
  return ["--label", SERVICE_LABEL_SELECTOR, "--label", `lastlight.taskId=${taskId}`];
}

/**
 * Anti-corruption layer: the domain's {@link ServiceSet} → `docker run` argv.
 *
 * The service JOINS the sandbox's network namespace rather than getting its own. That
 * buys `localhost` parity with kubernetes, makes cross-run name collisions structurally
 * impossible, and inherits the sandbox's egress restrictions for free. It also means
 * `-p` is unavailable — docker rejects publishing with a joined namespace — so a
 * remapped port is served by a forwarder sibling instead.
 */
export function buildServiceRunArgs(
  set: ServiceSet,
  opts: { taskId: string; sandboxContainer: string; forwarderImage: string },
): { name: string; args: string[] }[] {
  const out: { name: string; args: string[] }[] = [];
  const join = ["--network", `container:${opts.sandboxContainer}`];

  for (const spec of set.specs) {
    const name = serviceContainerName(opts.taskId, spec.name);
    out.push({
      name,
      args: [
        "run", "-d", "--name", name,
        ...join,
        ...serviceLabelArgs(opts.taskId),
        ...envArgs(spec),
        // Docker has no PodSecurity, so an image's own USER would otherwise stand.
        // Honour the declared uid anyway: the field must mean the same thing on both
        // backends, or a repo's config behaves differently depending on where it ran.
        ...(spec.runAsUser !== undefined ? ["--user", String(spec.runAsUser)] : []),
        "--memory", "1g", "--memory-swap", "1g",
        spec.image,
        ...(spec.command ?? []),
      ],
    });
  }

  for (const { service, mapping } of set.forwarders()) {
    const name = `lastlight-fwd-${opts.taskId}-${service.name}-${mapping.listen}`;
    out.push({
      name,
      args: [
        "run", "-d", "--name", name,
        ...join,
        ...serviceLabelArgs(opts.taskId),
        opts.forwarderImage,
        `TCP-LISTEN:${mapping.listen},fork,reuseaddr`,
        `TCP:127.0.0.1:${mapping.target}`,
      ],
    });
  }
  return out;
}

function envArgs(spec: ServiceSpec): string[] {
  return Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/service-containers-docker.ts \
  apps/server/tests/sandbox/service-containers-docker.test.ts
git commit -m "feat(services): build docker run argv for joined service containers"
```

---

## Task 2: start services and wait for readiness

**Files:**
- Modify: `apps/server/src/sandbox/docker.ts`, `apps/server/src/sandbox/sandbox.ts`

**Interfaces:**
- Consumes: `buildServiceRunArgs` (Task 1).
- Produces: `DockerSandbox.startServices(taskId, set): Promise<string[]>` returning the
  container names started, and `DockerSandbox.stopServices(taskId): Promise<void>`.

**Ordering matters.** The sandbox container must exist *before* a service can join its
namespace. `create()` already returns a long-lived container (`docker run -d`, entrypoint
ends at `sleep infinity`, phases are `docker exec`), so start services immediately after
`waitForReady`.

**Readiness must not fail the run.** A `healthCmd` that never passes logs a warning and
proceeds — the agent then hits a service that is not ready and reports it, which is
today's behaviour, not a new failure mode (decision 9).

- [ ] **Step 1: Write the failing test** — assert `provision()` starts one container per
service and polls `healthCmd`, using this suite's existing command-capture harness rather
than a real daemon.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

```typescript
  /** Start this phase's services in the sandbox's namespace and wait for readiness. */
  async startServices(taskId: string, set: ServiceSet): Promise<string[]> {
    const sbx = this.activeContainers.get(taskId);
    if (!sbx || set.isEmpty) return [];
    const started: string[] = [];
    for (const { name, args } of buildServiceRunArgs(set, {
      taskId,
      sandboxContainer: sbx.containerName,
      forwarderImage: process.env.LASTLIGHT_FORWARDER_IMAGE || "alpine/socat:latest",
    })) {
      execCmd("docker", args);
      started.push(name);
    }
    for (const spec of set.specs) {
      if (spec.healthCmd?.length) {
        await this.waitForService(serviceContainerName(taskId, spec.name), [...spec.healthCmd]);
      }
    }
    return started;
  }

  /** Poll `docker exec <svc> <healthCmd>`. A timeout warns; it never throws. */
  private async waitForService(container: string, healthCmd: string[], timeoutMs = 90_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await execFileAsync("docker", ["exec", container, ...healthCmd], { timeout: 5000 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    log.warn("service did not become ready — continuing without it", { container });
  }
```

In `sandbox.ts`, `DockerSandbox.provision` after `createTaskSandbox`:

```typescript
    if (this.opts.services && !this.opts.services.isEmpty) {
      await sbx.sandbox.startServices(this.opts.taskId, this.opts.services);
    }
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox
git commit -m "feat(services): start and health-check services on the docker backend"
```

---

## Task 3: remove them, because docker will not

**Files:**
- Modify: `apps/server/src/sandbox/docker.ts`, `apps/server/src/sandbox/sandbox.ts`,
  `apps/server/src/sandbox/reap.ts`, `apps/server/src/cron/sandbox-sweep.ts`

**This is the task the probe added.** Joined containers **outlive** `docker rm -f` of the
sandbox. Two mechanisms, because one is not enough:

1. **Ordered dispose** — services removed *before* the sandbox, on the happy path.
2. **Labelled sweep** — a harness crash between `provision()` and `dispose()` leaks them,
   and neither `reap.ts` nor the hourly sweep knows they exist today.

- [ ] **Step 1: Write the failing test**

```typescript
it("removes service containers before the sandbox container", async () => {
  // Drive provision() then dispose() with the command-capture harness.
  const removals = captured.filter((c) => c[0] === "rm");
  expect(removals[0]).toEqual(expect.arrayContaining(["lastlight-svc-t1-postgres"]));
  expect(removals.at(-1)).toEqual(expect.arrayContaining(["lastlight-sandbox-t1"]));
});

it("sweeps a leaked service container by label", async () => {
  // reapSandboxWorkspace must remove containers matching lastlight.taskId=<id>
  expect(captured).toContainEqual(
    expect.arrayContaining(["ps", "-aq", "--filter", "label=lastlight.taskId=t1"]),
  );
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

```typescript
  /** Remove this task's service containers. Best effort; never throws. */
  async stopServices(taskId: string): Promise<void> {
    try {
      const ids = execCmd("docker", [
        "ps", "-aq", "--filter", `label=lastlight.taskId=${taskId}`,
        "--filter", `label=${SERVICE_LABEL_SELECTOR}`,
      ]).trim().split("\n").filter(Boolean);
      if (ids.length) execCmd("docker", ["rm", "-f", ...ids]);
    } catch (err) {
      log.warn("failed to remove service containers", { taskId, err });
    }
  }
```

`DockerSandbox.dispose` — services first:

```typescript
  async dispose(): Promise<void> {
    if (!this.sbx) return;
    // Order matters: a joined container SURVIVES `docker rm -f` of the namespace owner
    // (verified), so removing the sandbox first would orphan it, not collect it.
    await this.sbx.sandbox.stopServices(this.opts.taskId);
    await this.sbx.cleanup();
  }
```

Then extend `reapSandboxWorkspace` (`reap.ts`) to call the same label-based removal for
the taskId it is reaping, so the hourly `sandbox-sweep.ts` inherits it for free — that
sweep already routes every removal through `reapSandboxWorkspace`, which is the single
safe-remove authority.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Run the sandbox suite**

Run: `cd apps/server && npx vitest run tests/sandbox/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sandbox apps/server/src/cron apps/server/tests/sandbox
git commit -m "fix(services): remove docker service containers on dispose and on sweep"
```

---

## Task 4: prove it against a real daemon

- [ ] **Step 1: Extend the opt-in integration test** —
`tests/sandbox/command-exec.integration.test.ts` already starts a real sandbox for a
no-AI workflow. Add a case declaring one postgres service and asserting a `type: bash`
phase reaches it on `127.0.0.1:5432`.

- [ ] **Step 2: Add a leak assertion** — after the run, assert no container matching
`label=lastlight.component=service` remains. This is the regression guard for the
finding that motivated Task 3.

- [ ] **Step 3: Run it**

```bash
cd apps/server
docker compose --profile build-only build sandbox-base
docker compose --profile build-only build sandbox
RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/command-exec.integration.test.ts
```

Expected: PASS. Self-gating — skips instantly without docker or the image.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/sandbox/command-exec.integration.test.ts
git commit -m "test(services): cover a real postgres service and its cleanup on docker"
```

---

## Execution notes (16 Aug 2026)

Phase 4's unit work landed; three notes:

- **Teardown went in `DockerSandbox.destroy`, not the adapter's `dispose`.** `destroy` is
  the single point every teardown path already funnels through (`cleanup` in
  `createTaskSandbox`, and `destroyAll`), so ordering it there means nothing can bypass
  it. The plan's placement in `sandbox.ts` would have missed `destroyAll`.
- **The sweep backstop went in `reapSandboxWorkspace`,** which is the single safe-remove
  authority — so the hourly `sandbox-sweep.ts` inherits it with no change of its own.
  Reaching the removal path already means no sandbox owns the taskId, so any container
  still carrying the label is by definition an orphan.
- **Task 4 (the integration test) is WRITTEN BUT UNRUN**, like Phase 3's. It needs
  `lastlight-sandbox:latest` built locally. It asserts reachability with a raw node TCP
  connect (no postgres client in the image) and ends with a **leak assertion** — no
  container left carrying `lastlight.taskId` — which is the direct regression guard for
  the finding that motivated the teardown work. Run with:
  `RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/command-exec.integration.test.ts`.

Full suite after Phase 4: **3129 passed, 0 failed**; typecheck and boundary gate clean.

## Phase 4 done when

- A `docker` phase with a declared service runs with it on `localhost`.
- Services are removed on dispose **and** recoverable by label after a crash, both pinned
  by tests.
- `pnpm --filter lastlight-core test` is green.

## After all four phases

Update the docs the change touches — `apps/server/spec/09-sandbox.md` (the sandbox
contract), `apps/server/spec/02-configuration.md` (the repo-config surface) and
`packages/shared/CLAUDE.md` (the new module). The `docs-sync` skill maps changed files to
doc surfaces; run it rather than guessing.
