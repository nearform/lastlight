import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, lstatSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunResultAccumulator, stageSkillBundle, excludeFromGit, detectAccountError, reclassifySuccess } from "#src/engine/agent-executor.js";

/**
 * A pi assistant `message_end` event carrying per-message usage. Mirrors the
 * shape lastlight receives over the JSONL stream (pi `Usage`: input / output /
 * cacheRead / cacheWrite + a nested `cost`).
 */
function assistantMessageEnd(opts: {
  text?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: number;
  toolCalls?: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
    content.push({ type: "toolCall", id: `t${i}`, name: "read", arguments: {} });
  }
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content,
      usage: {
        input: opts.input,
        output: opts.output,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        cost: { total: opts.cost },
      },
    },
  };
}

/** The terminal `usage_snapshot` pi synthesizes from getSessionStats(). */
function usageSnapshot(stats: {
  assistantMessages: number;
  input: number;
  output: number;
  cost: number;
}): Record<string, unknown> {
  return {
    type: "usage_snapshot",
    stats: {
      userMessages: 0,
      assistantMessages: stats.assistantMessages,
      toolCalls: 0,
      toolResults: 0,
      tokens: {
        input: stats.input,
        output: stats.output,
        cacheRead: 0,
        cacheWrite: 0,
        total: stats.input + stats.output,
      },
      cost: stats.cost,
    },
  };
}

describe("RunResultAccumulator usage accounting", () => {
  it("sums per-message usage across assistant message_end events", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 100, output: 20, cost: 0.01, toolCalls: 1 }));
    acc.feed(assistantMessageEnd({ input: 200, output: 30, cacheRead: 50, cost: 0.02 }));
    acc.feed({ type: "agent_end", messages: [] });

    const stats = acc.bestStats();
    expect(stats).toBeDefined();
    expect(stats?.assistantMessages).toBe(2);
    expect(stats?.tokens.input).toBe(300);
    expect(stats?.tokens.output).toBe(50);
    expect(stats?.tokens.cacheRead).toBe(50);
    expect(stats?.tokens.total).toBe(400);
    expect(stats?.cost).toBeCloseTo(0.03, 6);
    expect(stats?.toolCalls).toBe(1);
  });

  it("prefers per-message accumulation when a compaction zeroes the snapshot", () => {
    // Simulates auto-compaction: real per-message usage streamed, but the
    // terminal snapshot recomputed from the wiped message window reports zero
    // (num_turns 0, cost 0) — the exact bug seen on the build phases.
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 5000, output: 800, cacheRead: 12000, cost: 0.42 }));
    acc.feed(assistantMessageEnd({ input: 3000, output: 400, cost: 0.18 }));
    acc.feed(usageSnapshot({ assistantMessages: 0, input: 0, output: 0, cost: 0 }));
    acc.feed({ type: "agent_end", messages: [] });

    const stats = acc.bestStats();
    expect(stats?.assistantMessages).toBe(2);
    expect(stats?.tokens.input).toBe(8000);
    expect(stats?.tokens.output).toBe(1200);
    expect(stats?.tokens.cacheRead).toBe(12000);
    expect(stats?.cost).toBeCloseTo(0.6, 6);

    // build() carries the same compaction-proof stats through to ExecutionResult.
    expect(acc.build(0).stats?.cost).toBeCloseTo(0.6, 6);
  });

  it("falls back to the snapshot when no per-message usage was reported", () => {
    // A provider that doesn't populate per-message usage: assistant messages
    // exist but their usage is all-zero, so the (non-compacted) snapshot wins.
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 0, output: 0, cost: 0 }));
    acc.feed(usageSnapshot({ assistantMessages: 1, input: 1234, output: 567, cost: 0.05 }));

    const stats = acc.bestStats();
    expect(stats?.tokens.input).toBe(1234);
    expect(stats?.tokens.output).toBe(567);
    expect(stats?.cost).toBeCloseTo(0.05, 6);
  });

  it("returns undefined stats when nothing was observed", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    expect(acc.bestStats()).toBeUndefined();
  });
});

