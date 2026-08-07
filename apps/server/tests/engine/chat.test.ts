import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { configureWorkflowAssets } from "#src/workflows/loader.js";
import { chatSystemSuffix, chatTriggers, resetChatPromptCache } from "#src/engine/chat/chat.js";

/**
 * The chat prompt is COMPOSED from the enabled workflow set (each workflow's
 * `chat:` block), not a hand-written constant. It drifted as a constant: `verify`
 * and `qa-test` shipped chat-routable and unadvertised for releases, and nothing
 * stopped it naming a workflow an operator had disabled.
 *
 * So these tests assert the composition rules against the REAL packaged
 * workflows — a new one that forgets its `chat:` block, or an existing trigger
 * phrase that changes, shows up here.
 */
describe("chatSystemSuffix — composed from the packaged workflows", () => {
  beforeEach(() => {
    configureWorkflowAssets();
    resetChatPromptCache();
  });

  const prompt = () => chatSystemSuffix(true);

  it("advertises every packaged workflow that declares a chat trigger", () => {
    const p = prompt();
    expect(p).toContain("build owner/repo#N");
    expect(p).toContain("triage owner/repo");
    expect(p).toContain("review PRs on owner/repo");
    expect(p).toContain("security review owner/repo");
    expect(p).toContain("explore owner/repo");
    // The two that the old hardcoded constant silently omitted.
    expect(p).toContain("verify owner/repo#N");
    expect(p).toContain("qa-test owner/repo#N");
    // Advertised now that the Slack switch actually has a `demo` branch.
    expect(p).toContain("demo owner/repo#N");
  });

  it("advertises the reserved control intents, but not the `chat` catch-all", () => {
    const list = triggerList(prompt());
    for (const control of ["`status`", "`reset`", "`approve`", "`reject`"]) {
      expect(list).toContain(control);
    }
    // `chat` is the router's fallback, not something a user types.
    expect(list).not.toMatch(/`chat`/);
  });

  it("does not advertise workflows that chat cannot actually dispatch", () => {
    const p = prompt();
    // Both dependency workflows are pr_scoped and reach `handlePrFix` through
    // `context.prNumber`, which no Slack branch ever sets. They are now in
    // WELL_KNOWN_INTENTS so the fallback won't half-dispatch them either.
    expect(p).not.toContain("dependabot-ci-fix");
    expect(p).not.toContain("dependabot-pr-merge");
  });

  it("keeps health out of the suggestable triggers while still explaining it", () => {
    // repo-health runs on a cron and has no classification block, so it is a
    // deflect-only entry: the agent must know what to SAY without offering it
    // as something to type.
    expect(triggerList(prompt())).not.toMatch(/\bhealth\b/i);
    expect(prompt()).toContain("weekly health report");
    expect(prompt()).toMatch(/cron schedule, not on demand/);
  });

  it("renders a deflect bullet with its quoted phrasings and reply", () => {
    expect(prompt()).toContain(
      '- "triage this issue" / "triage <repo>#<n>" / "label this issue"\n' +
        '  → reply: "tell me `triage owner/repo#N`"',
    );
  });

  it("honours a per-workflow reply override", () => {
    // `answer` can't just be typed — it needs the user to name a managed repo.
    expect(prompt()).toMatch(/→ this runs as a sandboxed answer workflow/);
  });

  it("never advertises leading-slash command tokens", () => {
    // Slack intercepts any message starting with `/` before it reaches Last
    // Light, so the prompt must never suggest slash commands.
    expect(prompt()).not.toMatch(/(^|`)\/(build|triage|review|security|health|status)\b/);
  });

  it("includes the never-suggest-leading-slash rule", () => {
    expect(prompt()).toMatch(/never suggest.*leading/i);
  });

  it("omits every workflow trigger when GitHub is not configured", () => {
    // No GitHub tools are registered, so none of these can run.
    const p = chatSystemSuffix(false);
    expect(p).toContain("NO GitHub access configured");
    expect(p).not.toContain("triage owner/repo");
    expect(p).not.toContain("Natural-language triggers");
  });
});

describe("chatSystemSuffix — reacts to the workflow set", () => {
  let builtIn: string;
  let overlay: string;

  function wf(name: string, extra: string[] = []): string {
    return [`name: ${name}`, ...extra, "phases:", "  - name: p", "    type: context", ""].join("\n");
  }

  const chatBlock = (trigger: string) => [
    "chat:",
    `  trigger: ${trigger}`,
    "  summary: Do the thing",
  ];

  beforeEach(() => {
    builtIn = mkdtempSync(join(tmpdir(), "chat-builtin-"));
    overlay = mkdtempSync(join(tmpdir(), "chat-overlay-"));
    for (const root of [builtIn, overlay]) {
      mkdirSync(join(root, "workflows", "prompts"), { recursive: true });
    }
    // The base templates the composition renders into.
    const realPrompts = resolve("workflows/prompts");
    for (const f of ["chat-system.md", "chat-system-no-github.md"]) {
      writeFileSync(
        join(builtIn, "workflows", "prompts", f),
        readFileSync(join(realPrompts, f), "utf-8"),
      );
    }
    resetChatPromptCache();
  });

  afterEach(() => {
    configureWorkflowAssets();
    resetChatPromptCache();
  });

  it("advertises an OVERLAY workflow with no core edit", () => {
    writeFileSync(join(builtIn, "workflows", "a.yaml"), wf("a", chatBlock("do a thing")));
    writeFileSync(
      join(overlay, "workflows", "incident.yaml"),
      wf("incident", chatBlock("incident owner/repo")),
    );
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay });
    resetChatPromptCache();

    expect(chatSystemSuffix(true)).toContain("incident owner/repo");
  });

  it("drops a workflow disabled in static config", () => {
    writeFileSync(join(builtIn, "workflows", "a.yaml"), wf("a", chatBlock("do a thing")));
    writeFileSync(join(builtIn, "workflows", "b.yaml"), wf("b", chatBlock("do b thing")));
    configureWorkflowAssets({ builtInRoot: builtIn, disabled: { workflows: ["b"] } });
    resetChatPromptCache();

    const p = chatSystemSuffix(true);
    expect(p).toContain("do a thing");
    expect(p).not.toContain("do b thing");
  });

  it("drops a workflow disabled at RUNTIME by the dashboard kill switch", () => {
    // `listAgentWorkflows()` filters static `disabled.workflows` but knows
    // nothing about the `workflow_overrides` table an admin toggles without a
    // restart. Advertising one of those would name a trigger that no-ops at
    // dispatch (`simple.ts`), which is indistinguishable from the bot ignoring
    // the user.
    writeFileSync(join(builtIn, "workflows", "a.yaml"), wf("a", chatBlock("do a thing")));
    writeFileSync(join(builtIn, "workflows", "b.yaml"), wf("b", chatBlock("do b thing")));
    configureWorkflowAssets({ builtInRoot: builtIn });
    resetChatPromptCache();

    const p = chatSystemSuffix(true, { isWorkflowEnabled: (n) => n !== "b" });
    expect(p).toContain("do a thing");
    expect(p).not.toContain("do b thing");
    expect(chatTriggers({ isWorkflowEnabled: (n) => n !== "b" }).map((e) => e.workflow)).toEqual(["a"]);
  });

  it("stays silent about a workflow with no chat block", () => {
    writeFileSync(join(builtIn, "workflows", "a.yaml"), wf("a", chatBlock("do a thing")));
    writeFileSync(join(builtIn, "workflows", "quiet.yaml"), wf("quiet"));
    configureWorkflowAssets({ builtInRoot: builtIn });
    resetChatPromptCache();

    expect(chatSystemSuffix(true)).not.toContain("quiet");
  });
});

/** The backticked list under the "triggers you can suggest" heading. */
function triggerList(prompt: string): string {
  const block = prompt.match(/Natural-language triggers you can suggest:\n(.*)/);
  expect(block).not.toBeNull();
  return block![1];
}

describe("skills/chat/SKILL.md frontmatter", () => {
  // The chat skill description is surfaced to the agent at boot via
  // the chat skill catalogue, so it must be slash-free too.
  const md = readFileSync(resolve("skills/chat/SKILL.md"), "utf-8");
  const frontmatter = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

  it("does not advertise leading-slash command tokens", () => {
    expect(frontmatter).not.toMatch(/\/(build|triage|review|security|health|status)\b/);
  });

  it("points at the composed trigger list rather than carrying a copy", () => {
    // A second hand-maintained copy is exactly what drifted.
    expect(md).not.toContain("triage owner/repo");
    expect(md).toMatch(/system prompt/i);
  });
});
