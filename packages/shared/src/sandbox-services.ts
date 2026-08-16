/**
 * The **dependency-service domain model** — what a target repo may declare it needs
 * running alongside a workflow phase (a test postgres, a redis), and the bounds an
 * operator puts on that.
 *
 * Design: `docs/plans/sandbox-services/README.md`.
 *
 * This module is PURE: no fs, no network, no framework types, no logger. It says what
 * a phase wants; the sandbox adapters decide how to make it so. That split is the same
 * one `EgressPolicy` already uses (`apps/server/src/sandbox/sandbox.ts`) — the port
 * carries intent, each backend owns its mechanism, and nothing about
 * `restartPolicy: Always` or `--network container:` leaks up here.
 *
 * It lives in `lastlight-shared` because both consumers need identical answers and only
 * shared is reachable by both: core at runtime, and the CLI offline for
 * `lastlight repo config validate`.
 *
 * The vocabulary is deliberately **adopted, not invented** — it is GitHub Actions'
 * `services:` block (`image` / `env` / `ports`), which is what repo maintainers already
 * write and what `skills/fixing/SKILL.md` already teaches the agent to read.
 */

/**
 * A port the phase's processes dial, paired with the port the service really binds.
 *
 * Actions' `ports: ["5433:5432"]` is a HOST mapping. There is no host boundary here —
 * services share the sandbox's network namespace — so the left-hand port is instead
 * served by a forwarder inside that namespace. `needsForwarder` is the whole reason
 * this is a type rather than a number.
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
    // The forwarder is unprivileged (no NET_BIND_SERVICE, all capabilities dropped), so
    // a listen port below 1024 could never be bound. Reject at parse time rather than
    // failing opaquely at container start.
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

/**
 * The operator's bound on which images a repo may ask for.
 *
 * Polarity is deliberately the INVERSE of `RepoConfigPolicy.allowedModels`, where `null`
 * means permissive ("any provider we can wire"). Here absent/null/empty denies
 * everything, because an image is arbitrary code pulled onto the operator's
 * infrastructure — in docker by the host daemon, in kubernetes by kubelet, in both cases
 * outside the sandbox's egress policy. Inert out of the box is the required default, and
 * getting this backwards would ship a remote-code-execution default.
 *
 * Patterns are REGISTRY-QUALIFIED. An unqualified image normalises to
 * `docker.io/library/<name>`, matching docker's own resolution, so a pattern can never be
 * satisfied by an attacker-chosen registry.
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
    return this.patterns.some((p) => matchesImage(candidate, p));
  }
}

/** `postgres:16` → `docker.io/library/postgres:16`; registry-qualified refs pass through. */
function normaliseImage(ref: string): string {
  const trimmed = ref.trim();
  const path = trimmed.split(":")[0] ?? "";
  const firstSegment = path.split("/")[0] ?? "";
  // The first segment is a registry only when it looks like a host: it contains a dot, a
  // colon (port), or is exactly "localhost". Otherwise docker implies docker.io.
  const hasRegistry =
    firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";
  if (hasRegistry) return trimmed;
  return path.split("/").length === 1 ? `docker.io/library/${trimmed}` : `docker.io/${trimmed}`;
}

/** One validated dependency service. Immutable; equality is by attributes. */
export interface ServiceSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly ports: readonly PortMapping[];
  /** argv for the readiness check, run inside the service container. */
  readonly healthCmd?: readonly string[];
  /** uid the image expects — 70 on `postgres:*-alpine`, 999 on the debian variant. */
  readonly runAsUser?: number;
  /** Escape hatch for self-advertising services and deliberate port moves. */
  readonly command?: readonly string[];
}

/** The operator bounds a {@link ServiceSet} is admitted against. */
export interface ServiceBounds {
  allowlist: ImageAllowlist;
  maxServices: number;
}

/** Why a declared service did not make it into the set. */
export interface ServiceViolation {
  name: string;
  reason: "image-not-allowed" | "too-many" | "port-collision";
}

/**
 * A phase's services, and the invariants only the SET can enforce.
 *
 * Services share the sandbox's network namespace, so the whole phase has ONE flat port
 * space. Two services binding the same port collide and no per-item validator can see
 * it — which is why admission is an aggregate operation rather than a loop over
 * independent items. `maxServices` is the other set-level rule.
 *
 * Admission is partial by design: a rejected service is dropped and reported, never
 * thrown. A repo's config can never fail a run.
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

/** Actions expressions cannot be resolved here, so an image carrying one is rejected. */
const UNRESOLVED_EXPRESSION = /\$\{\{/;

/**
 * Parse one raw `services:` entry into a spec, or undefined when it cannot be
 * represented. PURE — applies no policy; the caller decides how to report a rejection.
 *
 * `image` must be fully resolved. A quarter of the surveyed repos derive it from a CI
 * matrix (one across ten postgres versions), and there is no defensible default for
 * "which one", so the repo has to choose.
 */
export function parseServiceSpec(name: string, raw: unknown): ServiceSpec | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.image !== "string" || r.image.trim() === "") return undefined;
  if (UNRESOLVED_EXPRESSION.test(r.image)) return undefined;

  const rawPorts = r.ports === undefined ? [] : r.ports;
  if (!Array.isArray(rawPorts)) return undefined;
  const ports: PortMapping[] = [];
  for (const p of rawPorts) {
    if (typeof p !== "string" && typeof p !== "number") return undefined;
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

/** Both sides of every mapping: the service binds `target`, a forwarder binds `listen`. */
function portsClaimedBy(spec: ServiceSpec): number[] {
  const ports = new Set<number>();
  for (const m of spec.ports) {
    ports.add(m.target);
    ports.add(m.listen);
  }
  return [...ports];
}

/** Exact match, or a trailing `:*` tag wildcard. No other globbing. */
function matchesImage(image: string, pattern: string): boolean {
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
