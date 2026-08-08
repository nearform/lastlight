import { describe, it, expect } from "vitest";
import { getWorkflow, getWorkflowByIntent, getCronWorkflows } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in issue-triage workflow. Loads the REAL
 * workflows/ dir (like golden-build.test.ts) so a schema break or a dropped
 * postcondition is caught.
 */
describe("issue-triage — built-in workflow", () => {
  it("loads with a single triage phase using the issue-triage skill", () => {
    const def = getWorkflow("issue-triage");
    expect(def.name).toBe("issue-triage");
    expect(def.phases.map((p) => p.name)).toEqual(["triage"]);
    expect(def.phases[0].skill).toBe("issue-triage");
  });

  it("gates the triage phase on a completion marker (no silent no-op successes)", () => {
    // Without this, an agent that bails — e.g. the k8s sandbox exposed no
    // github_* tools, so it couldn't list/label issues and just explained it
    // couldn't proceed — still scored `succeeded`. The marker turns that
    // bail-out RED (the skill only emits it after doing the work).
    const def = getWorkflow("issue-triage");
    expect(def.phases[0].on_output?.requires_marker).toBe("TRIAGE_COMPLETE");
  });

  it("is resolvable by the triage intent", () => {
    expect(getWorkflowByIntent("triage")?.name).toBe("issue-triage");
  });


  /**
   * The classification block is the ONLY thing standing between a question
   * about issues and a sandbox (issue: the Slack message "Are there any issues
   * in cliftonc/drizzle-cube that are overdue?" classified TRIAGE).
   *
   * It was one line long and defined the intent purely by SUBJECT MATTER —
   * "scan/triage issues on a repo" — with no deliverable and no
   * counter-examples, while every peer block states what comes out ("the
   * deliverable is an ANSWER", "make code changes NOW", "a short screen-recorded
   * mp4"). So any sentence pairing "issues" with a repo matched it.
   *
   * These assertions are deliberately about the SHAPE of the prompt rather than
   * its wording: the block must state that it needs one issue, must name the
   * CHAT downgrade, and must carry counter-examples that resolve to CHAT.
   * Without them the classifier has nothing to discriminate on, however the
   * sentences are phrased.
   */
  it("scopes the triage intent to ONE issue, not a repo-wide sweep", () => {
    const def = getWorkflow("issue-triage");
    const text = def.classification?.description ?? "";
    expect(text).toMatch(/one\b|single/i);
    // The old block advertised exactly this, which the Slack path cannot do —
    // repo-wide triage is the cron's `mode: scan` and nothing else sets it.
    expect(text).not.toMatch(/scan\/triage issues on a repo/i);
  });

  it("tells the classifier that a question ABOUT issues is CHAT", () => {
    const def = getWorkflow("issue-triage");
    const text = def.classification?.description ?? "";
    expect(text).toMatch(/CHAT/);
    expect(text).toMatch(/overdue|stale|unassigned/i);
  });

  it("carries counter-examples that resolve to CHAT, including the real misroute", () => {
    const def = getWorkflow("issue-triage");
    const examples = def.classification?.examples ?? [];
    const chat = examples.filter((e) => /INTENT: CHAT/.test(e));
    expect(chat.length).toBeGreaterThanOrEqual(3);
    // The exact sentence that burned 110s of sandbox and answered nothing.
    expect(chat.some((e) => /overdue/i.test(e))).toBe(true);
    // And the positive case still has to name an issue.
    expect(examples.some((e) => /INTENT: TRIAGE/.test(e) && /ISSUE: \d+/.test(e))).toBe(true);
  });

  it("is dispatched by the triage-new-issues cron, so the marker covers cron runs too", () => {
    // The every-15-min scan (webhooks-disabled backstop) is exactly the
    // batch/cron path that produced the false-green bail this marker fixes. If
    // this `workflow:` wiring drifts — a rename, an accidental edit — the marker
    // enforcement silently stops applying to cron-triggered runs, and nothing
    // else catches it. (Mirrors dependabot-pr-merge.test.ts's cron coverage.)
    const cron = getCronWorkflows().find((c) => c.workflow === "issue-triage");
    expect(cron).toBeDefined();
    expect(cron!.name).toBe("triage-new-issues");
    expect(cron!.context?.mode).toBe("scan");
  });
});
