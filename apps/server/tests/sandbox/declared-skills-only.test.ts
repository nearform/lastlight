import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildRunAgentScript } from "#src/sandbox/k8s/run-agent-script.js";

/**
 * A phase's `skills:` key is the WHOLE list, on every backend.
 *
 * ── What this pins, and why it is not cosmetic ─────────────────────────────
 *
 * agentic-pi runs Pi's own skill DISCOVERY unless told not to, so a skill that
 * merely exists on the host — or in the image, or in the pod's home — joins the
 * catalogue alongside the ones the workflow declared. Core never passed
 * `noSkills`, so it did.
 *
 * Measured 2026-09-22 on the `201815` eval arm: **69 of 69 agent sessions**
 * recorded `"noSkills":false` and carried the operator's personal
 * `~/.agents/skills` catalogue — `writing-great-skills`, `tdd`, `to-prd`,
 * `triage`, `handoff`, … — into a `pr-review` survey pass whose YAML declares
 * exactly `skills: [survey-pass]`. Two distinct problems, one cause:
 *
 *   1. **Measurements stop being reproducible.** Every number in that campaign
 *      was produced with one machine's skill catalogue in the reviewer's
 *      context, and nothing in the artifact recorded it.
 *   2. **Unreviewed instructions reach a privileged agent.** The same seam
 *      feeds the `repo-write` phases.
 *
 * The precedent is `--no-web-search`, whose own comment in `run-agent-script.ts`
 * says it is "REQUIRED, not cosmetic" because agentic-pi auto-enables search
 * from ambient env. Identical shape: an ambient capability is ON unless
 * switched off, so the switch belongs at every call site, not at one.
 *
 * Pi keeps loading explicit paths when `noSkills` is set (`--skill X
 * --no-skills` loads X — `packages/agentic-pi/src/runner.ts`), so this narrows
 * the catalogue to the declaration; it never empties it.
 *
 * The three container/VM backends are asserted on their SOURCE rather than by
 * booting a sandbox, because each builds an argv for a process this suite does
 * not run. That is a weaker assertion than an integration test and is chosen
 * deliberately: a source scan cannot drift silently the way a mocked argv can,
 * and the real integration coverage (`command-exec.integration.test.ts`) is
 * opt-in behind `RUN_SANDBOX_IT`.
 */
/** Mirrors the fixture in `k8s/run-agent-script.test.ts`: every flag off. */
const k8sBase = {
  profile: false,
  skillDirs: [] as readonly string[],
  thinking: false,
  webSearch: false,
  webSearchProvider: false,
  artifactUpload: false,
  gateTimeoutSeconds: 900,
};

const SRC = (rel: string) => readFileSync(join(import.meta.dirname, "../../src/sandbox", rel), "utf8");

describe("every backend loads ONLY the skills the phase declared", () => {
  it("in-process (gondolin + none) passes noSkills to agentic-pi", () => {
    const src = SRC("sandbox.ts");
    // The option sits in the same `agenticRun({...})` literal as `skillPaths`,
    // which is what makes "declared list only" true rather than "no skills".
    expect(src).toMatch(/skillPaths: opts\.skillDirs,[\s\S]{0,1400}?noSkills: true,/);
  });

  it("docker passes --no-skills", () => {
    expect(SRC("docker.ts")).toContain('extraArgs.push("--no-skills")');
  });

  it("smol passes --no-skills", () => {
    expect(SRC("smol.ts")).toContain('piArgs.push("--no-skills")');
  });

  it("kubernetes emits --no-skills in the in-pod argv, alongside the declared --skill dirs", () => {
    const args = buildRunAgentScript({ ...k8sBase, profile: true, skillDirs: ["/skills/survey-pass"] });
    expect(args).toContain("--skill /skills/survey-pass");
    expect(args).toContain("--no-skills");
  });

  it("kubernetes emits --no-skills even when the phase declares no skills at all", () => {
    // The empty case is the one a reader expects to be exempt and must not be:
    // a phase declaring nothing should get nothing, not everything on the host.
    const args = buildRunAgentScript(k8sBase);
    expect(args).not.toContain("--skill ");
    expect(args).toContain("--no-skills");
  });
});
