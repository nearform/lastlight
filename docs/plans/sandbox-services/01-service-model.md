# Phase 1 — the service domain model

> **Status: implemented.** This phase shipped — see the Execution notes near the
> end for what actually happened, including where reality diverged from the plan.
> The steps below are the plan **as originally written**, kept unchanged on purpose:
> the execution notes argue against them ("the plan's placement would have missed
> `destroyAll`"), and that comparison only works if the original survives. They are
> a record, not a to-do list.

**Goal:** Model a repo-declared dependency service as a validated domain object in
`lastlight-shared`, and accept it from a repo's `.lastlight/lastlight.yml`.

**Spec:** [README.md](README.md) — read it first, especially the locked decisions.

**Deliverable:** `.lastlight/lastlight.yml` can declare `services:`, the operator can
bound it, and every rejection is a structured warning. **No backend touches it yet** —
this phase is pure, has no I/O, and needs neither docker nor a cluster.

## Global constraints

Copied verbatim from the spec; they apply to every task in every phase.

- **Node 22**, ESM, TypeScript. 100-char lines. Absolute imports only.
- `lastlight-shared` **must never gain an edge to `lastlight-core`** (dep-cruiser gate,
  runs in `typecheck`). This phase's code therefore imports nothing from `apps/server`.
- `lastlight-shared` is **pino-free**. No logger import here.
- **A repo's config can never fail a run.** Every rejection warns, drops the offending
  key, and lets the run proceed (spec decision 9).
- The layer is always read from the repo's **default branch**, never a PR head. Phase 1
  inherits that; it adds no new trust surface.

## Ubiquitous language

Use these names in code, tests and messages. They are CI's words, which is what repo
maintainers already write — the shared language is not invented here, it is adopted.

| Term | Meaning |
|---|---|
| **service** | A dependency container a phase runs against (postgres, redis, …) |
| **ServiceSpec** | One validated declaration. Immutable, equality by attributes |
| **PortMapping** | A `listen:target` pair. `needsForwarder` when they differ |
| **ServiceSet** | A phase's services *plus* the invariants only the set can check |
| **ImageAllowlist** | The operator bound on which images may run |
| **forwarder** | The process translating a `listen` port to a `target` port |

## Why a ServiceSet aggregate

Individual specs cannot detect the invariant that actually bites: **a shared network
namespace gives the whole phase one flat port space** (spec, "Consequences"). Two
services both binding 5432 collide, and no per-item validator can see it. Port-space
consistency and the `maxPerRun` cap are *set-level* invariants, so they belong to an
aggregate root rather than to a loop over independent items.

In-repo precedent for a value object carrying its own rule: `RunId`
(`src/sandbox/k8s/run-id.ts`), whose `matchLabels()` makes stamp/select symmetry
structural "rather than by convention".

## File structure

| File | Responsibility |
|---|---|
| **Create** `packages/shared/src/sandbox-services.ts` | The whole domain model: `PortMapping`, `ServiceSpec`, `ServiceSet`, `ImageAllowlist`. No I/O, no framework types |
| **Modify** `packages/shared/src/repo-config-schema.ts` | `sanitizeServices()` + the `services` case; `allowedImages`/`maxServices` on `RepoConfigPolicy`; the `service-not-allowed` warning code; `services` in `DEFAULT_REPO_CONFIG_ALLOW_KEYS` |
| **Modify** `packages/shared/src/index.ts` | Export the new module from the barrel |
| **Modify** `apps/server/config/default.yaml` | Add `services` to `repoConfig.allowKeys`, and `repoConfig.allowedImages: []` |
| **Create** `apps/server/tests/config/sandbox-services.test.ts` | Model tests |
| **Modify** `apps/server/tests/config/repo-config-shared.test.ts` | Extend the allow-key drift pin |

> **Gotcha that will bite you.** `repo-config-shared.test.ts:80` pins
> `DEFAULT_REPO_CONFIG_ALLOW_KEYS` against `config/default.yaml`'s `repoConfig.allowKeys`.
> Adding the key in one place only **fails that test**. That pin exists because the two
> drifted silently once already. Update both in the same commit.

> **`packages/shared` has no test runner of its own.** There is no `test` script and no
> `packages/shared/tests/`. Tests for shared code live in `apps/server/tests/` and import
> via the package name (`lastlight-shared/...`) — see the existing
> `apps/server/tests/config/repo-config-shared.test.ts` for the pattern.

> **You must BUILD shared before `apps/server` tests can see a change.** `apps/server`'s
> `vitest.config.ts` aliases only `#src`, so `lastlight-shared/*` resolves through the
> package's `exports` map to `./dist/*.js`. A new module needs three things or the import
> fails to resolve: the source file, an `exports` entry in
> `packages/shared/package.json`, and `pnpm --filter lastlight-shared build`. Every
> "run the test" step below assumes that build has just run.

---

## Task 1: PortMapping

**Files:**
- Create: `packages/shared/src/sandbox-services.ts`
- Test: `apps/server/tests/config/sandbox-services.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class PortMapping` with `static parse(raw: string): PortMapping | undefined`,
  readonly `listen: number`, readonly `target: number`, getter `needsForwarder: boolean`,
  `toString(): string`.

- **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { PortMapping } from "lastlight-shared/sandbox-services";

describe("PortMapping", () => {
  it("parses the Actions listen:target form", () => {
    const m = PortMapping.parse("5433:5432")!;
    expect(m.listen).toBe(5433);
    expect(m.target).toBe(5432);
    expect(m.needsForwarder).toBe(true);
  });

  it("parses a bare port as listen === target", () => {
    const m = PortMapping.parse("5432")!;
    expect(m.listen).toBe(5432);
    expect(m.target).toBe(5432);
    expect(m.needsForwarder).toBe(false);
  });

  it("rejects malformed, out-of-range and privileged listen ports", () => {
    expect(PortMapping.parse("")).toBeUndefined();
    expect(PortMapping.parse("abc:5432")).toBeUndefined();
    expect(PortMapping.parse("5432:")).toBeUndefined();
    expect(PortMapping.parse("0:5432")).toBeUndefined();
    expect(PortMapping.parse("70000:5432")).toBeUndefined();
    // The forwarder runs unprivileged, so it cannot bind below 1024.
    expect(PortMapping.parse("80:5432")).toBeUndefined();
  });

  it("allows a privileged TARGET — only the listen side is bound by us", () => {
    expect(PortMapping.parse("8080:80")?.target).toBe(80);
  });
});
```

- **Step 2: Run it and watch it fail**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: FAIL — cannot resolve `lastlight-shared/sandbox-services`.

- **Step 3: Implement**

```typescript
/**
 * A port the phase's processes dial, paired with the port the service really binds.
 *
 * Actions' `ports: ["5433:5432"]` is a HOST mapping. There is no host boundary here —
 * services share the sandbox's network namespace — so the left-hand port is instead
 * served by a forwarder inside that namespace (spec decision 5). `needsForwarder` is
 * the whole reason this is a type rather than a number.
 */
export class PortMapping {
  private constructor(
    readonly listen: number,
    readonly target: number,
  ) {}

  /** `"5433:5432"` or `"5432"`. Returns undefined for anything unusable. */
  static parse(raw: string): PortMapping | undefined {
    const parts = raw.trim().split(":");
    if (parts.length > 2) return undefined;
    const listen = toPort(parts[0]);
    const target = parts.length === 2 ? toPort(parts[1]) : listen;
    if (listen === undefined || target === undefined) return undefined;
    // The forwarder is unprivileged (no NET_BIND_SERVICE, caps dropped), so a
    // listen port below 1024 could never be bound. Reject at parse time rather
    // than failing opaquely at container start.
    if (listen < 1024) return undefined;
    return new PortMapping(listen, target);
  }

  get needsForwarder(): boolean {
    return this.listen !== this.target;
  }

  toString(): string {
    return `${this.listen}:${this.target}`;
  }
}

function toPort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : undefined;
}
```

- **Step 4: Run it and watch it pass**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: PASS (4 tests).

- **Step 5: Commit**

```bash
git add packages/shared/src/sandbox-services.ts apps/server/tests/config/sandbox-services.test.ts
git commit -m "feat(services): add the PortMapping value object"
```

---

## Task 2: ImageAllowlist

**Files:**
- Modify: `packages/shared/src/sandbox-services.ts`
- Test: `apps/server/tests/config/sandbox-services.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class ImageAllowlist` with `static of(patterns: readonly string[] | null | undefined): ImageAllowlist`,
  `permits(image: string): boolean`, getter `isEmpty: boolean`.

**Polarity — read this before implementing.** `RepoConfigPolicy.allowedModels` uses
`null` to mean *permissive* ("any provider we can wire"). `allowedImages` is the
**opposite**: absent or `null` means **deny everything**. A model spec is a choice among
things the harness already knows how to talk to; an image is arbitrary code pulled onto
the operator's infrastructure. Getting this backwards ships a remote-code-execution
default, so the test below pins it.

- **Step 1: Write the failing test**

```typescript
import { ImageAllowlist } from "lastlight-shared/sandbox-services";

