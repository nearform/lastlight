/**
 * Per-run GitHub credentials must NOT travel through the shared `process.env`
 * (issue #215).
 *
 * The in-process backends (`gondolin` / `none`) run the agent *in the harness
 * process*, and `concurrency.maxWorkflows` (4) of them can be live at once. The
 * executor used to splice each run's repo-scoped, profile-downscoped
 * `GITHUB_TOKEN` — plus `GITHUB_APP_* = ""` — into that one global env for the
 * duration of the agent turn, which produced two failures:
 *
 *   1. agentic-pi reads the env late (after `ModelRuntime.create()` + a
 *      `models.json` refresh), so a run that started inside that window captured
 *      the *other* run's token — wrong repo, and read-only if that run's profile
 *      was narrower. Every `github_*` write then 403'd with "Resource not
 *      accessible by integration" while git push kept working (it gets the token
 *      explicitly), which is exactly the reported symptom.
 *   2. Interleaved restores permanently poisoned the harness env: run B saved the
 *      values run A had spliced, so B's restore reinstated A's — leaving
 *      `GITHUB_APP_ID` falsy for good, after which the mint was skipped entirely
 *      and a stale token forwarded.
 *
 * So this test overlaps two runs against different repos/profiles and asserts
 * each agent was handed its OWN credential via the per-run `githubAuthEnv`
 * channel, and that `process.env` was never touched — during or after.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedRun {
  prompt: string;
  githubAuthEnv?: Record<string, string>;
  /** Ambient env sampled while this run's agent turn was in flight. */
  envDuring: { appId?: string; token?: string };
}

const captured: CapturedRun[] = [];

vi.mock("agentic-pi", () => ({
  run: async (opts: { prompt: string; githubAuthEnv?: Record<string, string> }) => {
    // Hold the turn open long enough for the sibling run to do its own
    // credential setup — the interleaving the bug needed.
    await new Promise((r) => setTimeout(r, 40));
    captured.push({
      prompt: opts.prompt,
      githubAuthEnv: opts.githubAuthEnv,
      envDuring: { appId: process.env.GITHUB_APP_ID, token: process.env.GITHUB_TOKEN },
    });
    // We only care about the credential handed in; bail before running an agent.
    throw new Error("concurrent-creds-test: stop after capturing run options");
  },
}));

// Mint a token that identifies the run it belongs to, so a crossed credential is
// visible in the assertion rather than being two indistinguishable strings.
vi.mock("#src/engine/github/git-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/github/git-auth.js")>();
  return {
    ...actual,
    refreshGitAuth: vi.fn(async (opts: { repositories?: string[] }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { token: `ghs_${opts.repositories?.[0] ?? "unscoped"}`, expiresAt: "" };
    }),
  };
});

const { executeAgent } = await import("#src/engine/agent-executor.js");

function stateDirs() {
  const stateDir = mkdtempSync(join(tmpdir(), "ll-exec-creds-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  return { stateDir, sessionsDir };
}

function runFor(prompt: string, repo: string, profile: "read" | "repo-write") {
  const { stateDir, sessionsDir } = stateDirs();
  return executeAgent(
    prompt,
    { sandbox: "none", stateDir, sessionsDir },
    { githubAccess: { owner: "acme", repo, profile, allowMcpAppAuth: false } },
  );
}

const saved = {
  appId: process.env.GITHUB_APP_ID,
  pem: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
  installation: process.env.GITHUB_APP_INSTALLATION_ID,
  token: process.env.GITHUB_TOKEN,
};

describe("executeAgent — per-run GitHub credentials (issue #215)", () => {
  beforeEach(() => {
    captured.length = 0;
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/app/data/secrets/app.pem";
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";
    delete process.env.GITHUB_TOKEN;
  });
  afterEach(() => {
    for (const [key, value] of [
      ["GITHUB_APP_ID", saved.appId],
      ["GITHUB_APP_PRIVATE_KEY_PATH", saved.pem],
      ["GITHUB_APP_INSTALLATION_ID", saved.installation],
      ["GITHUB_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("hands each overlapping in-process run its own minted token", async () => {
    await Promise.all([runFor("run-A", "repo-a", "repo-write"), runFor("run-B", "repo-b", "read")]);

    expect(captured).toHaveLength(2);
    const byPrompt = new Map(captured.map((c) => [c.prompt, c]));
    expect(byPrompt.get("run-A")?.githubAuthEnv).toEqual({ GITHUB_TOKEN: "ghs_repo-a" });
    expect(byPrompt.get("run-B")?.githubAuthEnv).toEqual({ GITHUB_TOKEN: "ghs_repo-b" });
  });

  it("never mutates the shared process.env — no token splice, no App-key clear", async () => {
    await Promise.all([runFor("run-A", "repo-a", "repo-write"), runFor("run-B", "repo-b", "read")]);

    // Mid-flight: the poisoning window. `GITHUB_APP_ID` staying truthy is what
    // keeps the mint from being silently skipped on every subsequent run.
    for (const c of captured) {
      expect(c.envDuring.appId).toBe("12345");
      expect(c.envDuring.token).toBeUndefined();
    }
    // And after both restores — the state the next run inherits.
    expect(process.env.GITHUB_APP_ID).toBe("12345");
    expect(process.env.GITHUB_APP_PRIVATE_KEY_PATH).toBe("/app/data/secrets/app.pem");
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("forwards only the scoped token — never the App key — to the agent", async () => {
    await runFor("run-A", "repo-a", "repo-write");

    // agentic-pi hard rule #8: the App PEM must never reach the agent, which
    // could otherwise mint itself a full-installation token.
    expect(Object.keys(captured[0].githubAuthEnv ?? {})).toEqual(["GITHUB_TOKEN"]);
  });
});
