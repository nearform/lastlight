/**
 * Skill-bundle harness endpoint — in-process round-trip.
 *
 * This validates the serve+unpack contract the sandbox Pod's initContainer
 * depends on: a real bundle (built via `buildSkillTar`) is registered in a
 * fresh `SkillBundleRegistry`, served by the real `mountSkillBundle` route
 * over `app.request`, and the response body is piped through the system
 * `tar` binary — the same unpack step `init-skills.ts` runs in-pod. No
 * cluster needed, so this test runs in the normal suite (not gated on
 * `RUN_K8S_IT`).
 *
 * What's still deferred: the actual pod → harness fetch over the network
 * (initContainer curling the harness Service) can't be exercised until the
 * harness is reachable from a sandbox Pod, which needs the harness deployed
 * in-cluster (Plan 6). Once that lands, extend
 * `kubernetes.integration.test.ts`'s `RUN_K8S_IT`-gated suite with a case
 * that provisions a real pod and asserts the skill lands under
 * `SKILLS_MOUNT_DIR` inside it — run via
 * `RUN_K8S_IT=1 pnpm --filter lastlight-core exec vitest run \
 *   tests/sandbox/k8s/kubernetes.integration.test.ts`
 * against a cluster where the harness Service resolves.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { buildSkillTar, SkillBundleRegistry } from "#src/sandbox/k8s/skill-bundle.js";
import { mountSkillBundle } from "#src/sandbox/k8s/skill-bundle-route.js";

describe("skill-bundle harness endpoint (in-process round-trip)", () => {
  it("harness endpoint serves a tar that unpacks to the staged skills", async () => {
    const skillSrc = mkdtempSync(join(tmpdir(), "skills-src-"));
    const out = mkdtempSync(join(tmpdir(), "it-skills-"));
    try {
      const prReview = join(skillSrc, "pr-review");
      mkdirSync(prReview, { recursive: true });
      writeFileSync(join(prReview, "SKILL.md"), "# pr-review");

      const { tar } = buildSkillTar([prReview]);
      const reg = new SkillBundleRegistry();
      const token = reg.register(tar);
      const app = new Hono();
      mountSkillBundle(app, reg);

      const res = await app.request("/internal/skill-bundle", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);

      const tgz = join(out, "b.tgz");
      writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
      execFileSync("tar", ["xzf", tgz, "-C", out]);
      expect(existsSync(join(out, "pr-review", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(skillSrc, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