describe("RunResultAccumulator extension status", () => {
  it("captures and normalizes extension_status events", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed({
      type: "extension_status",
      extension: "file-search",
      status: "configured",
      mode: "override",
      toolCount: 3,
    });
    acc.feed({
      type: "extension_status",
      extension: "github",
      status: "configured",
      profile: "repo-write",
      toolCount: 5,
    });
    acc.feed({
      type: "extension_status",
      extension: "web-search",
      status: "skipped",
      reason: "no-credentials",
    });

    const ext = acc.extensions();
    expect(ext).toEqual({
      "file-search": { status: "configured", mode: "override", toolCount: 3 },
      github: { status: "configured", toolCount: 5 },
      "web-search": { status: "skipped", reason: "no-credentials" },
    });
  });

  it("returns undefined when no extension_status events were seen", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 10, output: 5, cost: 0.001 }));
    expect(acc.extensions()).toBeUndefined();
  });
});

describe("RunResultAccumulator skills status", () => {
  it("captures and normalizes the skills_status event", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed({
      type: "skills_status",
      status: "configured",
      discovered: 2,
      skills: [
        { name: "pr-review", source: "/skills/pr-review/SKILL.md", modelInvocable: true },
        { name: "issue-triage", source: "/skills/issue-triage/SKILL.md", modelInvocable: false },
      ],
      mappedPaths: ["/skills"],
      noSkills: false,
    });

    expect(acc.skills()).toEqual({
      status: "configured",
      discovered: 2,
      skills: [
        { name: "pr-review", source: "/skills/pr-review/SKILL.md", modelInvocable: true },
        { name: "issue-triage", source: "/skills/issue-triage/SKILL.md", modelInvocable: false },
      ],
      mappedPaths: ["/skills"],
      noSkills: false,
    });
  });

  it("returns undefined when no skills_status event was seen", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 10, output: 5, cost: 0.001 }));
    expect(acc.skills()).toBeUndefined();
  });
});

describe("RunResultAccumulator tool errors", () => {
  it("captures the failing tool name and error text", () => {
    const acc = new RunResultAccumulator();
    acc.feed({
      type: "tool_execution_end",
      tool: "bash",
      isError: true,
      error: "insufficient_quota: You exceeded your current quota",
    });
    expect(acc.toolError()).toEqual({
      tool: "bash",
      message: "insufficient_quota: You exceeded your current quota",
    });
  });

  it("falls back to result/output when no `error` field is present", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "tool_execution_end", isError: true, result: "boom" });
    expect(acc.toolError()).toEqual({ tool: undefined, message: "boom" });
  });

  it("stringifies non-string error payloads", () => {
    const acc = new RunResultAccumulator();
    acc.feed({
      type: "tool_execution_end",
      tool: "github",
      isError: true,
      error: { status: 403, message: "forbidden" },
    });
    expect(acc.toolError()?.message).toContain("forbidden");
  });

  it("keeps the last error when several tools fail", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "tool_execution_end", tool: "read", isError: true, error: "first" });
    acc.feed({ type: "tool_execution_end", tool: "bash", isError: true, error: "second" });
    expect(acc.toolError()).toEqual({ tool: "bash", message: "second" });
  });

  it("returns undefined when no tool errored", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "tool_execution_end", tool: "read", isError: false, result: "ok" });
    expect(acc.toolError()).toBeUndefined();
  });
});

