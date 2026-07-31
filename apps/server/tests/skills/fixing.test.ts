import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getWorkflow, loadPromptTemplate } from "#src/workflows/loader.js";
import { renderTemplate } from "#src/workflows/templates.js";
import type { TemplateContext } from "#src/workflows/templates.js";

/**
 * Sync guard for the `fixing` skill's vocabulary. The five failure classes and
 * the two completion markers are a CONTRACT between three surfaces that cannot
 * import each other:
 *
 *   - `skills/fixing/SKILL.md`               — where the agent learns them
 *   - `workflows/prompts/diagnose-ci.md`     — where the agent is told to emit one
 *   - `pr-fix.yaml` / `dependabot-ci-fix.yaml` — `skip_if` + `requires_marker`,
 *     which parse the emitted strings
 *
 * Markdown can't import, so this test is the only thing keeping them in sync —
 * same pattern and rationale as `tests/cron/label-vocab.test.ts`. Rename a
 * class and this fails until every surface moves with it. Phase 4's retry
 * policy pins the same list from the code side.
 */

/** The five classes, in the order SKILL.md tabulates them. */
const CLASSES = [
  "reproducible",
  "env-mismatch",
  "flaky",
  "infra-dependent",
  "upstream-broken",
] as const;

/** The three that STOP the run — no fix phase, no `requires-human`, still `succeeded`. */
const NON_FIXABLE = ["flaky", "infra-dependent", "upstream-broken"] as const;

const DIAGNOSIS_MARKER = "DIAGNOSIS_COMPLETE";
const FIX_MARKER = "CI_FIX_COMPLETE";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

const skill = read("skills/fixing/SKILL.md");
const diagnosePrompt = read("workflows/prompts/diagnose-ci.md");

describe("fixing skill — the five failure classes", () => {
  it("names all five verbatim in SKILL.md", () => {
    for (const cls of CLASSES) expect(skill).toContain(`\`${cls}\``);
  });

  it("has no sixth class in the marker's class enum", () => {
    const enumLine = skill.match(/class=<([^>]+)>/);
    expect(enumLine).not.toBeNull();
    expect(enumLine![1].split("|")).toEqual([...CLASSES]);
  });

  it("carries the frontmatter the loader requires", () => {
    expect(skill).toMatch(/^---\n/);
    expect(skill).toContain("name: fixing");
    expect(skill).toMatch(/\ndescription: .+/);
    // Never — it would drop the skill from the agent's catalogue entirely.
    expect(skill).not.toContain("disable-model-invocation");
  });
});

describe("fixing skill — the completion markers", () => {
  it("documents both markers", () => {
    expect(skill).toContain(DIAGNOSIS_MARKER);
    expect(skill).toContain(FIX_MARKER);
  });

  it("matches what the workflows enforce with requires_marker", () => {
    for (const name of ["pr-fix", "dependabot-ci-fix"]) {
      const byPhase = new Map(getWorkflow(name).phases.map((p) => [p.name, p]));
      expect(byPhase.get("diagnose")?.on_output?.requires_marker).toBe(DIAGNOSIS_MARKER);
      expect(byPhase.get("fix")?.on_output?.requires_marker).toBe(FIX_MARKER);
    }
  });

  it("tells the diagnose prompt to emit the marker and keep `class=` unique", () => {
    expect(diagnosePrompt).toContain(DIAGNOSIS_MARKER);
    // The skip_if guard reads the class off this token, so a stray `class=`
    // elsewhere in the output would change what the workflow does.
    expect(diagnosePrompt).toContain("Write `class=` nowhere else.");
  });
});

describe("fix-loop prompts render cleanly", () => {
  const PROMPTS = ["prompts/diagnose-ci.md", "prompts/pr-fix.md", "prompts/dependabot-ci-fix.md"];

  // Phase 4 seeds attempt/maxAttempts/priorAttempts and Phase 1 seeds
  // baseChecksState, so these prompts must read correctly BOTH before and after
  // those land — hence the bare context.
  const full = {
    owner: "acme", repo: "widgets", prNumber: 7, prTitle: "Bump lodash", issueTitle: "Bump lodash",
    commentBody: "please fix", branch: "dependabot/npm/lodash", baseBranch: "main",
    baseChecksState: "failing", reason: "checks-failing", ciSection: "FAILED CHECKS:\n- build",
    attempt: 2, maxAttempts: 3, priorAttempts: "attempt 1: class=reproducible cause=x",
    phaseOutputs: { diagnosis: "DIAGNOSIS_COMPLETE: pr=7 attempt=2 class=reproducible" },
  } as unknown as TemplateContext;
  const bare = { owner: "acme", repo: "widgets", prNumber: 7 } as unknown as TemplateContext;

  // renderTemplate's `{{#if}}` is explicitly NON-nesting — the outer block ends
  // at the FIRST `{{/if}}`, so a nested conditional leaves raw mustache in the
  // agent's prompt. That is invisible to every other test here.
  it.each(PROMPTS)("%s leaves no unrendered mustache", (path) => {
    const template = loadPromptTemplate(path);
    for (const ctx of [full, bare]) {
      expect(renderTemplate(template, ctx)).not.toContain("{{");
    }
  });

  it("the fix prompts render the diagnosis handoff and drop it when absent", () => {
    for (const path of ["prompts/pr-fix.md", "prompts/dependabot-ci-fix.md"]) {
      const template = loadPromptTemplate(path);
      expect(renderTemplate(template, full)).toContain("DIAGNOSIS_COMPLETE: pr=7 attempt=2");
      expect(renderTemplate(template, bare)).not.toContain("DIAGNOSIS");
    }
  });
});

describe("fixing skill — the non-fixable classes gate the fix phase", () => {
  it.each(["pr-fix", "dependabot-ci-fix"])("%s skip_if covers exactly the three", (name) => {
    const fix = getWorkflow(name).phases.find((p) => p.name === "fix")!;
    const exprs = Array.isArray(fix.skip_if) ? fix.skip_if : [fix.skip_if!];
    expect(exprs).toEqual(
      NON_FIXABLE.map((cls) => `phaseOutputs.diagnosis.contains('class=${cls}')`),
    );
  });

  it("keeps the two fixable classes OUT of skip_if", () => {
    const fix = getWorkflow("pr-fix").phases.find((p) => p.name === "fix")!;
    const joined = (Array.isArray(fix.skip_if) ? fix.skip_if : [fix.skip_if!]).join(" ");
    const nonFixable: readonly string[] = NON_FIXABLE;
    for (const cls of CLASSES.filter((c) => !nonFixable.includes(c))) {
      expect(joined).not.toContain(`class=${cls}`);
    }
  });
});
