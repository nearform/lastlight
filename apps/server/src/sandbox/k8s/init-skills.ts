import type { V1Container } from "@kubernetes/client-node";
import { SKILLS_MOUNT_DIR } from "./skill-bundle.js";

/**
 * The skills initContainer: fetch the per-phase bundle from the harness
 * (bearer token from the creds Secret env, endpoint as a positional arg so it
 * is never interpolated into the script) and unpack it into the shared
 * `skills` emptyDir the agent container reads via `--skill`. `envFrom` (creds
 * Secret) is attached by `buildPodManifest`. `-f` makes curl fail the init on a
 * non-2xx so a bad fetch surfaces (checkInitContainerFailure appends its logs).
 */
export function buildSkillsInitContainer(
  image: string,
  opts: { endpoint: string; runAsUser: number },
): V1Container {
  const script =
    'curl -fsS -H "Authorization: Bearer $LASTLIGHT_SKILL_TOKEN" ' +
    `"$1/internal/skill-bundle" | tar xzf - -C ${SKILLS_MOUNT_DIR}`;
  return {
    name: "skills",
    image,
    command: ["sh", "-c", script],
    args: ["sh", opts.endpoint],
    envFrom: [],
    volumeMounts: [{ name: "skills", mountPath: SKILLS_MOUNT_DIR }],
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: opts.runAsUser,
      capabilities: { drop: ["ALL"] },
    },
  };
}
