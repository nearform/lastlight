/**
 * Drive one phase in the real, interactive Claude Code CLI inside the sandbox.
 *
 * Not `claude -p`: an interactive session in a detached tmux terminal, as the
 * non-root `agent` user, with permissions bypassed (the sandbox is the
 * boundary). The harness pre-answers every first-run screen through Claude
 * Code's own settings files, pastes the phase prompt as literal text, and
 * learns the session is finished from a `Stop` hook that touches a marker.
 * Meanwhile it tails the session transcript and feeds every line through the
 * {@link ClaudeTranscriptTranslator}, so the dashboard shows the session like
 * any agentic-pi phase.
 *
 * Nothing here may wait on a person. Every way a session can stop making
 * progress has an exit: not ready in time, a quiet transcript (stalled), the
 * phase timeout, the terminal ending, a sign-in failure, a usage limit.
 *
 * The runner never sees the Claude token: it lives in the container env the
 * executor built ({@link sandboxEnvForClaudeCode}).
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { SandboxEvent, ClaudeCodeExecPort } from "../../sandbox/sandbox.js";
import type { ClaudeCodeConfig } from "./model-ref.js";
import { ClaudeTranscriptTranslator } from "./transcript.js";

export type { ClaudeCodeExecPort } from "../../sandbox/sandbox.js";

/** Claude Code's config dir inside the sandbox (`CLAUDE_CONFIG_DIR`). */
export const CLAUDE_CONFIG_DIR = "/home/agent/.claude-ll";
/** Touched by the session's `Stop` hook when Claude finishes its turn. */
export const DONE_MARKER = `${CLAUDE_CONFIG_DIR}/ll-done`;
const SETTINGS_FILE = `${CLAUDE_CONFIG_DIR}/ll-settings.json`;
const STATE_FILE = `${CLAUDE_CONFIG_DIR}/.claude.json`;
const TMUX_SESSION = "ll";

/**
 * Text that shows Claude Code's input box is up and taking input. Provisional
 * for the pinned version: re-checked against a real capture at deploy.
 */
export const READY_MARKERS: readonly string[] = ["bypass permissions on", "? for shortcuts"];

export type ClaudeCodeOutcome =
  | { kind: "done"; sessionId: string }
  | { kind: "usage_limit"; sessionId: string; resetsAt: string | null }
  | {
      kind: "failed";
      reason: "not_ready" | "stalled" | "timeout" | "auth_failed" | "exited";
      sessionId?: string;
    };

export interface ClaudeCodeSessionOpts {
  /** The Claude model id, prefix already stripped (`claude-opus-5-5`). */
  model: string;
  prompt: string;
  /** The phase's working directory inside the sandbox. */
  cwd: string;
  /** Staged skill dirs (sandbox paths); copied into Claude's skills dir. */
  skillDirs?: string[];
  /**
   * The phase's agent context (what agentic-pi phases get as AGENTS.md),
   * written as Claude's user memory (`CLAUDE.md` in its config dir).
   */
  memory?: string;
  /** Continue an earlier session from its kept transcript instead of starting fresh. */
  resume?: { sessionId: string; lines: string[] };
  config: ClaudeCodeConfig;
  timeoutSeconds: number;
  onEvent: (e: SandboxEvent) => void;
  /** Every raw transcript line, so the caller can keep it for a later resume. */
  onRawLine: (line: string) => void;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  sessionId?: string;
}

/** Claude Code's project dir name for a cwd: every non-alphanumeric → `-`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The prompt as it is pasted. Control characters (other than newline and tab)
 * are dropped, so an ESC can never end the bracketed paste early and type the
 * rest as keys. A prompt that would open as a slash command, a shell (`!`) or
 * a memory note (`#`) gets a neutral first line.
 */