describe("ImageAllowlist", () => {
  it("denies everything when absent or null — opposite polarity to allowedModels", () => {
    expect(ImageAllowlist.of(undefined).permits("postgres:16")).toBe(false);
    expect(ImageAllowlist.of(null).permits("postgres:16")).toBe(false);
    expect(ImageAllowlist.of([]).permits("postgres:16")).toBe(false);
    expect(ImageAllowlist.of(undefined).isEmpty).toBe(true);
  });

  it("matches a trailing-* tag wildcard", () => {
    const a = ImageAllowlist.of(["docker.io/library/postgres:*"]);
    expect(a.permits("docker.io/library/postgres:16-alpine")).toBe(true);
    expect(a.permits("docker.io/library/postgres")).toBe(true); // bare = any tag
    expect(a.permits("docker.io/library/redis:7")).toBe(false);
  });

  it("normalises an unqualified image to docker.io/library", () => {
    const a = ImageAllowlist.of(["docker.io/library/postgres:*"]);
    expect(a.permits("postgres:16-alpine")).toBe(true);
  });

  it("honours a non-Docker-Hub registry", () => {
    // nearform/fastify-mssql pulls from mcr.microsoft.com — see 00-evidence.md
    const a = ImageAllowlist.of(["mcr.microsoft.com/mssql/server:*"]);
    expect(a.permits("mcr.microsoft.com/mssql/server:2017-CU8-ubuntu")).toBe(true);
    expect(a.permits("postgres:16")).toBe(false);
  });

  it("never lets a registry be smuggled past an unqualified pattern", () => {
    const a = ImageAllowlist.of(["docker.io/library/postgres:*"]);
    expect(a.permits("evil.example.com/library/postgres:16")).toBe(false);
  });
});
```

- **Step 2: Run it and watch it fail**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: FAIL — `ImageAllowlist is not exported`.

- **Step 3: Implement**

```typescript
/**
 * The operator's bound on which images a repo may ask for.
 *
 * Polarity is deliberately the INVERSE of `RepoConfigPolicy.allowedModels`, where
 * `null` means permissive. Here absent/null/empty denies everything, because an image
 * is arbitrary code pulled onto the operator's infrastructure — in docker by the host
 * daemon, in kubernetes by kubelet, in both cases outside the sandbox's egress policy
 * (spec, "Consequences"). Inert out of the box is the required default.
 *
 * Patterns are REGISTRY-QUALIFIED. An unqualified image normalises to
 * `docker.io/library/<name>`, matching docker's own resolution, so a pattern can never
 * be satisfied by an attacker-chosen registry.
 */
