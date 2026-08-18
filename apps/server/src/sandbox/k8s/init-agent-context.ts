import type { V1Container } from "@kubernetes/client-node";
import { WORKSPACE_DIR } from "./pod.js";

/**
 * The agent-context initContainer: fetch the per-run resolved agent-context
 * (persona/hard-rules) from the harness (bearer token from the creds Secret
 * env, endpoint as a positional arg so it is never interpolated into the script)
 * and write it to `<WORKSPACE_DIR>/AGENTS.md` — the workspace ROOT, never a
 * cwd-relative path, so a repo-write phase's `git add -A` can't commit the bot's
 * AGENTS.md into the customer's checkout (cwd is `<WORKSPACE_DIR>/<repo>` after a
 * pre-clone). agentic-pi reads `AGENTS.md` from cwd, and the agent container's
 * `workingDir` is inside this same workspace volume, so the file is visible.
 *
 * `envFrom` (creds Secret) is attached by `buildPodManifest`. `-f` makes curl
 * fail the init on a non-2xx so a bad fetch surfaces (checkInitContainerFailure
 * appends its logs); with `-f`, curl also suppresses the error body so a failed
 * fetch never leaves a partial/garbage `AGENTS.md` behind.
 */
export function buildAgentContextInitContainer(
  image: string,
  opts: { endpoint: string; runAsUser: number },
): V1Container {
  const script =
    'curl -fsS -H "Authorization: Bearer $LASTLIGHT_AGENT_CONTEXT_TOKEN" ' +
    `"$1/internal/agent-context" -o ${WORKSPACE_DIR}/AGENTS.md`;
  return {
    name: "agent-context",
    image,
    command: ["sh", "-c", script],
    args: ["sh", opts.endpoint],
    envFrom: [],
    volumeMounts: [{ name: "workspace", mountPath: WORKSPACE_DIR }],
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: opts.runAsUser,
      capabilities: { drop: ["ALL"] },
    },
  };
}
