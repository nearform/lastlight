/**
 * The terminal stage's merge policy (`autonomy.stages.<stage>.on_merge`).
 *
 * Two halves, and the first is the safety case: `resolveAutonomyMerge` decides
 * what a run is allowed to do with the PR it opens, and the ONE invariant worth
 * stating twice is that a human's `@bot build` never auto-merges, however the
 * stage is configured. The second half is the plumbing — does the decision
 * actually reach the template context `prompts/pr.md` renders its arm from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Fake the agent so no real model call happens; the wiring test below reads the
// prompt it was handed.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

// `getAutonomyConfig` is the operator's block, and with no boot config loaded it
// answers from the packaged `config/default.yaml` (`on_merge: none`). Stubbed so
// a test can put an `auto` stage in front of a run without standing up a whole
// runtime config; everything else in the module is the real thing.
vi.mock("#src/config/config.js", async (orig) => ({
  ...(await orig<typeof import("#src/config/config.js")>()),
  getAutonomyConfig: vi.fn(),
}));

import { executeAgent } from "#src/engine/agent-executor.js";
import {
  defaultAutonomyConfig,
  getAutonomyConfig,
  type AutonomyConfig,
  type AutonomyStageConfig,
} from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { resolveAutonomyMerge, runSimpleWorkflow } from "#src/workflows/simple.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockGetAutonomy = vi.mocked(getAutonomyConfig);

/** A stage map with `build` set to one `on_merge` value. */
function stages(onMerge: unknown): Record<string, AutonomyStageConfig> {
  return {
    build: {
      enter: "ready-for-agent",
      running: "agent-building",
      on_success: "ready-for-human",
      on_failure: "agent-blocked",
      workflow: "build",
      gates: { post_architect: true },
      on_merge: onMerge as AutonomyStageConfig["on_merge"],
    },
  };
}

/** The dispatch markers the router/gate stamp for an autonomous stage run. */
const AUTONOMOUS = { _stage: "build", _autonomous: true };

describe("resolveAutonomyMerge — what becomes of the PR a build opens", () => {
  it("projects auto for an autonomous run whose stage asked for it", () => {
    expect(resolveAutonomyMerge(AUTONOMOUS, stages("auto"))).toEqual({
      configured: "auto",
      effective: "auto",
      auto: true,
    });
  });

  it("projects none for an autonomous run whose stage asked for none", () => {
    expect(resolveAutonomyMerge(AUTONOMOUS, stages("none"))).toEqual({
      configured: "none",
      effective: "none",
      auto: false,
    });
  });

  it("treats auto-low-impact EXACTLY as none — there is no impact signal for a feature PR", () => {
    // The assumption a future reader will make is that this value does
    // something. It does not, and must not: `dependencies.autoMergeMaxImpact`
    // scores dependency bumps only, so there is nothing to score a feature PR
    // with and the conservative branch is the honest one. It is still RECORDED
    // on `configured`, which is what distinguishes it from a plain `none`.
    const low = resolveAutonomyMerge(AUTONOMOUS, stages("auto-low-impact"));
    const none = resolveAutonomyMerge(AUTONOMOUS, stages("none"));
    expect(low.effective).toBe("none");
    expect(low.auto).toBe(false);
    expect(low.effective).toBe(none.effective);
    expect(low.auto).toBe(none.auto);
    // …and the operator's actual choice survives the downgrade.
    expect(low.configured).toBe("auto-low-impact");
  });

  it("NEVER auto-merges a human-triggered `@bot build`, even when the stage says auto", () => {
    // THE invariant of this phase. A comment-triggered build carries no stage
    // markers at all, so the operator's pipeline policy does not reach it: they
    // opted a pipeline into auto-merge, not every build anyone can ask for.
    expect(resolveAutonomyMerge({}, stages("auto"))).toEqual({
      configured: "none",
      effective: "none",
      auto: false,
    });
    expect(resolveAutonomyMerge(undefined, stages("auto"))).toEqual({
      configured: "none",
      effective: "none",
      auto: false,
    });
    // A run carrying only unrelated dispatch context is equally not autonomous.
    expect(resolveAutonomyMerge({ prNumber: 7, _explicitRequest: true }, stages("auto")).auto).toBe(
      false,
    );
  });

  it("coerces an unknown or malformed on_merge to none", () => {
    for (const garbage of ["AUTO", "yes", "", null, undefined, 1, {}, ["auto"], true]) {
      const got = resolveAutonomyMerge(AUTONOMOUS, stages(garbage));
      expect(got.effective, `on_merge=${JSON.stringify(garbage)}`).toBe("none");
      expect(got.auto).toBe(false);
      expect(got.configured).toBe("none");
    }
    // A stage that is not in the map at all, and a garbage stage map.
    expect(resolveAutonomyMerge({ _stage: "nope" }, stages("auto")).auto).toBe(false);
    expect(resolveAutonomyMerge(AUTONOMOUS, {}).auto).toBe(false);
  });

  it("stays inert on the packaged config — `on_merge: none` ships", () => {
    expect(resolveAutonomyMerge(AUTONOMOUS, defaultAutonomyConfig().stages).auto).toBe(false);
  });
});

