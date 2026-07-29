import { describe, it, expect } from "vitest";
import { buildSkillsInitContainer } from "#src/sandbox/k8s/init-skills.js";
import { SKILLS_MOUNT_DIR } from "#src/sandbox/k8s/skill-bundle.js";

describe("buildSkillsInitContainer", () => {
  const c = buildSkillsInitContainer("img", { endpoint: "http://h.ns.svc:8644", runAsUser: 10001 });

  it("fetches the bundle with the token from env and unpacks into the skills mount", () => {
    expect(c.name).toBe("skills");
    const script = c.command?.[2] ?? "";
    expect(script).toContain('Authorization: Bearer $LASTLIGHT_SKILL_TOKEN');
    expect(script).toContain("/internal/skill-bundle");
    expect(script).toContain(`tar xzf - -C ${SKILLS_MOUNT_DIR}`);
    // endpoint is a positional arg ($1), not interpolated into the script text
    expect(c.args).toEqual(["sh", "http://h.ns.svc:8644"]);
    expect(script).not.toContain("http://h.ns.svc:8644");
  });

  it("mounts the shared skills volume and is restricted-compliant", () => {
    expect(c.volumeMounts).toContainEqual({ name: "skills", mountPath: SKILLS_MOUNT_DIR });
    expect(c.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });
});