export class ImageAllowlist {
  private constructor(private readonly patterns: readonly string[]) {}

  static of(patterns: readonly string[] | null | undefined): ImageAllowlist {
    return new ImageAllowlist(patterns ? patterns.map(normaliseImage) : []);
  }

  get isEmpty(): boolean {
    return this.patterns.length === 0;
  }

  permits(image: string): boolean {
    const candidate = normaliseImage(image);
    return this.patterns.some((p) => matches(candidate, p));
  }
}

/** `postgres:16` → `docker.io/library/postgres:16`; registry-qualified refs pass through. */
function normaliseImage(ref: string): string {
  const trimmed = ref.trim();
  const [path] = trimmed.split(":");
  const firstSegment = (path ?? "").split("/")[0] ?? "";
  // A registry is the first segment only when it looks like a host: it has a dot,
  // a colon (port), or is exactly "localhost". Otherwise docker implies docker.io.
  const hasRegistry = firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";
  if (hasRegistry) return trimmed;
  const slashes = (path ?? "").split("/").length;
  return slashes === 1 ? `docker.io/library/${trimmed}` : `docker.io/${trimmed}`;
}

/** Exact match, or a trailing `:*` tag wildcard. No other globbing. */
function matches(image: string, pattern: string): boolean {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return image === prefix || image.startsWith(`${prefix}:`);
  }
  // A pattern with no tag admits any tag of exactly that repository.
  if (!pattern.includes(":") || pattern.lastIndexOf(":") < pattern.lastIndexOf("/")) {
    return image === pattern || image.startsWith(`${pattern}:`);
  }
  return image === pattern;
}
```

- **Step 4: Run it and watch it pass**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: PASS (9 tests).

- **Step 5: Commit**

```bash
git add packages/shared/src/sandbox-services.ts apps/server/tests/config/sandbox-services.test.ts
git commit -m "feat(services): add the ImageAllowlist operator bound"
```

---

## Task 3: ServiceSpec and the ServiceSet aggregate

**Files:**
- Modify: `packages/shared/src/sandbox-services.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/tests/config/sandbox-services.test.ts`

**Interfaces:**
- Consumes: `PortMapping` (Task 1), `ImageAllowlist` (Task 2).
- Produces:
  - `interface ServiceSpec { readonly name: string; readonly image: string; readonly env: Readonly<Record<string,string>>; readonly ports: readonly PortMapping[]; readonly healthCmd?: readonly string[]; readonly runAsUser?: number; readonly command?: readonly string[] }`
  - `interface ServiceBounds { allowlist: ImageAllowlist; maxServices: number }`
  - `interface ServiceViolation { name: string; reason: "image-not-allowed" | "too-many" | "port-collision" }`
  - `class ServiceSet` with `static create(specs: readonly ServiceSpec[], bounds: ServiceBounds): { set: ServiceSet; violations: ServiceViolation[] }`,
    `static empty(): ServiceSet`, getters `specs: readonly ServiceSpec[]`, `isEmpty: boolean`,
    and `forwarders(): readonly { service: ServiceSpec; mapping: PortMapping }[]`.

- **Step 1: Write the failing test**

```typescript
import { ServiceSet, ImageAllowlist, PortMapping } from "lastlight-shared/sandbox-services";
import type { ServiceSpec } from "lastlight-shared/sandbox-services";

