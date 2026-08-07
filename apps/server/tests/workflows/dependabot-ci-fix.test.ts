import { describe, it, expect } from "vitest";
import {
  getWorkflow,
  getCronWorkflows,
  getWorkflowByIntent,
  loadPromptTemplate,
} from "#src/workflows/loader.js";

/**
 * Contract test for the built-in dependabot-ci-fix workflow + its red-PR cron
 * backstop. Loads the REAL workflows/ dir (like dependabot-pr-merge.test.ts) so a
 * schema break or an accidental rewiring of the intent / cron is caught.
 */
describe("dependabot-ci-fix — built-in workflow + cron", () => {
  it("loads with diagnose → fix and the dependabot-ci-fix intent", () => {
    const def = getWorkflow("dependabot-ci-fix");
    expect(def.name).toBe("dependabot-ci-fix");
    expect(def.classification?.intent).toBe("dependabot-ci-fix");
    // Diagnose-then-fix: the cheap classification runs BEFORE the expensive
    // install + test cycle. Still fix-only — it never classifies/labels/merges;
    // once its push turns checks green, `dependabot-pr-merge` owns that
    // decision (see router pr.checks_passed).
    expect(def.phases.map((p) => p.name)).toEqual(["diagnose", "fix"]);
  });

  it("gates both phases on the PARSEABLE completion marker", () => {
    const def = getWorkflow("dependabot-ci-fix");
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    // With the colon, because the engine's postcondition is a bare substring
    // test while the parser only recognises `<TAG>:`. The bare tag let an output
    // that merely mentioned `DIAGNOSIS_COMPLETE` pass the gate and parse to
    // nothing, which pinned the attempt counter at 1 for the life of the PR.
    expect(byName.get("diagnose")?.on_output?.requires_marker).toBe("DIAGNOSIS_COMPLETE:");
    // Closes the missing-postcondition gap: a run that inspects the PR and
    // stops without pushing or labelling used to report green.
    expect(byName.get("fix")?.on_output?.requires_marker).toBe("CI_FIX_COMPLETE:");
  });

  it("skips the fix phase on the three non-fixable diagnosis classes", () => {
    const def = getWorkflow("dependabot-ci-fix");
    const fix = def.phases.find((p) => p.name === "fix")!;
    // A NON-FAILING skip, deliberately not `on_output.contains_BLOCKED:
    // {action: fail}`: `failed` is reserved for malfunction, and correctly
    // determining a PR can't be fixed here is a succeeded run. Read off the
    // harvested class, which survives a resume and cannot be forged by prose.
    expect(fix.skip_if).toEqual([
      "scratch.fixMarkers.diagnosis.class == 'flaky'",
      "scratch.fixMarkers.diagnosis.class == 'infra-dependent'",
      "scratch.fixMarkers.diagnosis.class == 'upstream-broken'",
    ]);
    expect(fix.messages?.on_skipped_done).toBeTruthy();
  });

  it("runs diagnose on `fixing` and fix on `fixing` + `building`", () => {
    const def = getWorkflow("dependabot-ci-fix");
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.skill).toBe("fixing");
    expect(byName.get("diagnose")?.output_var).toBe("diagnosis");
    // `fixing` first — the runner directs the agent to the primary skill.
    expect(byName.get("fix")?.skills).toEqual(["fixing", "building"]);
  });

  it("merges FETCH_HEAD in step 1, never the remote-tracking ref", () => {
    // `--depth` implies `--single-branch`, so `remote.origin.fetch` covers the
    // PR head only and `git fetch origin <base>` updates FETCH_HEAD while
    // leaving `origin/<base>` exactly where it was. The prompt merged that
    // stale ref, so a fix run could resolve yesterday's conflict and leave
    // today's — the PR stays `dirty` and GitHub stops building it entirely.
    const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");
    expect(prompt).toContain("git fetch origin {{baseBranch}}");
    expect(prompt).toContain("git merge --no-edit FETCH_HEAD");
    expect(prompt).not.toContain("git merge --no-edit origin/{{baseBranch}}");
  });

  it("hands the fix phase the settled-check COUNT, not just the state", () => {
    // A `dirty` PR has no merge ref, so no `pull_request` workflow is created
    // at all and the only thing left reporting is a commit-status app keying
    // off the push — `checksState` then reads `passing` off one check where
    // eleven used to settle. The count is the evidence that green is hollow.
    const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");
    expect(prompt).toContain("{{checksState}}");
    expect(prompt).toContain("{{settledCheckCount}}");
  });

  it("is resolvable by intent (the router's pr.checks_failed fallback route)", () => {
    expect(getWorkflowByIntent("dependabot-ci-fix")?.name).toBe("dependabot-ci-fix");
  });

  it("registers a per-PR red-discovery cron that always runs (no webhooksEnabled gate)", () => {
    const cron = getCronWorkflows().find((c) => c.workflow === "dependabot-ci-fix");
    expect(cron).toBeDefined();
    // The cron runner (src/index.ts) keys the per-PR fan-out off this flag — find
    // settled-red dependency PRs in code, dispatch one bounded run each.
    expect(cron!.context?.discover).toBe("red-dependency-prs");
    // Additive backstop alongside the real-time pr.checks_failed webhook.
    expect(cron!.condition?.unless).toBeUndefined();
  });
});

describe("dependabot-ci-fix — the publish step", () => {
  it("publishes through github_publish, not git push", () => {
    const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");
    expect(prompt).toContain("github_publish");
    // A sandbox-built commit is unsigned, and one unsigned commit anywhere in
    // the branch blocks a required_signatures PR permanently (issue #268).
    expect(prompt).not.toContain("git push origin HEAD");
  });

  it("tells the agent not to work around a refused publish", () => {
    const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");
    expect(prompt).toMatch(/do NOT (fall back to |work around)/i);
  });

  it("does not instruct pushing in prose for the no-diagnosis merge-only path", () => {
    // The `{{#if !phaseOutputs.diagnosis}}` block covers `dirty` / `behind` /
    // `blocked` PRs — the common case for this workflow — and is reached
    // BEFORE the AFTER FIXING section that actually calls `github_publish`.
    // It used to read as a self-contained recipe ending in a raw "push, and
    // report `outcome=pushed`", which a literal reader could follow straight
    // into an unsigned `git push` without ever reaching AFTER FIXING. A test
    // that only checks the literal string `git push` (as above) would not
    // have caught this — the block never named the command, just the verb.
    // Strip the `outcome=pushed` marker value first: that's vocabulary the
    // harness parses (fix-markers.ts), not an instruction to push.
    const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");
    const block = prompt.match(/\{\{#if !phaseOutputs\.diagnosis\}\}([\s\S]*?)\{\{\/if\}\}/);
    expect(block).not.toBeNull();
    const withoutMarker = block![1].replace(/outcome=pushed/g, "");
    expect(withoutMarker).not.toMatch(/\bpush(ed|es|ing)?\b/i);
  });
});
