import type { V1Container, V1SecurityContext } from "@kubernetes/client-node";
import type { ServiceSet, ServiceSpec } from "lastlight-shared/sandbox-services";

/**
 * The **kubernetes anti-corruption layer** for dependency services: the domain's
 * {@link ServiceSet} → pod containers (`docs/plans/sandbox-services`).
 *
 * Everything platform-specific lives here — `restartPolicy: Always` as the native-sidecar
 * marker, the probe shape, the socat argv, the `restricted` PodSecurity fields. The
 * domain model in `lastlight-shared` knows none of it, the same way `EgressPolicy` knows
 * nothing about `--dns` IPs or Cilium labels.
 *
 * **These belong in the pod's `initContainers`, never `containers`.** Two independent
 * reasons, both load-bearing:
 *
 *  1. A service never exits. With the pod's `restartPolicy: Never` it would sit
 *     `Running` forever and `pod-lifecycle.ts` would never observe terminal state.
 *     A `restartPolicy: Always` init container is exempt from pod-completion accounting
 *     and is torn down once the regular containers finish.
 *  2. `terminalResult` reads `status.containerStatuses[0]` (`pod-status.ts`) for the
 *     agent's exit code. A service in `containers` would pollute the very array that
 *     classifier indexes into.
 */

/**
 * Fallback uid when a repo omits `runAsUser`. Deliberately NOT a guess at the image's own
 * user: the correct value differs even between variants of one image (70 on
 * `postgres:*-alpine`, 999 on the debian build), so a wrong-but-visible failure at
 * container creation beats silently running as the agent's uid over a data directory.
 * 65532 is the conventional distroless `nonroot` uid.
 */
export const SERVICE_DEFAULT_UID = 65532;

/** Modest requests. Services are metered into the pod's quota cost beside the agent. */
export const SERVICE_REQUESTS = { cpu: "100m", memory: "256Mi" } as const;
export const FORWARDER_REQUESTS = { cpu: "50m", memory: "32Mi" } as const;

/** Translate an admitted set into the sidecar containers the pod should carry. */
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
      // No host boundary exists inside a shared namespace, so a remapped port is served
      // by this process rather than by any port-publishing mechanism.
      args: [
        `TCP-LISTEN:${mapping.listen},fork,reuseaddr`,
        `TCP:127.0.0.1:${mapping.target}`,
      ],
      resources: { requests: { ...FORWARDER_REQUESTS } },
      securityContext: restrictedSecurityContext(SERVICE_DEFAULT_UID),
      restartPolicy: "Always",
    });
  }
  return out;
}

function serviceContainer(spec: ServiceSpec): V1Container {
  const container: V1Container = {
    name: `svc-${spec.name}`,
    image: spec.image,
    // Inline rather than via the run's creds Secret: this env is the repo's own public
    // `.lastlight/` config, and a service must never receive the run's GitHub token.
    env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
    resources: { requests: { ...SERVICE_REQUESTS } },
    securityContext: restrictedSecurityContext(spec.runAsUser ?? SERVICE_DEFAULT_UID),
    restartPolicy: "Always",
  };
  if (spec.command?.length) container.command = [...spec.command];
  if (spec.healthCmd?.length) {
    // For a native sidecar the NEXT container starts once this one has started or, when
    // present, once its startupProbe succeeds. That probe IS the readiness mechanism —
    // without it the agent races the service.
    container.startupProbe = {
      exec: { command: [...spec.healthCmd] },
      periodSeconds: 2,
      failureThreshold: 45,
    };
  }
  return container;
}

/** The four fields the sandbox namespace's `restricted` PodSecurity level requires. */
function restrictedSecurityContext(runAsUser: number): V1SecurityContext {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsUser,
  };
}
