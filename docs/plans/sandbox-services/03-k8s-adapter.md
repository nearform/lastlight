# Phase 3 — the kubernetes adapter

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> or `superpowers:executing-plans`. Steps use `- [ ]` checkboxes.

**Goal:** Translate a `ServiceSet` into native sidecar containers on the phase's Pod.

**Spec:** [README.md](README.md). **Depends on:** [Phase 2](02-sandbox-port.md).

**Deliverable:** On `LASTLIGHT_SANDBOX=kubernetes`, a phase whose repo declares postgres
runs with postgres on `localhost`. Verified end to end by the probe recorded in the spec's
Verification notes — this phase reproduces that manifest from the domain model.

**Global constraints:** as [Phase 1](01-service-model.md#global-constraints). Additionally:

- **Every service container must satisfy `restricted` PodSecurity.**
  `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, and a non-root
  `runAsUser`. The namespace enforces this (`deploy/k8s/sandbox-namespace.yaml`).
- **Native sidecars require k8s ≥ 1.29** (beta-by-default; GA 1.33). Verified on the
  test cluster; re-check on any new one.

## The two traps

**1. `buildPodManifest` rewrites every init container.** `pod.ts:126-134` maps over
`initContainers` and *overwrites* `envFrom` with the run's creds Secret and `resources`
with `SANDBOX_INIT_REQUESTS`. Passing services through that array would inject the run's
**`GITHUB_TOKEN` and provider keys into a postgres container** and clobber its resource
requests. Services therefore need their **own input field**, appended after that map.

**2. `containers[]` is the wrong array, twice over.** A service there would never exit, so
with `restartPolicy: Never` the pod would sit `Running` forever and `pod-lifecycle.ts`
would never see terminal state. And `terminalResult` reads `status.containerStatuses[0]`
(`pod-status.ts:25`) — a service in that array pollutes the very slot the exit-code
classifier indexes into. `initContainers` with `restartPolicy: Always` avoids both.

## File structure

| File | Responsibility |
|---|---|
| **Modify** `apps/server/src/sandbox/k8s/pod.ts` | `services?: ServiceContainerSpec[]` on `PodSpecInput`; append as sidecars |
| **Create** `apps/server/src/sandbox/k8s/service-containers.ts` | The anti-corruption layer: `ServiceSpec` → `V1Container[]` |
| **Modify** `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` | Pass `opts.services` into the manifest |
| **Modify** `apps/server/src/config/config.ts` | `kubernetes.forwarderImage` (default `alpine/socat:latest`) |
| **Create** `apps/server/tests/sandbox/k8s/service-containers.test.ts` | Translation tests |
| **Modify** `apps/server/tests/sandbox/k8s/pod.test.ts` | Manifest-shape tests |

---

## Task 1: translate a ServiceSpec into containers

**Files:**
- Create: `apps/server/src/sandbox/k8s/service-containers.ts`
- Test: `apps/server/tests/sandbox/k8s/service-containers.test.ts`

**Interfaces:**
- Consumes: `ServiceSet`, `ServiceSpec`, `PortMapping` from `lastlight-shared`.
- Produces: `buildServiceContainers(set: ServiceSet, opts: { forwarderImage: string }): V1Container[]`.

**Default uid.** When a spec omits `runAsUser`, fall back to a non-root constant
(`SERVICE_DEFAULT_UID = 65532`, the distroless `nonroot` uid). It will be wrong for most
database images — deliberately. The pod fails fast and visibly at container creation
rather than silently running as the agent's uid and corrupting a data directory. The
probe found the correct value differs by *variant* (70 on `postgres:*-alpine`, 999 on
debian), which is exactly why the harness must not guess.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildServiceContainers } from "#src/sandbox/k8s/service-containers.js";
import { ServiceSet, ImageAllowlist, PortMapping } from "lastlight-shared/sandbox-services";

const setOf = (...specs: Parameters<typeof ServiceSet.create>[0]) =>
  ServiceSet.create(specs, {
    allowlist: ImageAllowlist.of(["docker.io/library/postgres:*"]),
    maxServices: 3,
  }).set;

const pg = {
  name: "postgres",
  image: "postgres:16-alpine",
  env: { POSTGRES_PASSWORD: "probe" },
  ports: [PortMapping.parse("5432")!],
  healthCmd: ["pg_isready"],
  runAsUser: 70,
};

describe("buildServiceContainers", () => {
  it("emits a native sidecar, not a regular container", () => {
    const [c] = buildServiceContainers(setOf(pg), { forwarderImage: "alpine/socat:latest" });
    expect(c!.name).toBe("svc-postgres");
    expect(c!.image).toBe("postgres:16-alpine");
    expect((c as { restartPolicy?: string }).restartPolicy).toBe("Always");
  });

  it("is restricted-PSS compliant and never root", () => {
    const [c] = buildServiceContainers(setOf(pg), { forwarderImage: "alpine/socat:latest" });
    expect(c!.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c!.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    expect(c!.securityContext?.runAsUser).toBe(70);
  });

  it("turns healthCmd into a startupProbe so the agent waits for readiness", () => {
    const [c] = buildServiceContainers(setOf(pg), { forwarderImage: "alpine/socat:latest" });
    expect(c!.startupProbe?.exec?.command).toEqual(["pg_isready"]);
  });

  it("carries declared env inline — it is public repo config, not a secret", () => {
    const [c] = buildServiceContainers(setOf(pg), { forwarderImage: "alpine/socat:latest" });
    expect(c!.env).toEqual([{ name: "POSTGRES_PASSWORD", value: "probe" }]);
  });

  it("adds a forwarder sidecar only for a remapped port", () => {
    const remapped = { ...pg, ports: [PortMapping.parse("5433:5432")!] };
    const out = buildServiceContainers(setOf(remapped), { forwarderImage: "alpine/socat:latest" });
    expect(out.map((c) => c.name)).toEqual(["svc-postgres", "fwd-postgres-5433"]);
    expect(out[1]!.args).toEqual(["TCP-LISTEN:5433,fork,reuseaddr", "TCP:127.0.0.1:5432"]);
    expect((out[1] as { restartPolicy?: string }).restartPolicy).toBe("Always");
  });

  it("adds no forwarder when the port is not remapped", () => {
    const out = buildServiceContainers(setOf(pg), { forwarderImage: "alpine/socat:latest" });
    expect(out).toHaveLength(1);
  });

  it("defaults to a non-root uid when the repo did not say", () => {
    const out = buildServiceContainers(setOf({ ...pg, runAsUser: undefined }), {
      forwarderImage: "alpine/socat:latest",
    });
    expect(out[0]!.securityContext?.runAsUser).toBe(65532);
  });

  it("is empty for an empty set", () => {
    expect(buildServiceContainers(setOf(), { forwarderImage: "x" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd apps/server && npx vitest run tests/sandbox/k8s/service-containers.test.ts`

- [ ] **Step 3: Implement**

```typescript
import type { V1Container } from "@kubernetes/client-node";
import type { ServiceSet, ServiceSpec } from "lastlight-shared/sandbox-services";

/** Fallback uid when a repo omits `runAsUser`. Deliberately not a guess at the image's
 *  own user: wrong-but-visible beats silently running as the agent's uid. */
export const SERVICE_DEFAULT_UID = 65532;

/** Modest requests — services are metered into the pod's quota cost alongside the agent. */
export const SERVICE_REQUESTS = { cpu: "100m", memory: "256Mi" } as const;
export const FORWARDER_REQUESTS = { cpu: "50m", memory: "32Mi" } as const;

/**
 * Anti-corruption layer: the domain's {@link ServiceSet} → kubernetes containers.
 *
 * Everything platform-specific lives here — `restartPolicy: Always` (the native-sidecar
 * marker), the probe shape, the socat argv. The domain model knows none of it.
 *
 * These are returned for the pod's `initContainers` array, NOT `containers`: a service
 * in `containers` never exits, so the pod would never go terminal, and it would occupy
 * `containerStatuses[0]`, which `pod-status.ts` reads for the agent's exit code.
 */
export function buildServiceContainers(
  set: ServiceSet,
  opts: { forwarderImage: string },
): V1Container[] {
  const out: V1Container[] = [];
  for (const spec of set.specs) out.push(serviceContainer(spec));
  for (const { service, mapping } of set.forwarders()) {
    out.push({
      name: `fwd-${service.name}-${mapping.listen}`,
      image: opts.forwarderImage,
      args: [
        `TCP-LISTEN:${mapping.listen},fork,reuseaddr`,
        `TCP:127.0.0.1:${mapping.target}`,
      ],
      resources: { requests: { ...FORWARDER_REQUESTS } },
      securityContext: restrictedSecurityContext(SERVICE_DEFAULT_UID),
      restartPolicy: "Always",
    } as V1Container);
  }
  return out;
}

function serviceContainer(spec: ServiceSpec): V1Container {
  const container: V1Container = {
    name: `svc-${spec.name}`,
    image: spec.image,
    env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
    resources: { requests: { ...SERVICE_REQUESTS } },
    securityContext: restrictedSecurityContext(spec.runAsUser ?? SERVICE_DEFAULT_UID),
    restartPolicy: "Always",
  } as V1Container;
  if (spec.command?.length) container.command = [...spec.command];
  if (spec.healthCmd?.length) {
    // For a native sidecar the NEXT container starts once this one has started or,
    // when present, once its startupProbe succeeds — which is the whole readiness
    // mechanism. Without it the agent races the service.
    container.startupProbe = {
      exec: { command: [...spec.healthCmd] },
      periodSeconds: 2,
      failureThreshold: 45,
    };
  }
  return container;
}

function restrictedSecurityContext(runAsUser: number) {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsUser,
  };
}
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/service-containers.ts \
  apps/server/tests/sandbox/k8s/service-containers.test.ts
git commit -m "feat(services): translate a ServiceSet into kubernetes sidecar containers"
```

---

## Task 2: attach them to the pod without leaking credentials

**Files:**
- Modify: `apps/server/src/sandbox/k8s/pod.ts`
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`

**Interfaces:**
- Consumes: `buildServiceContainers` output (Task 1).
- Produces: `PodSpecInput.services?: V1Container[]`, appended to `initContainers` **after**
  the creds-stamping map.

- [ ] **Step 1: Write the failing test**

```typescript
describe("buildPodManifest with services", () => {
  const svc = {
    name: "svc-postgres", image: "postgres:16-alpine",
    restartPolicy: "Always",
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, runAsUser: 70 },
  } as never;

  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/nearform/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001, workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    services: [svc],
  });

  it("puts services in initContainers, never in containers", () => {
    expect(pod.spec?.containers).toHaveLength(1);
    expect(pod.spec?.containers[0]!.name).toBe("agent");
    expect(pod.spec?.initContainers?.some((c) => c.name === "svc-postgres")).toBe(true);
  });

  // The trap: the initContainers map stamps the run's creds Secret onto every entry.
  it("never hands the run's credentials Secret to a service container", () => {
    const svcContainer = pod.spec?.initContainers?.find((c) => c.name === "svc-postgres");
    expect(svcContainer?.envFrom).toBeUndefined();
  });

  it("keeps the service's own resource requests", () => {
    const svcContainer = pod.spec?.initContainers?.find((c) => c.name === "svc-postgres");
    expect(svcContainer?.resources?.requests).not.toEqual(SANDBOX_INIT_REQUESTS);
  });

  it("still stamps creds onto real init containers", () => {
    const podWithBoth = buildPodManifest({
      /* …same as above, plus… */ initContainers: [{ name: "clone", image: "x" }] as never,
      services: [svc],
    } as never);
    const clone = podWithBoth.spec?.initContainers?.find((c) => c.name === "clone");
    expect(clone?.envFrom?.[0]?.secretRef?.name).toBe("ll-x-creds");
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd apps/server && npx vitest run tests/sandbox/k8s/pod.test.ts`

- [ ] **Step 3: Implement** — in `pod.ts`, add the input and change the assembly so
services bypass the creds map:

```typescript
  /**
   * Dependency-service sidecars (spec: docs/plans/sandbox-services). A SEPARATE input
   * from `initContainers` on purpose: the mapping below stamps the run's creds Secret
   * and the init resource requests onto every real init container, and a postgres must
   * receive neither. Appended after that map, already fully formed.
   */
  services?: V1Container[];
```

```typescript
      ...(hasInit(i)
        ? {
            initContainers: [
              ...(i.initContainers ?? []).map((c) => ({
                ...c,
                envFrom: [{ secretRef: { name: i.envFromSecret } }],
                resources: { requests: { ...SANDBOX_INIT_REQUESTS } },
              })),
              ...(i.services ?? []),
            ],
          }
        : {}),
```

```typescript
function hasInit(i: PodSpecInput): boolean {
  return Boolean(i.initContainers?.length) || Boolean(i.services?.length);
}
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/pod.test.ts
git commit -m "feat(services): attach service sidecars without leaking the creds secret"
```

---

## Task 3: wire the adapter and the forwarder image

**Files:**
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Modify: `apps/server/src/config/config.ts`, `apps/server/config/default.yaml`
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`

The forwarder image is **operator-chosen, not repo-chosen**, so it is deployment config
and is deliberately *not* subject to `allowedImages`.

- [ ] **Step 1: Write the failing test** — assert the manifest the adapter builds carries
the sidecars when `opts.services` is non-empty, following this file's existing harness.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

```yaml
# config/default.yaml, under kubernetes:
  # Image used for the port-remap forwarder sidecar. Operator config, not repo config.
  forwarderImage: alpine/socat:latest
```

```typescript
// kubernetes-sandbox.ts — where buildPodManifest is called (~line 440)
      services: buildServiceContainers(this.opts.services ?? ServiceSet.empty(), {
        forwarderImage: this.k8s.forwarderImage,
      }),
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Run the k8s suite**

Run: `cd apps/server && npx vitest run tests/sandbox/k8s/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sandbox/k8s apps/server/src/config apps/server/config/default.yaml \
  apps/server/tests/sandbox/k8s
git commit -m "feat(services): run declared services as sidecars on the kubernetes backend"
```

---

## Task 4: prove it on a cluster

Unit tests cannot answer whether an image starts under `restricted` — **admission
validates the manifest, the kubelet validates the image**. Only a real pod closes that gap.

- [ ] **Step 1: Extend the opt-in integration test**

Add a case to `tests/sandbox/k8s/kubernetes.integration.test.ts` that provisions a phase
with one postgres service and asserts a `psql` against `127.0.0.1:5432` succeeds.

- [ ] **Step 2: Run it against a cluster**

Run: `cd apps/server && RUN_K8S_IT=1 npx vitest run tests/sandbox/k8s/kubernetes.integration.test.ts`
Expected: PASS. Skips instantly with no cluster, so CI is unaffected.

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts
git commit -m "test(services): cover a real postgres sidecar in the k8s integration test"
```

## Phase 3 done when

- A `kubernetes` phase with a declared service runs with it on `localhost`.
- No service container receives the run's creds Secret — pinned by a test.
- The pod still reaches `Succeeded` and `terminalResult` still reads the agent's exit code.
- Quota note for the operator: sidecars count toward the pod's metered request, so the
  same `ResourceQuota` admits fewer concurrent runs.