export function pastablePrompt(prompt: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = prompt.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return /^\s*[/!#]/.test(clean) ? `Task:\n${clean.trimStart()}` : clean;
}

function sh(script: string, ...args: string[]): string[] {
  return ["sh", "-c", script, "sh", ...args];
}

const writeFile = (path: string): string[] =>
  sh('umask 077; mkdir -p "$(dirname "$1")" && cat > "$1"', path);

export async function runClaudeCodeSession(
  port: ClaudeCodeExecPort,
  opts: ClaudeCodeSessionOpts,
): Promise<ClaudeCodeOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sessionId = opts.resume?.sessionId ?? opts.sessionId ?? randomUUID();
  const pollMs = opts.config.pollSeconds * 1000;
  const translator = new ClaudeTranscriptTranslator({ sessionId, now: () => new Date(now()) });
  const replayed = new Set(opts.resume?.lines ?? []);
  let stream: { stop(): void } | undefined;

  try {
    await prepare(port, opts, sessionId);

    const resumeArgs = opts.resume ? ["--resume", sessionId] : ["--session-id", sessionId];
    await port.exec(
      [
        "tmux", "new-session", "-d", "-s", TMUX_SESSION, "-x", "200", "-y", "50", "--",
        "claude",
        "--dangerously-skip-permissions",
        "--model", opts.model,
        "--disallowedTools", "AskUserQuestion",
        "--settings", SETTINGS_FILE,
        // Only the harness's own settings: a repo's .claude/settings.json
        // (env, apiKeyHelper, hooks) never steers the session.
        "--setting-sources", "user",
        ...resumeArgs,
      ],
      { cwd: opts.cwd },
    );

    if (!(await waitReady(port, opts.config, now, sleep))) {
      return { kind: "failed", reason: "not_ready", sessionId };
    }

    let lastGrowth = now();
    stream = port.stream(
      sh(
        'while :; do f=$(find "$1/projects" -name "$2.jsonl" 2>/dev/null | head -n 1); ' +
          '[ -n "$f" ] && exec tail -n +1 -F "$f"; sleep 1; done',
        CLAUDE_CONFIG_DIR,
        sessionId,
      ),
      (line) => {
        // A resumed session may append to the same file: its old lines were
        // already shown and counted in the earlier attempt.
        if (replayed.has(line)) return;
        lastGrowth = now();
        opts.onRawLine(line);
        for (const e of translator.translate(line)) opts.onEvent(e);
      },
    );

    // The prompt goes in as a bracketed paste from a buffer: literal text, so
    // a line like `C-c` is never a key, and a leading `/` is never a command.
    await port.exec(["tmux", "load-buffer", "-b", "ll-prompt", "-"], { stdin: pastablePrompt(opts.prompt) });
    await port.exec(["tmux", "paste-buffer", "-p", "-d", "-b", "ll-prompt", "-t", TMUX_SESSION]);
    await sleep(500);
    await port.exec(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);

    const started = now();
    const stallMs = opts.config.stallMinutes * 60_000;
    const timeoutMs = opts.timeoutSeconds * 1000;
    for (;;) {
      await sleep(pollMs);
      const done = (await port.exec(["test", "-f", DONE_MARKER])).code === 0;
      // The limit and sign-in checks come first: Claude Code ends its turn on
      // either, which fires the Stop hook too.
      const stopped = accountStop(translator, sessionId);
      if (stopped) return stopped;
      if (done) {
        // Let the last transcript lines land before the stream is stopped,
        // then look again: the limit or sign-in line may be among them.
        await sleep(pollMs);
        return accountStop(translator, sessionId) ?? { kind: "done", sessionId };
      }
      const t = now();
      if (t - started >= timeoutMs) return { kind: "failed", reason: "timeout", sessionId };
      if (t - lastGrowth >= stallMs) return { kind: "failed", reason: "stalled", sessionId };
      if ((await port.exec(["tmux", "has-session", "-t", TMUX_SESSION])).code !== 0) {
        return { kind: "failed", reason: "exited", sessionId };
      }
    }
  } finally {
    stream?.stop();
    await port.exec(["tmux", "kill-session", "-t", TMUX_SESSION]).catch(() => undefined);
    // Anything the session left running (a background job) dies too, so it
    // cannot change the workspace after the harness has checked it.
    await port.exec(["sh", "-c", "kill -KILL -1 2>/dev/null; true"]).catch(() => undefined);
  }
}

/** The session ended on the account (sign-in failed, usage limit), or null. */
function accountStop(translator: ClaudeTranscriptTranslator, sessionId: string): ClaudeCodeOutcome | null {
  if (translator.authFailed) return { kind: "failed", reason: "auth_failed", sessionId };
  const limit = translator.usageLimit;
  if (limit) return { kind: "usage_limit", sessionId, resetsAt: limit.resetsAt };
  return null;
}

/** Settings, skills, the resumed transcript, and a clean done marker. */
async function prepare(port: ClaudeCodeExecPort, opts: ClaudeCodeSessionOpts, sessionId: string): Promise<void> {
  const state = {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    autoUpdates: false,
    projects: { [opts.cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  };
  const settings = {
    skipDangerousModePermissionPrompt: true,
    hooks: { Stop: [{ hooks: [{ type: "command", command: `touch ${DONE_MARKER}` }] }] },
  };
  await port.exec(writeFile(STATE_FILE), { stdin: JSON.stringify(state) });
  await port.exec(writeFile(SETTINGS_FILE), { stdin: JSON.stringify(settings) });
  await port.exec(["rm", "-f", DONE_MARKER]);
  if (opts.memory) await port.exec(writeFile(`${CLAUDE_CONFIG_DIR}/CLAUDE.md`), { stdin: opts.memory });
  for (const dir of opts.skillDirs ?? []) {
    await port.exec(["mkdir", "-p", `${CLAUDE_CONFIG_DIR}/skills`]);
    await port.exec(["cp", "-R", dir, `${CLAUDE_CONFIG_DIR}/skills/${basename(dir)}`]);
  }
  if (opts.resume) {
    const file = `${CLAUDE_CONFIG_DIR}/projects/${claudeProjectDir(opts.cwd)}/${sessionId}.jsonl`;
    await port.exec(writeFile(file), { stdin: opts.resume.lines.join("\n") + "\n" });
  }
}

async function waitReady(
  port: ClaudeCodeExecPort,
  config: ClaudeCodeConfig,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = now() + config.readyTimeoutSeconds * 1000;
  for (;;) {
    const { stdout } = await port.exec(["tmux", "capture-pane", "-p", "-t", TMUX_SESSION]);
    if (READY_MARKERS.some((m) => stdout.includes(m))) return true;
    if (now() >= deadline) return false;
    await sleep(1000);
  }
}
