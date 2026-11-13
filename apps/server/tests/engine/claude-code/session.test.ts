import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CLAUDE_CONFIG_DIR,
  DONE_MARKER,
  runClaudeCodeSession,
  type ClaudeCodeExecPort,
} from "#src/engine/claude-code/session.js";
import { CLAUDE_CODE_DEFAULTS } from "#src/engine/claude-code/model-ref.js";
import type { SandboxEvent } from "#src/sandbox/sandbox.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);

interface Call {
  argv: string[];
  stdin?: string;
  cwd?: string;
}

/**
 * A scripted sandbox. Time only moves when the runner sleeps, so every
 * watchdog is exercised deterministically.
 */
class FakePort implements ClaudeCodeExecPort {
  calls: Call[] = [];
  clock = 0;
  /** capture-pane shows the input box from this many captures on. */
  readyAfterCaptures = 1;
  /** `test -f ll-done` succeeds on this poll (1-based); Infinity = never. */
  doneOnPoll = Infinity;
  /** transcript lines, released one per poll. */
  lines: string[] = [];
  sessionAlive = true;
  /** After the done marker shows, release one transcript line whenever the runner sleeps. */
  releaseOnSleepAfterDone = false;
  private captures = 0;
  private polls = 0;
  private onLine?: (l: string) => void;
  streamStopped = false;

  async exec(argv: string[], opts?: { stdin?: string; timeoutMs?: number; cwd?: string }) {
    this.calls.push({ argv, stdin: opts?.stdin, cwd: opts?.cwd });
    if (argv[0] === "tmux" && argv[1] === "capture-pane") {
      this.captures += 1;
      const ready = this.captures >= this.readyAfterCaptures;
      return { code: 0, stdout: ready ? "╭────╮\n│ > │\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n" : "Loading…", stderr: "" };
    }
    if (argv[0] === "tmux" && argv[1] === "has-session") return { code: this.sessionAlive ? 0 : 1, stdout: "", stderr: "" };
    if (argv[0] === "test" && argv[2] === DONE_MARKER) {
      this.polls += 1;
      const next = this.lines.shift();
      if (next !== undefined) this.onLine?.(next);
      return { code: this.polls >= this.doneOnPoll ? 0 : 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  stream(argv: string[], onLine: (line: string) => void) {
    this.calls.push({ argv });
    this.onLine = onLine;
    return {
      stop: () => {
        this.streamStopped = true;
      },
      done: new Promise<number>(() => {}),
    };
  }

  onSleep() {
    if (!this.releaseOnSleepAfterDone || this.polls < this.doneOnPoll) return;
    const next = this.lines.shift();
    if (next !== undefined) this.onLine?.(next);
  }

  argvs(): string[][] {
    return this.calls.map((c) => c.argv);
  }
}

function start(port: FakePort, over: Partial<Parameters<typeof runClaudeCodeSession>[1]> = {}) {
  const events: SandboxEvent[] = [];
  const raw: string[] = [];
  const promise = runClaudeCodeSession(port, {
    model: "claude-opus-5-5",
    prompt: "Write the plan.",
    cwd: "/home/agent/workspace/repo",
    config: { ...CLAUDE_CODE_DEFAULTS },
    timeoutSeconds: 3600,
    onEvent: (e) => events.push(e),
    onRawLine: (l) => raw.push(l),
    now: () => port.clock,
    sleep: async (ms) => {
      port.clock += ms;
      port.onSleep();
    },
    sessionId: "6f1c2a9e-0000-4000-8000-000000000001",
    ...over,
  });
  return { promise, events, raw };
}

describe("runClaudeCodeSession", () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it("starts claude in tmux as agent with the pinned flags", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    await start(port).promise;

    const newSession = port.calls.find((c) => c.argv[0] === "tmux" && c.argv[1] === "new-session");
    expect(newSession?.argv).toEqual([
      "tmux", "new-session", "-d", "-s", "ll", "-x", "200", "-y", "50", "--",
      "claude",
      "--dangerously-skip-permissions",
      "--model", "claude-opus-5-5",
      "--disallowedTools", "AskUserQuestion",
      "--settings", `${CLAUDE_CONFIG_DIR}/ll-settings.json`,
      "--setting-sources", "user",
      "--session-id", "6f1c2a9e-0000-4000-8000-000000000001",
    ]);
    expect(newSession?.cwd).toBe("/home/agent/workspace/repo");

    // settings were written before the session started
    const startIdx = port.calls.indexOf(newSession!);
    const writes = port.calls.slice(0, startIdx).filter((c) => c.stdin !== undefined);
    const state = writes.find((c) => c.argv.includes(`${CLAUDE_CONFIG_DIR}/.claude.json`));
    const settings = writes.find((c) => c.argv.includes(`${CLAUDE_CONFIG_DIR}/ll-settings.json`));
    expect(JSON.parse(state!.stdin!)).toMatchObject({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { "/home/agent/workspace/repo": { hasTrustDialogAccepted: true } },
    });
    expect(JSON.parse(settings!.stdin!)).toMatchObject({
      skipDangerousModePermissionPrompt: true,
      hooks: { Stop: [{ hooks: [{ type: "command", command: `touch ${DONE_MARKER}` }] }] },
    });
    // a stale marker from an earlier phase can never end this one
    const rm = port.calls.findIndex((c) => c.argv.join(" ") === `rm -f ${DONE_MARKER}`);
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(startIdx);
  });

  it("resumes an earlier session from its kept transcript", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    const lines = fixture("limit.jsonl");
    await start(port, { resume: { sessionId: "6f1c2a9e-0000-4000-8000-000000000001", lines }, prompt: "continue" }).promise;
    const newSession = port.argvs().find((a) => a[1] === "new-session")!;
    expect(newSession).toContain("--resume");
    expect(newSession).not.toContain("--session-id");
    expect(newSession[newSession.indexOf("--resume") + 1]).toBe("6f1c2a9e-0000-4000-8000-000000000001");
    const restored = port.calls.find((c) =>
      c.argv.some((a) => a.endsWith("/projects/-home-agent-workspace-repo/6f1c2a9e-0000-4000-8000-000000000001.jsonl")),
    );
    expect(restored?.stdin).toBe(lines.join("\n") + "\n");
  });

  it("pastes the prompt literally", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    const prompt = "Plan it.\n/exit\nC-c ok";
    await start(port, { prompt }).promise;

    const load = port.calls.find((c) => c.argv[0] === "tmux" && c.argv[1] === "load-buffer");
    expect(load?.argv.at(-1)).toBe("-");
    expect(load?.stdin).toBe(prompt);
    const paste = port.argvs().find((a) => a[1] === "paste-buffer")!;
    expect(paste).toContain("-p");
    expect(paste.slice(-2)).toEqual(["-t", "ll"]);
    const sends = port.argvs().filter((a) => a[1] === "send-keys");
    expect(sends).toEqual([["tmux", "send-keys", "-t", "ll", "Enter"]]);
    expect(port.argvs().some((a) => a.some((x) => x.includes("/exit") || x.includes("C-c ok")))).toBe(false);
  });