const spec = (over: Partial<ServiceSpec> & { name: string }): ServiceSpec => ({
  image: "postgres:16-alpine",
  env: {},
  ports: [PortMapping.parse("5432")!],
  ...over,
});

const bounds = (patterns: string[] = ["docker.io/library/postgres:*"], maxServices = 2) => ({
  allowlist: ImageAllowlist.of(patterns),
  maxServices,
});

describe("ServiceSet", () => {
  it("keeps a permitted service", () => {
    const { set, violations } = ServiceSet.create([spec({ name: "postgres" })], bounds());
    expect(violations).toEqual([]);
    expect(set.specs.map((s) => s.name)).toEqual(["postgres"]);
    expect(set.isEmpty).toBe(false);
  });

  it("drops a service whose image is not allowlisted, keeping the rest", () => {
    const specs = [spec({ name: "postgres" }), spec({ name: "redis", image: "redis:7" })];
    const { set, violations } = ServiceSet.create(specs, bounds());
    expect(set.specs.map((s) => s.name)).toEqual(["postgres"]);
    expect(violations).toEqual([{ name: "redis", reason: "image-not-allowed" }]);
  });

  it("drops beyond maxServices rather than failing the set", () => {
    const specs = [spec({ name: "a" }), spec({ name: "b" }), spec({ name: "c" })];
    const { set, violations } = ServiceSet.create(specs, bounds(["docker.io/library/postgres:*"], 2));
    expect(set.specs.map((s) => s.name)).toEqual(["a", "b"]);
    expect(violations).toEqual([{ name: "c", reason: "too-many" }]);
  });

  // The invariant no per-item validator can see: one shared netns = one port space.
  it("drops a service whose target port another service already binds", () => {
    const specs = [spec({ name: "a" }), spec({ name: "b" })];
    const { set, violations } = ServiceSet.create(specs, bounds());
    expect(set.specs.map((s) => s.name)).toEqual(["a"]);
    expect(violations).toEqual([{ name: "b", reason: "port-collision" }]);
  });

  it("treats a forwarder listen port as occupying the same space", () => {
    const specs = [
      spec({ name: "a", ports: [PortMapping.parse("5433:5432")!] }),
      spec({ name: "b", image: "postgres:16", ports: [PortMapping.parse("5433")!] }),
    ];
    const { set, violations } = ServiceSet.create(specs, bounds());
    expect(set.specs.map((s) => s.name)).toEqual(["a"]);
    expect(violations).toEqual([{ name: "b", reason: "port-collision" }]);
  });

  it("reports only the mappings that actually need a forwarder", () => {
    const specs = [
      spec({ name: "a", ports: [PortMapping.parse("5433:5432")!] }),
      spec({ name: "b", image: "postgres:16", ports: [PortMapping.parse("6379")!] }),
    ];
    const { set } = ServiceSet.create(specs, bounds());
    const fwd = set.forwarders();
    expect(fwd).toHaveLength(1);
    expect(fwd[0]!.service.name).toBe("a");
    expect(fwd[0]!.mapping.listen).toBe(5433);
  });

  it("is empty when nothing was declared", () => {
    const { set, violations } = ServiceSet.create([], bounds());
    expect(set.isEmpty).toBe(true);
    expect(violations).toEqual([]);
  });
});
```

- **Step 2: Run it and watch it fail**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: FAIL — `ServiceSet is not exported`.

- **Step 3: Implement**

```typescript
/** One validated dependency service. Immutable; equality is by attributes. */
export interface ServiceSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly ports: readonly PortMapping[];
  /** argv for the readiness check, run inside the service container. */
  readonly healthCmd?: readonly string[];
  /** uid the image expects — 70 on postgres:*-alpine, 999 on the debian variant. */
  readonly runAsUser?: number;
  /** Escape hatch for self-advertising services and deliberate port moves. */
  readonly command?: readonly string[];
}

