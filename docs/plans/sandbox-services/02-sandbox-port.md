# Phase 2 — thread services through the Sandbox port

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> or `superpowers:executing-plans`. Steps use `- [ ]` checkboxes.

**Goal:** Carry the phase's `ServiceSet` from the run's repo config to the sandbox
adapter, and degrade cleanly on backends that will not implement it.

**Spec:** [README.md](README.md). **Depends on:** [Phase 1](01-service-model.md).

**Deliverable:** Every adapter receives a `ServiceSet`. `FakeSandbox` records it, so the
wiring is provable with no docker and no cluster. Backends still ignore it — `docker` is
[Phase 4](04-docker-adapter.md), `kubernetes` is [Phase 3](03-k8s-adapter.md).

**Global constraints:** as [Phase 1](01-service-model.md#global-constraints). Additionally:
core code must use the structured logger (`logger("component")`), never `console.*`.

## The seam, and why it is this one

`EgressPolicy` (`src/sandbox/sandbox.ts:90-102`) is the pattern to copy exactly. It is an
**intent-only value object**: the orchestrator decides *what is allowed* once, and each
adapter translates it to its own mechanism — a `--dns` IP, an `--allow-host` flag, a
Cilium label. Its doc comment is explicit that the mechanism constants "live inside the
adapters, never here."

`ServiceSet` gets the same treatment. The port says *which services this phase wants*.
Nothing about `restartPolicy: Always` or `--network container:` appears above the adapter
boundary — those are anti-corruption layers translating the domain model into each
platform's vocabulary.

`provision()` already owns "the workspace and any isolation primitive"
(`sandbox.ts:47-54`), so services are provisioning and need no new port method.

## File structure

| File | Responsibility |
|---|---|
| **Modify** `apps/server/src/sandbox/sandbox.ts` | `services?: ServiceSet` on `SandboxFactoryOpts`; `FakeSandbox` records it |
| **Modify** `apps/server/src/engine/executors/orchestrator.ts` | Build the set, pass it, inject `LASTLIGHT_SERVICES`, warn on unsupported backends |
| **Modify** `apps/server/src/engine/github/profiles.ts` | `services?: ServiceSpec[]` on `ExecutorConfig` |
| **Modify** `apps/server/src/workflows/runner.ts` | Read `services` off the run's `RunRepoConfig` onto `ExecutorConfig` |
| **Create** `apps/server/tests/sandbox/services-wiring.test.ts` | Wiring tests via `FakeSandbox` |

> **Verify before editing.** `RunRepoConfig` is defined at `workflows/simple.ts:84` and
> reaches the phase executor through `runner.ts` (see lines ~320 and ~637, where the
> per-phase `ExecutorConfig` is assembled). Confirm the exact field names in your
> checkout — this plan names the seam, not a frozen line number.

---

## Task 1: carry a ServiceSet on the port

**Files:**
- Modify: `apps/server/src/sandbox/sandbox.ts`
- Test: `apps/server/tests/sandbox/services-wiring.test.ts`

**Interfaces:**
- Consumes: `ServiceSet` from `lastlight-shared`.
- Produces: `SandboxFactoryOpts.services?: ServiceSet`; `FakeSandbox.services?: ServiceSet`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { FakeSandbox } from "#src/sandbox/sandbox.js";
import { ServiceSet, ImageAllowlist, PortMapping } from "lastlight-shared/sandbox-services";

describe("Sandbox port — services", () => {
  it("records the ServiceSet handed to the factory", () => {
    const { set } = ServiceSet.create(
      [{ name: "postgres", image: "postgres:16-alpine", env: {}, ports: [PortMapping.parse("5432")!] }],
      { allowlist: ImageAllowlist.of(["docker.io/library/postgres:*"]), maxServices: 2 },
    );
    const fake = new FakeSandbox();
    fake.asFactory()("none", {
      taskId: "t1",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: "/tmp",
      services: set,
    });
    expect(fake.services?.specs.map((s) => s.name)).toEqual(["postgres"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/server && npx vitest run tests/sandbox/services-wiring.test.ts`
Expected: FAIL — `services` is not a property of `SandboxFactoryOpts`.

- [ ] **Step 3: Implement**

```typescript
// sandbox.ts — import at top
import type { ServiceSet } from "lastlight-shared/sandbox-services";

// SandboxFactoryOpts — add
  /**
   * Dependency services this phase runs against (spec: docs/plans/sandbox-services).
   * INTENT ONLY, exactly like {@link EgressPolicy}: the set says which services are
   * wanted; each adapter owns the mechanism (k8s native sidecars, docker containers
   * joined to the sandbox's network namespace). Undefined or empty means none, which
   * is every run today.
   */
  services?: ServiceSet;

// FakeSandbox — add the recorded field and capture it in asFactory()
  services?: ServiceSet;

  asFactory(): SandboxFactory {
    return (backend, opts) => {
      this.backend = backend;
      this.egress = opts.egress;
      this.env = opts.env;
      this.services = opts.services;
      return this;
    };
  }
```

- [ ] **Step 4: Run it and watch it pass** — same command, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/sandbox.ts apps/server/tests/sandbox/services-wiring.test.ts
git commit -m "feat(services): carry a ServiceSet on the Sandbox port"
```

---

## Task 2: build the set in the orchestrator, and degrade loudly

**Files:**
- Modify: `apps/server/src/engine/executors/orchestrator.ts`
- Modify: `apps/server/src/engine/github/profiles.ts`
- Test: `apps/server/tests/sandbox/services-wiring.test.ts`

**Interfaces:**
- Consumes: `SandboxFactoryOpts.services` (Task 1), `ExecutorConfig.services`.
- Produces: `servicesFor(config): ServiceSet` and `SERVICE_CAPABLE_BACKENDS`, both
  exported from `orchestrator.ts` for testing.

**Decision 8:** only `docker` and `kubernetes` implement services. `gondolin`, `none` and
`smol` warn **once per run** and proceed without them, landing the run exactly where it is
today — the agent hits the same wall and records the same `constraint:` note (decision 9).

- [ ] **Step 1: Write the failing test**

```typescript
import { servicesFor, SERVICE_CAPABLE_BACKENDS } from "#src/engine/executors/orchestrator.js";

describe("service capability by backend", () => {
  it("supports exactly the two container backends", () => {
    expect([...SERVICE_CAPABLE_BACKENDS].sort()).toEqual(["docker", "kubernetes"]);
  });

  it("yields an empty set when the phase declared none", () => {
    expect(servicesFor({ services: undefined } as never).isEmpty).toBe(true);
  });

  it("drops a service the operator's allowlist does not permit", () => {
    const set = servicesFor({
      services: [{ name: "redis", image: "redis:7", env: {}, ports: [] }],
      serviceBounds: { allowedImages: ["docker.io/library/postgres:*"], maxServices: 2 },
    } as never);
    expect(set.isEmpty).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `servicesFor is not exported`.

- [ ] **Step 3: Implement**

```typescript
// orchestrator.ts
import { ServiceSet, ImageAllowlist } from "lastlight-shared/sandbox-services";
import { logger } from "../../logging/logger.js";

const log = logger("sandbox-services");

/** The backends that implement services (spec decision 8). */
export const SERVICE_CAPABLE_BACKENDS: ReadonlySet<SandboxBackend> = new Set([
  "docker",
  "kubernetes",
]);

/**
 * Admit the phase's declared services against the operator's bounds. Set-level rules
 * (port space, count) belong to {@link ServiceSet}, not here.
 */
export function servicesFor(config: ExecutorConfig): ServiceSet {
  const declared = config.services ?? [];
  if (declared.length === 0) return ServiceSet.empty();
  const bounds = {
    allowlist: ImageAllowlist.of(config.serviceBounds?.allowedImages),
    maxServices: config.serviceBounds?.maxServices ?? 2,
  };
  const { set, violations } = ServiceSet.create(declared, bounds);
  for (const v of violations) {
    log.warn("service dropped", { service: v.name, reason: v.reason });
  }
  return set;
}
```

Then inside `withSandbox`, between building `factory` and calling it:

```typescript
  let services = servicesFor(ctx.config);
  if (!services.isEmpty && !SERVICE_CAPABLE_BACKENDS.has(ctx.backend)) {
    // Degrade to today's behaviour rather than failing: the agent hits the same
    // missing-service wall it hits now and records the same `constraint:` note.
    log.warn("backend does not support services — running without them", {
      backend: ctx.backend,
      services: services.specs.map((s) => s.name),
    });
    services = ServiceSet.empty();
  }
  const sandbox = factory(ctx.backend, {
    // … existing fields unchanged …
    services,
    env: { ...ctx.env, ...serviceEnv(services) },
  });
```

And the discovery env — one variable, so the agent (and a `type: bash` phase) can find
what is running without the prompt having to describe it:

```typescript
/**
 * How a phase discovers its services. Everything is on `localhost` (one shared network
 * namespace), so only the port varies. A forwarder makes the LISTEN port the one to
 * dial, which is why that side is published rather than the target.
 */
export function serviceEnv(services: ServiceSet): Record<string, string> {
  if (services.isEmpty) return {};
  const map: Record<string, number[]> = {};
  for (const s of services.specs) map[s.name] = s.ports.map((p) => p.listen);
  return { LASTLIGHT_SERVICES: JSON.stringify(map) };
}
```

Add to `ExecutorConfig` in `profiles.ts`:

```typescript
  /** Dependency services this phase runs against, from the repo's `.lastlight/`. */
  services?: ServiceSpec[];
  /** The operator bounds the run resolved (`repoConfig.allowedImages` / `maxServices`). */
  serviceBounds?: { allowedImages: string[] | null; maxServices: number };
```

- [ ] **Step 4: Add the degrade test, then run both**

```typescript
it("drops services on a backend that cannot run them, and still provisions", async () => {
  const fake = new FakeSandbox();
  await withSandbox(
    {
      backend: "gondolin",
      taskId: "t1",
      env: {},
      stateDir: "/tmp",
      config: {
        services: [{ name: "postgres", image: "postgres:16-alpine", env: {}, ports: [] }],
        serviceBounds: { allowedImages: ["docker.io/library/postgres:*"], maxServices: 2 },
      },
      sandboxFactory: fake.asFactory(),
    } as never,
    async () => "ok",
  );
  expect(fake.services?.isEmpty).toBe(true);
  expect(fake.provisionCalls).toBe(1); // degraded, NOT failed
});
```

Run: `cd apps/server && npx vitest run tests/sandbox/services-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/engine apps/server/tests/sandbox/services-wiring.test.ts
git commit -m "feat(services): admit services in the orchestrator and degrade unsupported backends"
```

---

## Task 3: read services off the run's repo config

**Files:**
- Modify: `apps/server/src/workflows/runner.ts`
- Test: `apps/server/tests/workflows/repo-config-wiring.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `RunRepoConfig` (`workflows/simple.ts:84`).
- Produces: `ExecutorConfig.services` / `.serviceBounds` populated per phase.

- [ ] **Step 1: Write the failing test**

Extend `repo-config-wiring.test.ts` — it already exercises repo config reaching a run,
so follow its existing harness rather than inventing a new one:

```typescript
it("puts the repo's declared services on the phase's ExecutorConfig", async () => {
  // Arrange a run whose repoConfig.merged carries a services block, drive one phase,
  // and assert the captured ExecutorConfig. Reuse this file's existing fixture helpers.
  expect(captured.services?.map((s) => s.name)).toEqual(["postgres"]);
  expect(captured.serviceBounds?.maxServices).toBe(2);
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd apps/server && npx vitest run tests/workflows/repo-config-wiring.test.ts`

- [ ] **Step 3: Implement** — in `runner.ts`, where the per-phase `ExecutorConfig` is
assembled, map the merged repo config's `services` mapping through `parseServiceSpec`:

```typescript
import { parseServiceSpec } from "lastlight-shared/sandbox-services";

/**
 * The repo's `services:` block, already shape-validated and allowlist-checked by the
 * repo-config layer. Re-parsed here because the merged config stores plain data; a
 * spec that no longer parses is dropped silently rather than failing the run.
 */
function phaseServices(repoConfig?: RunRepoConfig): ServiceSpec[] | undefined {
  const raw = repoConfig?.merged?.services;
  if (!raw || typeof raw !== "object") return undefined;
  const specs: ServiceSpec[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = parseServiceSpec(name, value);
    if (spec) specs.push(spec);
  }
  return specs.length ? specs : undefined;
}
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Run the whole suite** — this touches the runner, which everything uses.

Run: `pnpm --filter lastlight-core test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/workflows/runner.ts apps/server/tests/workflows/repo-config-wiring.test.ts
git commit -m "feat(services): resolve declared services onto the phase executor config"
```

---

## Phase 2 done when

- A repo's declared services reach `SandboxFactoryOpts.services` as a validated
  `ServiceSet`, provable through `FakeSandbox` with no docker and no cluster.
- An unsupported backend logs one warning and **still provisions** — never fails.
- `LASTLIGHT_SERVICES` is injected when the set is non-empty.
- `pnpm --filter lastlight-core test` is green.
- **Still nothing runs.** Both container adapters ignore the set until
  [Phase 3](03-k8s-adapter.md) and [Phase 4](04-docker-adapter.md).
