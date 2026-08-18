import type { ServiceSet, ServiceSpec } from "lastlight-shared/sandbox-services";

/**
 * The **docker anti-corruption layer** for dependency services: the domain's
 * {@link ServiceSet} → `docker run` argv (`docs/plans/sandbox-services`).
 *
 * A service JOINS the sandbox container's network namespace rather than getting one of
 * its own. That buys three things at once:
 *
 *  - **`localhost` parity with kubernetes**, so a repo's declaration is portable and no
 *    prompt has to branch on backend;
 *  - **cross-run isolation by construction** — a service is reachable only from inside
 *    the namespace it joined, so two concurrent runs can never collide on a name or a
 *    port, and nothing else on the host can reach it;
 *  - **the sandbox's egress restrictions for free**, since the namespace already has them.
 *
 * The cost is that port publishing is unavailable — docker rejects `-p` with a joined
 * namespace outright ("conflicting options: port publishing and the container type
 * network mode"), and it could not help anyway: a mapping translates *across* a namespace
 * boundary, and here client and server share one. A remapped port is served by a
 * forwarder sibling instead.
 *
 * **Teardown is NOT automatic.** Verified against a real daemon: a joined container keeps
 * running after `docker rm -f` of the namespace owner, holding an orphaned namespace.
 * Hence the labels below — they are the only handle a sweep has on a container whose
 * owning harness process died mid-phase.
 */

/** Marks a container as a dependency service. The ONLY handle a sweep has on an orphan. */
export const SERVICE_LABEL_SELECTOR = "lastlight.component=service";

/** Deterministic per (task, service), so a retry cannot collide with its own leftovers. */
export function serviceContainerName(taskId: string, name: string): string {
  return `lastlight-svc-${taskId}-${name}`;
}

/** Stamp and select go through this ONE helper so the two can never drift apart. */
export function serviceLabelArgs(taskId: string): string[] {
  return ["--label", SERVICE_LABEL_SELECTOR, "--label", `lastlight.taskId=${taskId}`];
}

/** One container to start: its name, its argv, and (for a service) which spec it is. */
export interface ServiceRunSpec {
  name: string;
  args: string[];
  /** The declaring service's name — absent for a forwarder, which has no health check. */
  service?: string;
}

/** Every container this phase's services need, in the order they should be started. */
export function buildServiceRunArgs(
  set: ServiceSet,
  opts: { taskId: string; sandboxContainer: string; forwarderImage: string },
): ServiceRunSpec[] {
  const out: ServiceRunSpec[] = [];
  const join = ["--network", `container:${opts.sandboxContainer}`];

  for (const spec of set.specs) {
    const name = serviceContainerName(opts.taskId, spec.name);
    out.push({
      name,
      service: spec.name,
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
    out.push({
      name: `lastlight-fwd-${opts.taskId}-${service.name}-${mapping.listen}`,
      args: [
        "run", "-d", "--name", `lastlight-fwd-${opts.taskId}-${service.name}-${mapping.listen}`,
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
