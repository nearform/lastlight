import { describe, it, expect, afterEach } from "vitest";
import { configureWorkflowAssets } from "#src/workflows/loader.js";
import { getWorkflowTriggers, getWorkflowTriggerKinds } from "#src/workflows/triggers.js";

/**
 * The Slack rows of the trigger table are DERIVED from each workflow's own
 * `chat:` block — the same source the chat agent advertises from. They used to
 * be a hand-kept list of five while the router routed nine, so the dashboard
 * showed no Slack trigger at all for verify / qa-test / demo / answer.
 */
describe("getWorkflowTriggers — Slack rows", () => {
  afterEach(() => configureWorkflowAssets());

  function slackCommands(workflow: string): string[] {
    return getWorkflowTriggers(workflow)
      .filter((t) => t.kind === "slack")
      .map((t) => (t as { command: string }).command);
  }

  it("covers every workflow the Slack switch can dispatch", () => {
    configureWorkflowAssets();
    expect(slackCommands("build")).toEqual(["build"]);
    expect(slackCommands("explore")).toEqual(["explore"]);
    expect(slackCommands("issue-triage")).toEqual(["triage"]);
    expect(slackCommands("pr-review")).toEqual(["review"]);
    expect(slackCommands("security-review")).toEqual(["security"]);
    // The four the hardcoded list omitted.
    expect(slackCommands("verify")).toEqual(["verify"]);
    expect(slackCommands("qa-test")).toEqual(["qa-test"]);
    expect(slackCommands("demo")).toEqual(["demo"]);
    expect(slackCommands("answer")).toEqual(["question"]);
  });

  it("describes a workflow by its chat trigger phrase", () => {
    configureWorkflowAssets();
    const triage = getWorkflowTriggers("issue-triage").find((t) => t.kind === "slack");
    expect(triage).toMatchObject({ description: "Slack: `triage owner/repo`" });
  });

  it("falls back to the summary for a workflow with no phrase to type", () => {
    // `answer` is reached by asking a research question, not by a command.
    configureWorkflowAssets();
    const answer = getWorkflowTriggers("answer").find((t) => t.kind === "slack");
    expect(answer).toMatchObject({ kind: "slack", command: "question" });
    expect((answer as { description: string }).description).toMatch(/^Slack: Research a question/);
  });

  it("gives no Slack row to a cron-only workflow", () => {
    // repo-health carries a `chat:` block (so the agent can explain it) but no
    // classification intent, so nothing in Slack dispatches it.
    configureWorkflowAssets();
    expect(slackCommands("repo-health")).toEqual([]);
    expect(getWorkflowTriggerKinds("repo-health")).toContain("cron");
  });

  it("gives no Slack row to the GitHub-only dependency workflows", () => {
    configureWorkflowAssets();
    expect(slackCommands("dependabot-ci-fix")).toEqual([]);
    expect(slackCommands("dependabot-pr-merge")).toEqual([]);
  });

  it("surfaces the structured @bot mention commands", () => {
    configureWorkflowAssets();
    for (const [workflow, needle] of [
      ["verify", "verify <claim>"],
      ["qa-test", "qa-test <target>"],
      ["demo", "demo <notes>"],
      ["security-review", "security-review"],
    ] as const) {
      const mentions = getWorkflowTriggers(workflow).filter((t) => t.kind === "mention");
      expect(mentions.some((m) => (m as { description: string }).description.includes(needle))).toBe(true);
    }
  });
});
