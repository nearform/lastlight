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