describe("detectAccountError", () => {
  it("does NOT flag a successful run whose report mentions auth/rate-limit terms", () => {
    // Regression: `verify` reporting that an endpoint is "Unauthorized", or a
    // curl probing a 401, must not be mistaken for a provider account error.
    expect(
      detectAccountError({
        success: true,
        finalText: "## Verify\nThe /admin endpoint returns 401 Unauthorized — no rate limit observed.",
        toolErrorText: "curl: (7) Failed to connect to 127.0.0.1 port 4173",
        fatalErrorMessage: "bash failed: Unauthorized",
      }),
    ).toBe(false);
  });

  it("flags a genuine provider account error surfaced via the agent-error channel", () => {
    expect(
      detectAccountError({
        success: false,
        agentErrorMessage: "insufficient_quota: You exceeded your current quota",
      }),
    ).toBe(true);
  });

  it("on a failed run, folds in tool/output text to label why it failed", () => {
    expect(
      detectAccountError({
        success: false,
        toolErrorText: "Error: invalid_api_key",
      }),
    ).toBe(true);
    expect(
      detectAccountError({
        success: false,
        finalText: "the provider reported your credit balance is too low",
      }),
    ).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(detectAccountError({ success: true, finalText: "all good" })).toBe(false);
    expect(detectAccountError({ success: false, toolErrorText: "file not found" })).toBe(false);
  });
});

describe("RunResultAccumulator truncation detection", () => {
  it("flags a run whose final assistant turn ended on a tool call", () => {
    // The prod failure mode: "I have enough. Let me confirm X" + a tool call,
    // the tool result comes back, and the loop ends before synthesis.
    const acc = new RunResultAccumulator();
    acc.feed(assistantMessageEnd({ text: "Let me check the docs.", input: 1, output: 1, cost: 0, toolCalls: 1 }));
    acc.feed({ type: "tool_execution_end", tool: "bash", isError: false, result: "grep output" });
    acc.feed({ type: "agent_end", messages: [] });
    expect(acc.endedOnToolCall()).toBe(true);
  });

  it("does not flag a run that ended on a text-only synthesis turn", () => {
    const acc = new RunResultAccumulator();
    acc.feed(assistantMessageEnd({ text: "Looking...", input: 1, output: 1, cost: 0, toolCalls: 1 }));
    acc.feed({ type: "tool_execution_end", tool: "bash", isError: false, result: "grep output" });
    // A final assistant turn with the answer text and no further tool call.
    acc.feed(assistantMessageEnd({ text: "Here is the answer.", input: 1, output: 1, cost: 0, toolCalls: 0 }));
    acc.feed({ type: "agent_end", messages: [] });
    expect(acc.endedOnToolCall()).toBe(false);
  });

  it("reflects the latest assistant turn, not earlier tool-calling ones", () => {
    const acc = new RunResultAccumulator();
    acc.feed(assistantMessageEnd({ text: "step 1", input: 1, output: 1, cost: 0, toolCalls: 2 }));
    acc.feed(assistantMessageEnd({ text: "done", input: 1, output: 1, cost: 0, toolCalls: 0 }));
    expect(acc.endedOnToolCall()).toBe(false);
  });

  it("defaults to false before any assistant turn", () => {
    const acc = new RunResultAccumulator();
    expect(acc.endedOnToolCall()).toBe(false);
  });
});

describe("reclassifySuccess — degenerate 'success' guard", () => {
  const base = { hasAgentError: false, endedOnToolCall: false, finalText: "here is the answer" };

  it("keeps a real answer as success", () => {
    expect(reclassifySuccess("success", base)).toBe("success");
  });

  it("reclassifies an empty completion (agent_end, no answer, not mid-tool-call) as unknown", () => {
    // The prod failure: after burying itself in giant tool output, the final
    // turn comes back empty. mapStopReason called it "success" on agent_end
    // alone — this must fail instead of passing green.
    expect(reclassifySuccess("success", { ...base, finalText: "" })).toBe("unknown");
    expect(reclassifySuccess("success", { ...base, finalText: "   \n" })).toBe("unknown");
  });

  it("reclassifies a run cut off mid-tool-call as error_truncated (takes precedence over empty)", () => {
    expect(reclassifySuccess("success", { ...base, endedOnToolCall: true, finalText: "" })).toBe("error_truncated");
    expect(reclassifySuccess("success", { ...base, endedOnToolCall: true })).toBe("error_truncated");
  });

  it("passes through a real agent error untouched", () => {
    expect(reclassifySuccess("error_agent", { ...base, hasAgentError: true, finalText: "" })).toBe("error_agent");
  });

  it("passes through an already-non-success reason untouched", () => {
    expect(reclassifySuccess("error_fatal", { ...base, finalText: "" })).toBe("error_fatal");
    expect(reclassifySuccess("unknown", { ...base, finalText: "" })).toBe("unknown");
  });
});