export interface ServiceBounds {
  allowlist: ImageAllowlist;
  maxServices: number;
}

export interface ServiceViolation {
  name: string;
  reason: "image-not-allowed" | "too-many" | "port-collision";
}

/**
 * A phase's services, and the invariants only the SET can enforce.
 *
 * Services share the sandbox's network namespace, so the whole phase has ONE flat port
 * space (spec, "Consequences"). Two services binding the same port collide and no
 * per-item validator can see it — which is why admission is an aggregate operation
 * rather than a loop. `maxServices` is the other set-level rule.
 *
 * Admission is partial by design: a rejected service is dropped and reported, never
 * thrown. A repo's config can never fail a run (spec decision 9).
 */
export class ServiceSet {
  private constructor(private readonly accepted: readonly ServiceSpec[]) {}

  static create(
    specs: readonly ServiceSpec[],
    bounds: ServiceBounds,
  ): { set: ServiceSet; violations: ServiceViolation[] } {
    const accepted: ServiceSpec[] = [];
    const violations: ServiceViolation[] = [];
    const claimed = new Set<number>();

    for (const spec of specs) {
      if (!bounds.allowlist.permits(spec.image)) {
        violations.push({ name: spec.name, reason: "image-not-allowed" });
        continue;
      }
      if (accepted.length >= bounds.maxServices) {
        violations.push({ name: spec.name, reason: "too-many" });
        continue;
      }
      const wanted = portsClaimedBy(spec);
      if (wanted.some((p) => claimed.has(p))) {
        violations.push({ name: spec.name, reason: "port-collision" });
        continue;
      }
      for (const p of wanted) claimed.add(p);
      accepted.push(spec);
    }
    return { set: new ServiceSet(accepted), violations };
  }

  /** The no-services case, which is every run today. */
  static empty(): ServiceSet {
    return new ServiceSet([]);
  }

  get specs(): readonly ServiceSpec[] {
    return this.accepted;
  }

  get isEmpty(): boolean {
    return this.accepted.length === 0;
  }

  /** Every mapping needing a forwarder, paired with the service it fronts. */
  forwarders(): readonly { service: ServiceSpec; mapping: PortMapping }[] {
    const out: { service: ServiceSpec; mapping: PortMapping }[] = [];
    for (const service of this.accepted) {
      for (const mapping of service.ports) {
        if (mapping.needsForwarder) out.push({ service, mapping });
      }
    }
    return out;
  }
}