// ── The plumbing: does the decision reach the prompt? ────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-autonomy-merge-"));
}

const BUILD_YAML = `
kind: build
name: build
phases:
  - name: pr
    label: PR
    prompt: prompts/pr.md
`;

/** The arm `prompts/pr.md` carries, reduced to something assertable. */
const PR_PROMPT = "{{#if autonomyMerge.auto}}ENABLE AUTO-MERGE{{/if}}[{{autonomyMerge.configured}}]";

function makeConfig(): ExecutorConfig {
  return {
    model: "anthropic/operator-default",
    maxTurns: 3,
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none",
    buildAssets: "repo",
    buildAssetsDir: "/tmp/build-assets",
  };
}

function autonomyWith(onMerge: unknown): AutonomyConfig {
  return { ...defaultAutonomyConfig(), repos: ["acme/widgets"], stages: stages(onMerge) };
}

describe("the merge policy reaches the run's template context", () => {
  let builtIn: string;
  let db: StateDb;

  beforeEach(async () => {
    builtIn = tmp();
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "build.yaml"), BUILD_YAML);
    writeFileSync(join(builtIn, "workflows", "prompts", "pr.md"), PR_PROMPT);
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    db = await makeTestDb();
    mockExecuteAgent.mockResolvedValue({
      success: true,
      output: "done",
      error: undefined,
      turns: 1,
      durationMs: 1,
    });
    mockGetAutonomy.mockReturnValue(defaultAutonomyConfig());
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    vi.clearAllMocks();
  });

  async function runBuild(extra: Record<string, unknown>): Promise<string> {
    await runSimpleWorkflow(
      "build",
      { owner: "acme", repo: "widgets", issueNumber: 7, issueTitle: "Add a rate limiter", sender: "alice", extra },
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );
    return mockExecuteAgent.mock.calls[0]![0] as string;
  }

  it("renders the auto-merge instruction for an autonomous run under `on_merge: auto`", async () => {
    mockGetAutonomy.mockReturnValue(autonomyWith("auto"));
    expect(await runBuild(AUTONOMOUS)).toBe("ENABLE AUTO-MERGE[auto]");
  });

  it("says nothing about merging when the stage is `none`", async () => {
    mockGetAutonomy.mockReturnValue(autonomyWith("none"));
    expect(await runBuild(AUTONOMOUS)).toBe("[none]");
  });

  it("says nothing about merging for `auto-low-impact`, but records it", async () => {
    mockGetAutonomy.mockReturnValue(autonomyWith("auto-low-impact"));
    expect(await runBuild(AUTONOMOUS)).toBe("[auto-low-impact]");
  });

  it("says nothing about merging for a human `@bot build`, even under `on_merge: auto`", async () => {
    mockGetAutonomy.mockReturnValue(autonomyWith("auto"));
    expect(await runBuild({})).toBe("[none]");
  });
});
