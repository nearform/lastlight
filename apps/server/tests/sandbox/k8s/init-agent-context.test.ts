import { describe, it, expect } from "vitest";
import { buildAgentContextInitContainer } from "#src/sandbox/k8s/init-agent-context.js";
import { WORKSPACE_DIR } from "#src/sandbox/k8s/pod.js";

describe("buildAgentContextInitContainer", () => {
  const c = buildAgentContextInitContainer("img", {
    endpoint: "http://h.ns.svc:8644",
    runAsUser: 10001,
  });

  it("fetches the context with the token from env and writes it to <workspace>/AGENTS.md", () => {
    expect(c.name).toBe("agent-context");
    const script = c.command?.[2] ?? "";
    expect(script).toContain("Authorization: Bearer $LASTLIGHT_AGENT_CONTEXT_TOKEN");
    expect(script).toContain("/internal/agent-context");
    expect(script).toContain(`-o ${WORKSPACE_DIR}/AGENTS.md`);
    // endpoint is a positional arg ($1), not interpolated into the script text
    expect(c.args).toEqual(["sh", "http://h.ns.svc:8644"]);
    expect(script).not.toContain("http://h.ns.svc:8644");
  });

  it("mounts the workspace volume at the workspace root and is restricted-compliant", () => {
    expect(c.volumeMounts).toContainEqual({ name: "workspace", mountPath: WORKSPACE_DIR });
    expect(c.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext?.runAsNonRoot).toBe(true);
    expect(c.securityContext?.runAsUser).toBe(10001);
    expect(c.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });
});
