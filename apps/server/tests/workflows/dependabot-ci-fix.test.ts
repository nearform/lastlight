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

  it("types the repair commit so it cannot cut a release", () => {
    // The repair commit lands in the MANAGED repo, not here — this repo cuts
    // releases by hand. On a managed repo that derives releases from commit
    // types (release-please, semantic-release), `fix` is releasable, so a bump
    // that merely needed a base-branch merge cut a patch release whose
    // changelog read "make #123 mergeable". `chore` is hidden by the
    // conventional-changelog presets.
    //
    // Asserted as the TYPE of the published message, not as
    // `not.toContain("fix(deps):")`: that guards only the one value this
    // replaced, and a later `feat(deps):` would sail through it while cutting a
    // MINOR release — the same bug, one notch worse. Anchoring the type rejects
    // every releasable type at once, and `chore(deps)!:` with them, since a `!`
    // breaking marker cuts a MAJOR whatever the type in front of it.
    const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");
    const message = prompt.match(/message:\s*"([^"]+)"/);
    expect(message).not.toBeNull();
    expect(message![1]).toMatch(/^chore\(deps\):/);
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
// Issue #442 — `cron-dependabot-ci-fix` was pushing commits onto
// `dependabot/*` branches owned by Dependabot / Renovate, which the bot then
// force-pushed away on its next sync, cancelling any review that saw the fix
// and forcing a maintainer to manually run `@dependabot rebase`. The whole
// loop must instead drive the bot by PR comment on those branches — and a
// hard guard in `github_publish` refuses the write so even an accidental
// push cannot land there.
describe("dependabot-ci-fix — bot-owned branch routing (issue #442)", () => {
  const prompt = loadPromptTemplate("prompts/dependabot-ci-fix.md");

  it("intercepts bot-owned branches BEFORE step 1 with the @dependabot commands", () => {
    // The interceptor must name both prefixes (Dependabot and Renovate) — the
    // prompt covers the family, not just one vendor — and route ALL four
    // reasons (behind / dirty / checks-failing / blocked) to either a bare
    // rebase/recreate command or to the human path.
    expect(prompt).toMatch(/`dependabot\/`\s+OR\s+`renovate\/`/);
    // Same soft-wrap problem as the second test below — collapse whitespace
    // before substring-matching.
    const flatPrompt = prompt.replace(/\s+/g, " ");
    expect(flatPrompt).toMatch(/@dependabot rebase/);
    expect(flatPrompt).toMatch(/@dependabot recreate/);

    // Place the block BEFORE the existing step 1: dependabot-ci-fix.md orders
    // it as the first thing after `INSTRUCTIONS:`, before the `git fetch` /
    // `git merge FETCH_HEAD` step. A literal copy/paster following the
    // numbered steps could not reach `github_publish` from here.
    // Soft-wrap aware: `indexOf` on the literal substring misses the
    // `\n    recreate` line break, so normalize whitespace first.
    const flat = prompt.replace(/\s+/g, " ");
    const interceptorEnd = flat.indexOf("@dependabot recreate");
    const step1Index = flat.indexOf("FIRST bring the branch up to date");
    expect(interceptorEnd).toBeGreaterThan(0);
    expect(step1Index).toBeGreaterThan(0);
    expect(interceptorEnd).toBeLessThan(step1Index);
  });

  it("instructs a SINGLE PR comment, not a push, on bot-owned branches", () => {
    // `github_add_issue_comment` is the only branch-mutation primitive on a
    // bot-owned branch — the language test pins that, and so does the absence
    // of any `git push` instruction outside the AFTER FIXING block. The
    // helpful refresher: the bot-mode block never references step 5, the gate
    // runner, or `github_publish` — it routes around them entirely.
    expect(prompt).toContain("github_add_issue_comment");
    expect(prompt).toContain("@dependabot rebase");
    // The prompt soft-wraps `@dependabot recreate` across two lines, so
    // collapse whitespace before checking.
    const flatPrompt = prompt.replace(/\s+/g, " ");
    expect(flatPrompt).toContain("@dependabot recreate");
  });

  it("tells the agent NOT to fall back to git push on bot-owned branches", () => {
    // The same prohibition the rest of this prompt carries for the signed-
    // publish path, repeated here so the bot-mode block stands alone when an
    // agent reads only it.
    const interceptor = prompt.match(
      /IF `\{\{branch\}\}` STARTS WITH `dependabot\/`[\s\S]*?(?=\n\nBelow this block)/,
    );
    expect(interceptor).not.toBeNull();
    expect(interceptor![0]).toMatch(/do NOT (push|fall back|work around)/i);
    expect(interceptor![0]).toMatch(/git push/);
  });

it("branches the four `reason` values into the four correct commands", () => {
    // The four reasons a runner can summon this workflow on a dependency PR,
    // each mapped to either a Dependabot command OR the human escalation.
    // `behind` rebase, `dirty` recreate, `checks-failing` recreate (the
    // common fitter when recreate's fresh re-lock resolves it), `blocked`
    // routes to `requires-human` because no comment can clear a reviewer
    // gate. The Dependabot half is the @dependabot slash commands; the
    // Renovate half is the `rebase` label via `github_add_labels` (Renovate
    // does NOT parse @dependabot commands).
    const flatPrompt = prompt.replace(/\s+/g, " ");

    expect(prompt).toMatch(/`behind`[\s\S]*?@dependabot rebase/);
    expect(prompt).toMatch(/`dirty`[\s\S]*?@dependabot\s+recreate/);
    expect(prompt).toMatch(/`checks-failing`[\s\S]*?@dependabot\s+recreate/);
    expect(prompt).toMatch(/`blocked`[\s\S]*?(requires-human|STOP)/);

    expect(flatPrompt).toMatch(/`renovate\/`[\s\S]*?rebase/i);
    expect(flatPrompt).toMatch(/`github_add_labels`/);
    expect(prompt).toMatch(/Renovate does NOT parse/i);
  });

  it("routes Renovate to `github_add_labels` with the `rebase` label, not @dependabot slash commands", () => {
    // Renovate's rebase trigger is the `rebase` label, exactly what
    // `dependabot-pr-merge.md` uses on green-then-blocked Renovate PRs. The
    // prompt must NOT tell the agent to post `@dependabot` comments on a
    // `renovate/*` branch — Renovate ignores those entirely.
    const renovateBlock = prompt.match(
      /\*\*`renovate\/`[\s\S]*?(?=\n\nThen \(for both families\))/,
    );
    expect(renovateBlock).not.toBeNull();
    expect(renovateBlock![0]).toContain("`github_add_labels`");
    expect(renovateBlock![0]).toContain("rebase");
    expect(renovateBlock![0]).toMatch(/requires-human/);
    expect(renovateBlock![0]).not.toMatch(/@dependabot rebase/);
    expect(renovateBlock![0]).not.toMatch(/@dependabot recreate/);
  });

  it("writes a no-op gate as the first bot-branch step, so the loop closes after one iteration", () => {
    // The fix phase's `generic_loop` runs `bash .git/lastlight-verify.sh`
    // after every iteration; without a script (or with a red one) it exits 1
    // and the prompt is re-rendered, posting the bot nudge a second time. The
    // bot-branch path MUST write `exit 0` as the ENTIRE contents of the
    // verify script FIRST, before posting the comment, so `until_bash`
    // closes the loop after exactly one iteration — single comment, no
    // duplicate on re-render (issue #442, contractually closes a fixed
    // duplicate-comment bug the placeholder prompt left open).
    const flatPrompt = prompt.replace(/\s+/g, " ");
    // The very first thing the interceptor asks the agent to do — before
    // any comment or label work — is the no-op gate. Place matches a
    // leading "FIRST: write the no-op gate" / "exit 0" pair close to the
    // `INSTRUCTIONS:` line, BEFORE the Dependabot / Renovate branching.
    const gateStep = prompt.match(
      /INSTRUCTIONS:[\s\S]*?FIRST: write the no-op gate\.?[\s\S]*?exit 0/,
    );
    expect(gateStep).not.toBeNull();
    const dependabotStep = flatPrompt.indexOf("Dependabot parses a");
    const renameStep = flatPrompt.indexOf("Renovate does NOT parse");
    expect(dependabotStep).toBeGreaterThan(0);
    expect(renameStep).toBeGreaterThan(0);
    // Gate step exists within the interceptor block and precedes the
    // Dependabot/Renovate branching.
    const gateIdx = flatPrompt.indexOf("exit 0");
    expect(gateIdx).toBeLessThan(dependabotStep);
    expect(gateIdx).toBeLessThan(renameStep);
  });

  it("leaves the non-bot branch path untouched (steps 1-5 still apply)", () => {
    // The interceptor only routes bot branches; the numbered steps still own
    // the human-authored dependency PR repair. The contract test pins that,
    // because a future "simpler" rewrite that drops steps out for everyone
    // would break the open-source case where a maintainer's hand-written
    // bump PR needs the same fix-loop Lat Light already runs on green-bumps.
    expect(prompt).toContain("FIRST bring the branch up to date with its base");
    expect(prompt).toContain("git merge --no-edit FETCH_HEAD");
    expect(prompt).toContain("Publish with `github_publish`");
    expect(prompt).toContain('message: "chore(deps): make #{{prNumber}} mergeable"');
  });
});
