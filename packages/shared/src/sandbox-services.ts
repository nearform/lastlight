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
