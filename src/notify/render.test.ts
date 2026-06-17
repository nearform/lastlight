import { describe, it, expect } from "vitest";
import { renderProgress, collapseDetail, STATUS_EMOJI } from "./render.js";
import type { ProgressModel } from "./types.js";

describe("renderProgress", () => {
  const model: ProgressModel = {
    title: "build for #18",
    subtitle: "Add retry to fetch",
    meta: ["Branch: [`lastlight/18`](https://example/tree/lastlight/18)"],
    steps: [
      { key: "guardrails", label: "Guardrails", status: "done", detail: "READY" },
      { key: "architect", label: "Architect", status: "running" },
      { key: "pr", label: "PR", status: "pending" },
    ],
    footer: "Artifacts: .lastlight/",
  };

  it("renders heading, subtitle, meta, checklist and footer in order", () => {
    const out = renderProgress(model);
    const lines = out.split("\n");
    expect(lines[0]).toBe("### 🤖 build for #18");
    expect(out).toContain("**Add retry to fetch**");
    expect(out).toContain("Branch: [`lastlight/18`]");
    expect(out).toContain(`- ${STATUS_EMOJI.done} **Guardrails** — READY`);
    expect(out).toContain(`- ${STATUS_EMOJI.running} **Architect**`);
    expect(out).toContain(`- ${STATUS_EMOJI.pending} **PR**`);
    expect(out.trimEnd().endsWith("Artifacts: .lastlight/")).toBe(true);
  });

  it("omits detail dash when a step has no detail", () => {
    const out = renderProgress(model);
    expect(out).toContain(`**Architect**\n`);
    expect(out).not.toContain("**Architect** —");
  });

  it("renders a minimal model (no subtitle/meta/footer)", () => {
    const out = renderProgress({ title: "t", steps: [{ key: "a", label: "A", status: "pending" }] });
    expect(out).toContain("### 🤖 t");
    expect(out).toContain(`- ${STATUS_EMOJI.pending} **A**`);
  });
});

describe("collapseDetail", () => {
  it("keeps a short-label markdown link intact even when the URL is long (regression)", () => {
    // The exact shape from build.yaml: short link text, very long branch-encoded URL.
    const url =
      "https://github.com/cliftonc/lastlight/blob/" +
      encodeURIComponent("lastlight/91-feature-allow-configuration-of-otel-endp") +
      "/.lastlight/issue-91/architect-plan.md";
    const detail = `Plan ready — [architect-plan.md](${url})`;
    expect(detail.length).toBeGreaterThan(160); // raw string would trip a naive cap
    const out = collapseDetail(detail);
    expect(out).toBe(detail); // returned whole — not truncated
    expect(out!.endsWith(")")).toBe(true); // link closes cleanly
    expect(out).not.toContain("…");
  });

  it("truncates genuinely long prose (no link) with an ellipsis", () => {
    const prose = "x".repeat(200);
    const out = collapseDetail(prose);
    expect(out).toBe(`${"x".repeat(159)}…`);
    expect(out!.length).toBe(160);
  });

  it("collapses to the first non-empty trimmed line", () => {
    const out = collapseDetail("\n  \n  hello world  \nsecond line\n");
    expect(out).toBe("hello world");
  });

  it("returns undefined for empty or whitespace-only input", () => {
    expect(collapseDetail("")).toBeUndefined();
    expect(collapseDetail("   \n  \n")).toBeUndefined();
  });
});