/** Both sides of every mapping: the service binds `target`, a forwarder binds `listen`. */
function portsClaimedBy(spec: ServiceSpec): number[] {
  const ports = new Set<number>();
  for (const m of spec.ports) {
    ports.add(m.target);
    ports.add(m.listen);
  }
  return [...ports];
}
```

Then export from the barrel:

```typescript
// packages/shared/src/index.ts — add alongside the existing exports
export * from "./sandbox-services.js";
```

- **Step 4: Run it and watch it pass**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: PASS (16 tests).

- **Step 5: Typecheck both packages**

Run: `pnpm --filter lastlight-shared typecheck && pnpm --filter lastlight-core typecheck`
Expected: clean. The second command also runs `lint:boundaries` — it must confirm
`shared` still has no edge to `core`.

- **Step 6: Commit**

```bash
git add packages/shared/src/sandbox-services.ts packages/shared/src/index.ts \
  apps/server/tests/config/sandbox-services.test.ts
git commit -m "feat(services): add the ServiceSet aggregate and its port-space invariant"
```

---

## Task 4: accept `services:` from a repo's `.lastlight/`

**Files:**
- Modify: `packages/shared/src/repo-config-schema.ts`
- Modify: `apps/server/config/default.yaml`
- Test: `apps/server/tests/config/sandbox-services.test.ts`
- Modify: `apps/server/tests/config/repo-config-shared.test.ts`

**Interfaces:**
- Consumes: `ServiceSpec`, `PortMapping` (Tasks 1-3).
- Produces:
  - `RepoConfigPolicy` gains `allowedImages: string[] | null` and `maxServices: number`.
  - `RepoConfigWarningCode` gains `"service-not-allowed"`.
  - `sanitizeServices(raw, policy, warn)` reached from the `case "services"` branch.
  - `parseServiceSpecs(raw: unknown): ServiceSpec[]` exported from `sandbox-services.ts`.

**Model this on `sanitizeNotifications`** (`repo-config-schema.ts:1195`), not on
`sanitizeFix`. `notifications` is the existing block with **no clamp direction** — it
validates SHAPE only, because routing has no more/less-conservative ordering. `services`
is the same: a declaration is not a loosening of an operator value, it is a request
against an allowlist. Reusing a `policy-downgrade` clamp here would be modelling it wrong.

- **Step 1: Write the failing test**

```typescript
import { sanitizeRepoConfigLayer, defaultRepoConfigPolicy } from "lastlight-shared/repo-config-schema";

const policyWith = (over: Partial<ReturnType<typeof defaultRepoConfigPolicy>> = {}) => ({
  ...defaultRepoConfigPolicy(),
  allowedImages: ["docker.io/library/postgres:*"],
  maxServices: 2,
  ...over,
});

const base = { fix: {}, dependencies: {}, review: {}, notifications: {} } as never;

describe("sanitizeRepoConfigLayer — services", () => {
  it("keeps a well-formed declaration", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      {
        services: {
          postgres: {
            image: "postgres:16-alpine",
            env: { POSTGRES_PASSWORD: "probe" },
            ports: ["5433:5432"],
            healthCmd: "pg_isready",
            runAsUser: 70,
          },
        },
      },
      policyWith(),
      base,
    );
    expect(warnings).toEqual([]);
    expect(layer.services).toBeDefined();
  });

  it("warns and drops an image outside the operator allowlist", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      { services: { redis: { image: "redis:7", ports: ["6379"] } } },
      policyWith(),
      base,
    );
    expect(layer.services).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["service-not-allowed"]);
  });

  it("denies everything when the operator set no allowlist", () => {
    const { warnings } = sanitizeRepoConfigLayer(
      { services: { postgres: { image: "postgres:16-alpine", ports: ["5432"] } } },
      policyWith({ allowedImages: null }),
      base,
    );
    expect(warnings.map((w) => w.code)).toEqual(["service-not-allowed"]);
  });

  it("rejects an image carrying an unresolved Actions expression", () => {
    const { warnings } = sanitizeRepoConfigLayer(
      { services: { postgres: { image: "postgres:${{ matrix.pg }}", ports: ["5432"] } } },
      policyWith(),
      base,
    );
    expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
  });

  it("rejects a malformed port and keeps the service out", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      { services: { postgres: { image: "postgres:16-alpine", ports: ["nope"] } } },
      policyWith(),
      base,
    );
    expect(layer.services).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
  });

  it("rejects a non-mapping services block", () => {
    const { warnings } = sanitizeRepoConfigLayer({ services: ["postgres"] }, policyWith(), base);
    expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
  });
});
```

- **Step 2: Run it and watch it fail**

Run: `cd apps/server && npx vitest run tests/config/sandbox-services.test.ts`
Expected: FAIL — `services` hits the `default:` branch and warns `key-not-allowed`.

- **Step 3: Extend the policy, the warning vocabulary and the default allow-list**

In `repo-config-schema.ts`:

```typescript
// 1. RepoConfigPolicy — add two fields, with the polarity note.
export interface RepoConfigPolicy {
  // … existing fields …
  /**
   * Container images a repo may declare as services, registry-qualified. Note the
   * polarity is the INVERSE of `allowedModels`: `null` (the default) denies every
   * image, because a service image is arbitrary code pulled onto operator
   * infrastructure. A list permits exactly those patterns.
   */
  allowedImages: string[] | null;
  /** Ceiling on services per phase. */
  maxServices: number;
}

