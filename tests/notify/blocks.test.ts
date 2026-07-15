import { describe, it, expect } from "vitest";
import { renderApprovalBlocks, renderProgressBlocks } from "#src/notify/blocks.js";
import { STATUS_EMOJI } from "#src/notify/render.js";
import type { ProgressModel } from "#src/notify/types.js";

const base: ProgressModel = {
  title: "build for #18",
  subtitle: "Fix the flaky test",
  meta: ["branch: `feat/x`", "[PR #9](https://gh/pr/9)"],
  steps: [
    { key: "architect", label: "Architect", status: "done", detail: "planned" },
    { key: "executor", label: "Executor", status: "running" },
    { key: "reviewer", label: "Reviewer", status: "pending" },
  ],
  footer: "Artifacts: [view](https://x/art)",
};

describe("renderProgressBlocks", () => {
  it("renders a header, section subtitle, context meta, divider and step section", () => {
    const blocks = renderProgressBlocks(base);
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe("header");
    expect(types).toContain("divider");
    expect(types).toContain("context");
    expect(types).toContain("section");
    // Header text is the model title (with the robot prefix), plain_text.
    const header = blocks[0] as any;
    expect(header.text.type).toBe("plain_text");
    expect(header.text.text).toContain("build for #18");
  });

  it("renders each step with its status emoji and bold label", () => {
    const blocks = renderProgressBlocks(base);
    const stepText = (blocks as any[])
      .filter((b) => b.type === "section")
      .map((b) => b.text.text)
      .join("\n");
    expect(stepText).toContain(`${STATUS_EMOJI.done} *Architect*`);
    expect(stepText).toContain(`${STATUS_EMOJI.running} *Executor*`);
    expect(stepText).toContain("— planned"); // detail rendered
  });

  it("converts markdown links in meta/footer to Slack mrkdwn", () => {
    const blocks = renderProgressBlocks(base) as any[];
    const context = blocks.find((b) => b.type === "context");
    const joined = context.elements.map((e: any) => e.text).join(" ");
    expect(joined).toContain("<https://gh/pr/9|PR #9>");
  });

  it("stays within Slack's block cap for a very long checklist", () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({
      key: `s${i}`,
      label: `Step ${i}`,
      status: "pending" as const,
    }));
    const blocks = renderProgressBlocks({ title: "big", steps });
    expect(blocks.length).toBeLessThanOrEqual(48);
  });

  it("keeps each section under Slack's character limit when steps are huge", () => {
    const steps = Array.from({ length: 40 }, (_, i) => ({
      key: `s${i}`,
      label: "L".repeat(200),
      status: "done" as const,
    }));
    const blocks = renderProgressBlocks({ title: "wide", steps }) as any[];
    for (const b of blocks) {
      if (b.type === "section") expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  it("truncates an over-long title to Slack's header limit", () => {
    const blocks = renderProgressBlocks({ title: "T".repeat(300), steps: [] }) as any[];
    expect(blocks[0].text.text.length).toBeLessThanOrEqual(150);
  });
});

describe("renderApprovalBlocks", () => {
  it("emits Approve/Reject buttons carrying the workflow run id", () => {
    const blocks = renderApprovalBlocks("Plan ready — **approve**?", "run-123") as any[];
    // The prompt renders as a section above the buttons.
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("Plan ready");
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeTruthy();
    expect(actions.elements.map((e: any) => e.action_id)).toEqual([
      "approval_approve",
      "approval_reject",
    ]);
    for (const e of actions.elements) expect(e.value).toBe("run-123");
  });
});