  it("strips control characters from the prompt, so a paste can't end early", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    await start(port, { prompt: "a\x1b[201~b\r\nc\td\x00e\x7f\u009bf" }).promise;
    const load = port.calls.find((c) => c.argv[1] === "load-buffer");
    expect(load?.stdin).toBe("a[201~b\nc\tdef");
  });

  it.each(["/exit", "!rm -rf .", "# remember", "  /model x"])(
    "never lets a prompt start as a command or mode switch (%j)",
    async (prompt) => {
      const port = new FakePort();
      port.doneOnPoll = 1;
      await start(port, { prompt }).promise;
      const stdin = port.calls.find((c) => c.argv[1] === "load-buffer")!.stdin!;
      expect(stdin.trimStart()[0]).not.toMatch(/[/!#]/);
      expect(stdin).toContain(prompt.trim());
    },
  );

  it("writes the phase's agent context as Claude's user memory", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    await start(port, { memory: "# Agent context\nUse pnpm." }).promise;
    const newSession = port.calls.findIndex((c) => c.argv[1] === "new-session");
    const mem = port.calls.findIndex((c) => c.argv.includes(`${CLAUDE_CONFIG_DIR}/CLAUDE.md`));
    expect(mem).toBeGreaterThanOrEqual(0);
    expect(mem).toBeLessThan(newSession);
    expect(port.calls[mem]!.stdin).toBe("# Agent context\nUse pnpm.");
  });

  it("writes no memory file when there is no agent context", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    await start(port).promise;
    expect(port.calls.some((c) => c.argv.includes(`${CLAUDE_CONFIG_DIR}/CLAUDE.md`))).toBe(false);
  });

  it("returns usage_limit when the limit line lands after the Stop marker", async () => {
    const port = new FakePort();
    port.lines = fixture("limit.jsonl");
    port.doneOnPoll = 1;
    port.releaseOnSleepAfterDone = true;
    const outcome = await start(port, { now: () => Date.parse("2026-11-04T14:00:00Z") + port.clock }).promise;
    expect(outcome).toMatchObject({ kind: "usage_limit" });
  });

  it("fails not_ready when the input prompt never shows", async () => {
    const port = new FakePort();
    port.readyAfterCaptures = Infinity;
    const outcome = await start(port).promise;
    expect(outcome).toEqual({ kind: "failed", reason: "not_ready", sessionId: "6f1c2a9e-0000-4000-8000-000000000001" });
    expect(port.clock).toBeGreaterThanOrEqual(60_000);
    expect(port.clock).toBeLessThan(70_000);
    expect(port.argvs().some((a) => a[1] === "paste-buffer")).toBe(false);
    expect(port.argvs().slice(-2)).toEqual([["tmux", "kill-session", "-t", "ll"], ["sh", "-c", "kill -KILL -1 2>/dev/null; true"]]);
  });

  it("returns done on the Stop marker", async () => {
    const port = new FakePort();
    port.lines = fixture("basic.jsonl");
    port.doneOnPoll = 3;
    const { promise, events, raw } = start(port);
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "done", sessionId: "6f1c2a9e-0000-4000-8000-000000000001" });
    expect(raw).toEqual(fixture("basic.jsonl").slice(0, raw.length));
    expect(raw.length).toBeGreaterThanOrEqual(3);
    expect(events[0]).toMatchObject({ type: "session" });
    expect(events.some((e) => e.type === "message_end")).toBe(true);
    expect(port.streamStopped).toBe(true);
    expect(port.argvs().slice(-2)).toEqual([["tmux", "kill-session", "-t", "ll"], ["sh", "-c", "kill -KILL -1 2>/dev/null; true"]]);
  });

  it("fails stalled after stallMinutes without transcript growth", async () => {
    const port = new FakePort();
    port.lines = fixture("basic.jsonl").slice(0, 2);
    const outcome = await start(port).promise;
    expect(outcome).toMatchObject({ kind: "failed", reason: "stalled" });
    expect(port.clock).toBeGreaterThanOrEqual(15 * 60_000);
    expect(port.clock).toBeLessThan(17 * 60_000);
  });

  it("fails timeout at timeoutSeconds", async () => {
    const port = new FakePort();
    // keeps growing, never finishes
    port.lines = Array.from({ length: 10_000 }, () => fixture("basic.jsonl")[4]!);
    const outcome = await start(port, { timeoutSeconds: 120 }).promise;
    expect(outcome).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(port.clock).toBeGreaterThanOrEqual(120_000);
    expect(port.clock).toBeLessThan(130_000);
  });

  it("fails exited when the session ends without the marker", async () => {
    const port = new FakePort();
    port.sessionAlive = false;
    const outcome = await start(port).promise;
    expect(outcome).toMatchObject({ kind: "failed", reason: "exited" });
  });

  it("returns usage_limit with the reset", async () => {
    const port = new FakePort();
    port.lines = fixture("limit.jsonl");
    const outcome = await start(port, { now: () => Date.parse("2026-11-04T14:00:00Z") + port.clock }).promise;
    expect(outcome).toEqual({
      kind: "usage_limit",
      sessionId: "6f1c2a9e-0000-4000-8000-000000000001",
      resetsAt: "2026-11-04T15:00:00.000Z",
    });
  });

  it("returns auth_failed", async () => {
    const port = new FakePort();
    port.lines = fixture("auth.jsonl");
    const outcome = await start(port).promise;
    expect(outcome).toMatchObject({ kind: "failed", reason: "auth_failed" });
  });

  it("never logs or records the token", async () => {
    const token = "sk-ant-oat01-TESTTOKEN";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    const port = new FakePort();
    port.lines = fixture("basic.jsonl");
    port.doneOnPoll = 6;
    const { promise, events } = start(port);
    const outcome = await promise;
    const everything = JSON.stringify({ calls: port.calls, events, outcome });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("TESTTOKEN");
  });

  it("copies the phase's skills into Claude's config dir", async () => {
    const port = new FakePort();
    port.doneOnPoll = 1;
    await start(port, { skillDirs: ["/home/agent/workspace/.skills/architect/plan-writing"] }).promise;
    expect(port.argvs()).toContainEqual([
      "cp", "-R", "/home/agent/workspace/.skills/architect/plan-writing", `${CLAUDE_CONFIG_DIR}/skills/plan-writing`,
    ]);
  });
});