// 2. Warning vocabulary — add beside `model-not-allowed`.
  /** A service image outside `repoConfig.allowedImages`. */
  | "service-not-allowed"

// 3. Default allow-list — append.
export const DEFAULT_REPO_CONFIG_ALLOW_KEYS: readonly string[] = [
  // … existing …
  "notifications",
  "services",
];

// 4. defaultRepoConfigPolicy() — add the two defaults.
  allowedImages: null,   // deny-all until an operator opts in
  maxServices: 2,
```

And in `apps/server/config/default.yaml`, under `repoConfig:`, add `services` to
`allowKeys` and the two new bounds:

```yaml
repoConfig:
  allowKeys:
    # … existing entries, unchanged order …
    - notifications
    - services
  # Deny-all by default: a service image is arbitrary code on this host.
  allowedImages: []
  maxServices: 2
```

- **Step 4: Implement the sanitizer and its parser**

In `sandbox-services.ts`:

```typescript
/** Actions expressions cannot be resolved here, so an image carrying one is rejected. */
const UNRESOLVED_EXPRESSION = /\$\{\{/;

/**
 * Parse the raw `services:` mapping into specs. Returns undefined for any service that
 * cannot be represented; the caller decides how to report it. Pure — no policy applied.
 */
export function parseServiceSpec(name: string, raw: unknown): ServiceSpec | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.image !== "string" || r.image.trim() === "") return undefined;
  if (UNRESOLVED_EXPRESSION.test(r.image)) return undefined;

  const ports: PortMapping[] = [];
  const rawPorts = r.ports === undefined ? [] : r.ports;
  if (!Array.isArray(rawPorts)) return undefined;
  for (const p of rawPorts) {
    const mapping = PortMapping.parse(String(p));
    if (!mapping) return undefined;
    ports.push(mapping);
  }

  const env: Record<string, string> = {};
  if (r.env !== undefined) {
    if (typeof r.env !== "object" || r.env === null || Array.isArray(r.env)) return undefined;
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return undefined;
      env[k] = String(v);
    }
  }

  const healthCmd = toArgv(r.healthCmd);
  if (r.healthCmd !== undefined && healthCmd === undefined) return undefined;
  const command = toArgv(r.command);
  if (r.command !== undefined && command === undefined) return undefined;

  let runAsUser: number | undefined;
  if (r.runAsUser !== undefined) {
    if (typeof r.runAsUser !== "number" || !Number.isInteger(r.runAsUser) || r.runAsUser < 1) {
      return undefined;
    }
    runAsUser = r.runAsUser;
  }

  return { name, image: r.image.trim(), env, ports, healthCmd, runAsUser, command };
}

/** `"pg_isready"` or `["pg_isready", "-U", "probe"]` → argv. */
function toArgv(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw.trim() === "" ? undefined : raw.trim().split(/\s+/);
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) return raw as string[];
  return undefined;
}
```

In `repo-config-schema.ts`, add the `case` and the sanitizer:

```typescript
      case "services":
        assignIfAny(layer, "services", sanitizeServices(value, policy, warn));
        break;