describe("stageSkillBundle", () => {
  function makeSkillSource(root: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
    return dir;
  }

  it("stages skills into a per-phase bundle under .lastlight-skills/<phaseKey>/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillbundle-"));
    try {
      const src = makeSkillSource(join(tmp, "sources"), "pr-review");
      const ws = join(tmp, "workspace");
      mkdirSync(ws, { recursive: true });

      const staged = stageSkillBundle(ws, "reviewer", [src], "copy");

      const bundle = join(ws, ".lastlight-skills", "reviewer", "pr-review");
      expect(staged).toEqual([bundle]);
      expect(existsSync(join(bundle, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("clears only its own phase subtree, leaving sibling phases intact", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillbundle-"));
    try {
      const src = makeSkillSource(join(tmp, "sources"), "guardrails");
      const ws = join(tmp, "workspace");
      mkdirSync(ws, { recursive: true });

      stageSkillBundle(ws, "architect", [src], "copy");
      stageSkillBundle(ws, "executor", [src], "copy");
      // Re-staging architect must not disturb executor's bundle — the
      // isolation that makes parallel phases in one workspace safe.
      stageSkillBundle(ws, "architect", [src], "copy");

      const skillsRoot = join(ws, ".lastlight-skills");
      expect(readdirSync(skillsRoot).sort()).toEqual(["architect", "executor"]);
      expect(existsSync(join(skillsRoot, "executor", "guardrails", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined and clears the bundle when the phase has no skills", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillbundle-"));
    try {
      const src = makeSkillSource(join(tmp, "sources"), "issue-triage");
      const ws = join(tmp, "workspace");
      mkdirSync(ws, { recursive: true });

      stageSkillBundle(ws, "triage", [src], "copy");
      const cleared = stageSkillBundle(ws, "triage", [], "copy");

      expect(cleared).toBeUndefined();
      expect(existsSync(join(ws, ".lastlight-skills", "triage"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("symlinks the skill dir in symlink mode (gondolin/none)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillbundle-"));
    try {
      const src = makeSkillSource(join(tmp, "sources"), "explore");
      const ws = join(tmp, "workspace");
      mkdirSync(ws, { recursive: true });

      const staged = stageSkillBundle(ws, "read_context", [src], "symlink");
      expect(staged).toHaveLength(1);
      expect(lstatSync(staged![0]).isSymbolicLink()).toBe(true);
      expect(existsSync(join(staged![0], "SKILL.md"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("excludeFromGit", () => {
  it("adds the entry to .git/info/exclude (idempotently)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gitexclude-"));
    try {
      const repo = join(tmp, "repo");
      mkdirSync(join(repo, ".git", "info"), { recursive: true });

      excludeFromGit(repo, ".lastlight-skills");
      excludeFromGit(repo, ".lastlight-skills"); // second call must not duplicate

      const body = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
      expect(body.match(/\/\.lastlight-skills\//g)).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves existing exclude content", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gitexclude-"));
    try {
      const repo = join(tmp, "repo");
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      writeFileSync(join(repo, ".git", "info", "exclude"), "# git ls-files --others\n*.tmp\n");

      excludeFromGit(repo, ".lastlight-skills");

      const body = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
      expect(body).toContain("*.tmp");
      expect(body).toContain("/.lastlight-skills/");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when the dir is not a git checkout (workspace root)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gitexclude-"));
    try {
      // No .git here — must not throw and must not create anything.
      expect(() => excludeFromGit(tmp, ".lastlight-skills")).not.toThrow();
      expect(existsSync(join(tmp, ".git"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