```

```typescript
/**
 * `services:` — a CAPABILITY GRANT, not a clamp.
 *
 * Every block above answers "is the repo asking to be looser than the operator?".
 * A service declaration has no such ordering: it is a request measured against an
 * allowlist, so this is modelled on `sanitizeNotifications` (shape + a bound) rather
 * than on the `policy-downgrade` clamps. Dropping still fails safe — no service.
 *
 * Set-level rules (port collisions, `maxServices`) are NOT applied here. They belong
 * to `ServiceSet`, which is where the whole phase's port space is visible.
 */
function sanitizeServices(
  raw: unknown,
  policy: RepoConfigPolicy,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn(
      "invalid-value",
      "services",
      `Ignored "services" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`,
    );
    return undefined;
  }
  const allowlist = ImageAllowlist.of(policy.allowedImages);
  const out: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(raw)) {
    const path = `services.${name}`;
    const spec = parseServiceSpec(name, value);
    if (!spec) {
      warn(
        "invalid-value",
        path,
        `Ignored "${path}": each service needs a literal "image" (no \${{ }} expressions), ` +
          `optional string "env", "ports" like "5433:5432", "healthCmd", "runAsUser".`,
      );
      continue;
    }
    if (!allowlist.permits(spec.image)) {
      warn(
        "service-not-allowed",
        path,
        `Ignored "${path}": "${spec.image}" is not in this deployment's repoConfig.allowedImages.`,
      );
      continue;
    }
    out[name] = value;
  }
  return out;
}
```

Add the import at the top of `repo-config-schema.ts`:

```typescript
import { ImageAllowlist, parseServiceSpec } from "./sandbox-services.js";
```

- **Step 5: Update the drift pin**

`apps/server/tests/config/repo-config-shared.test.ts` compares
`DEFAULT_REPO_CONFIG_ALLOW_KEYS` to `config/default.yaml`. It should now pass because
both were updated in Step 3. Add one explicit assertion beside the existing `crons` one:

```typescript
  it("allows services by default, but grants no image", () => {
    expect(DEFAULT_REPO_CONFIG_ALLOW_KEYS).toContain("services");
    // The key is settable; the capability is not granted until an operator lists images.
    expect(defaultRepoConfigPolicy().allowedImages).toBeNull();
  });
```

- **Step 6: Run the full config suite**

Run: `cd apps/server && npx vitest run tests/config/`
Expected: PASS, including the pre-existing allow-key drift pin.

- **Step 7: Typecheck**

Run: `pnpm --filter lastlight-shared typecheck && pnpm --filter lastlight-core typecheck`
Expected: clean.

- **Step 8: Commit**

```bash
git add packages/shared/src apps/server/config/default.yaml apps/server/tests/config
git commit -m "feat(services): accept a services block in the repo config layer"
```

---

## Execution notes (16 Aug 2026)

Phase 1 landed. Four things the plan did not anticipate:

- **`shapeMerged` drops anything not in its fixed shape.** A block can be accepted by
  `sanitizeRepoConfigLayer` and then vanish before any consumer sees it, which would have
  made Phase 2's `merged.services` permanently undefined and the whole feature inert.
  `services` was added to `RepoMergedConfig` + `shapeMerged`, stored as **raw plain data**
  — merged config is persisted as JSON and rehydrated on resume, and `PortMapping` is a
  class instance that would not survive the round trip. Consumers re-parse via
  `parseServiceSpec`. A test now pins the whole path through `resolveRepoConfig`.
- **`repoConfigPolicy()` hand-wrote a second copy of the shipped defaults** and went stale
  the moment a bound was added. It now calls `defaultRepoConfigPolicy()`.
- **`nonEmptyStringList` returns `[]`, not undefined**, so `?? null` did not normalise the
  shipped `allowedImages: []`. Added `emptyToNull` so "empty" and "unset" are one state.
- **The shared build step** (see the note above) — every shared change needs it before
  `apps/server` tests resolve the import.

Full suite after Phase 1: **3077 passed, 0 failed**; both typechecks and the dep-cruiser
boundary gate clean.

## Phase 1 done when

- A repo can declare `services:` and every malformed or disallowed entry produces a
  structured warning instead of an error.
- `allowedImages` defaults to deny-all, pinned by a test.
- `ServiceSet` enforces the port-space and count invariants, pinned by tests.
- `pnpm --filter lastlight-core typecheck` is clean, including the dep-cruiser boundary
  check confirming `shared` still has no edge to `core`.
- **Nothing observable has changed at runtime.** No backend reads `services` yet — that
  is [Phase 2](02-sandbox-port.md).
