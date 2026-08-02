/**
 * Per-attempt fix policy — the two dials 04-retry.md §4.4 and
 * 09-state-machine.md §S1 put between "this PR has failed before" and "what
 * this run actually does about it":
 *
 *  1. **Model escalation.** Above `fix.escalateModelAfterAttempt`, a configured
 *     `models["pr-fix-retry"]` replaces `models["pr-fix"]` for the run.
 *  2. **The flaky cap.** `flaky` short-circuits the `fix` phase — but only
 *     `fix.maxFlakyDeferrals` times in a row. The THIRD consecutive `flaky`
 *     verdict is promoted to `reproducible` and spends a normal attempt,
 *     because a job that reports flaky three times running is not flaky, it is
 *     an intermittent real failure.
 *
 * Both are read off the snapshot `renderContext` projects onto `request.extra`
 * at dispatch, so the pure halves are table tests and the wiring half drives the
 * REAL `pr-fix.yaml` through `runSimpleWorkflow` with only the agent faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { harvestFixMarkers } from "#src/engine/fix-harvest.js";
import { StateDb } from "#src/state/db.js";
import { getWorkflow } from "#src/workflows/loader.js";
import {
  escalateFixModel,
  promoteFlakyDiagnosis,
  runSimpleWorkflow,
  FLAKY_SKIP_IF_EXPRESSION,
  type RunRepoConfig,
} from "#src/workflows/simple.js";
import {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultReviewConfig,
  type FixConfig,
  type ModelConfig,
} from "#src/config/config.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockExecuteCommand = vi.mocked(executeCommand);

const OPERATOR = "anthropic/claude-sonnet-4-6";
const RETRY = "anthropic/claude-opus-4-8";

const fix = (over: Partial<FixConfig> = {}): FixConfig => ({ ...defaultFixConfig(), ...over });

// ---------------------------------------------------------------------------
// 04-retry.md §4.4 — model escalation
// ---------------------------------------------------------------------------

describe("escalateFixModel — the `pr-fix-retry` substitution", () => {
  const withRetry: ModelConfig = { default: OPERATOR, "pr-fix-retry": RETRY };

  // The argument is the length of `PrState.priorAttempts` — the JOURNAL, not
  // the attempt counter (03-retry-intervention.md, locked decision 10). An
  // empty journal is attempt 1. `attempt` re-arms to 1 on a retry and the
  // journal survives one, so keying on the counter downgraded the model on a PR
  // that had already failed three times, which is backwards.
  const journal = (attempts: number) => attempts - 1;

  it("does nothing at all when no `pr-fix-retry` key is configured", () => {
    // The load-bearing property: an operator who never heard of this feature
    // gets today's behaviour EXACTLY, at every attempt number.
    const models: ModelConfig = { default: OPERATOR, "pr-fix": "anthropic/pinned" };
    for (const attempt of [1, 2, 3, 99]) {
      expect(escalateFixModel("pr-fix", models, journal(attempt), fix())).toBe(models);
    }
  });

  it("substitutes only ABOVE the threshold", () => {
    // Packaged `escalateModelAfterAttempt: 1` ⇒ attempt 1 is unescalated.
    expect(escalateFixModel("pr-fix", withRetry, journal(1), fix())).toBe(withRetry);
    expect(escalateFixModel("pr-fix", withRetry, journal(2), fix())?.["pr-fix"]).toBe(RETRY);
    expect(escalateFixModel("pr-fix", withRetry, journal(3), fix())?.["pr-fix"]).toBe(RETRY);
  });

  it("accepts a threshold of 0 — escalate from the first attempt", () => {
    expect(
      escalateFixModel("pr-fix", withRetry, journal(1), fix({ escalateModelAfterAttempt: 0 }))?.["pr-fix"],
    ).toBe(RETRY);
  });

  it("stays escalated across a retry, which is the whole point", () => {
    // Locked decision 10. A retry re-arms `attempt` to 1 but CARRIES the
    // journal (plus a one-line seam), so a PR that has already failed three
    // times keeps the escalated model instead of silently dropping back to the
    // base one at the exact moment a human said "try harder".
    const afterThreeAttemptsAndARetry = 3 + 1; // three attempt lines + the seam
    expect(escalateFixModel("pr-fix", withRetry, afterThreeAttemptsAndARetry, fix())?.["pr-fix"])
      .toBe(RETRY);
  });

  it("applies to the whole fix family and nothing else", () => {
    expect(escalateFixModel("dependabot-ci-fix", withRetry, 3, fix())?.["pr-fix"]).toBe(RETRY);
    // A `pr-review` / `dependabot-pr-merge` dispatch carries a journal too (the
    // snapshot is resolved for every PR-scoped workflow), and must not record a
    // rewritten map it never reads.
    expect(escalateFixModel("pr-review", withRetry, 3, fix())).toBe(withRetry);
    expect(escalateFixModel("dependabot-pr-merge", withRetry, 3, fix())).toBe(withRetry);
  });

  it("treats a dispatch with no snapshot as the first attempt", () => {
    expect(escalateFixModel("pr-fix", withRetry, undefined, fix())).toBe(withRetry);
    expect(escalateFixModel("pr-fix", undefined, 5, fix())).toBeUndefined();
  });

  it("never mutates the map it was given", () => {
    const models: ModelConfig = { default: OPERATOR, "pr-fix": OPERATOR, "pr-fix-retry": RETRY };
    const out = escalateFixModel("pr-fix", models, journal(2), fix());
    expect(out).not.toBe(models);
    expect(models["pr-fix"]).toBe(OPERATOR);
    expect(out?.["pr-fix-retry"]).toBe(RETRY);
  });

  it("composes with a per-repo `models` override for free (issue #180)", () => {
    // The map handed in is already `base ⊕ repo`, so both directions work with
    // no extra code: a repo that pinned its own `pr-fix` still escalates to the
    // operator's retry model…
    const repoPinnedFix: ModelConfig = { default: OPERATOR, "pr-fix": "openai/gpt-5-repo", "pr-fix-retry": RETRY };
    expect(escalateFixModel("pr-fix", repoPinnedFix, journal(2), fix())?.["pr-fix"]).toBe(RETRY);
    // …and a repo that pinned its own retry model escalates to THAT.
    const repoPinnedRetry: ModelConfig = { default: OPERATOR, "pr-fix-retry": "openai/gpt-5-repo-retry" };
    expect(escalateFixModel("pr-fix", repoPinnedRetry, journal(2), fix())?.["pr-fix"])
      .toBe("openai/gpt-5-repo-retry");
  });
});

// ---------------------------------------------------------------------------
// 09-state-machine.md §S1 — the bounded `flaky` deferral
// ---------------------------------------------------------------------------

describe("promoteFlakyDiagnosis — the flaky deferral cap", () => {
  const prFix = () => getWorkflow("pr-fix");
  const fixPhase = (d: ReturnType<typeof prFix>) => d.phases.find((p) => p.name === "fix")!;

  it("matches the expression the packaged workflows actually declare", () => {
    for (const name of ["pr-fix", "dependabot-ci-fix"]) {
      const exprs = fixPhase(getWorkflow(name)).skip_if as string[];
      expect(exprs).toContain(FLAKY_SKIP_IF_EXPRESSION);
    }
  });

  it("leaves the guard untouched below the cap", () => {
    // `flakyDeferrals` counts PRIOR runs: 0 is the first `flaky` verdict, 1 the
    // second. Both still defer.
    for (const deferrals of [undefined, 0, 1]) {
      expect(promoteFlakyDiagnosis(prFix(), deferrals, fix())).toBe(prFix());
    }
  });

  it("drops ONLY the flaky row on the third consecutive verdict", () => {
    for (const name of ["pr-fix", "dependabot-ci-fix"]) {
      const promoted = promoteFlakyDiagnosis(getWorkflow(name), 2, fix());
      expect(fixPhase(promoted).skip_if).toEqual([
        "scratch.fixMarkers.diagnosis.class == 'infra-dependent'",
        "scratch.fixMarkers.diagnosis.class == 'upstream-broken'",
      ]);
    }
  });

  it("honours a repo that clamped `maxFlakyDeferrals` down", () => {
    // The clamp is `min(repo, operator)`, so a repo can only ever promote
    // EARLIER — never defer for longer than the operator allows.
    expect(fixPhase(promoteFlakyDiagnosis(prFix(), 0, fix({ maxFlakyDeferrals: 0 }))).skip_if)
      .toHaveLength(2);
    expect(fixPhase(promoteFlakyDiagnosis(prFix(), 0, fix({ maxFlakyDeferrals: 1 }))).skip_if)
      .toHaveLength(3);
    expect(fixPhase(promoteFlakyDiagnosis(prFix(), 1, fix({ maxFlakyDeferrals: 1 }))).skip_if)
      .toHaveLength(2);
  });

  it("never mutates the loader's cached definition", () => {
    // `getWorkflow` hands back a process-global cache entry: mutating it would
    // promote every subsequent run of every PR in the process.
    promoteFlakyDiagnosis(prFix(), 5, fix());
    expect(fixPhase(prFix()).skip_if).toHaveLength(3);
  });

  it("is inert for a workflow with no flaky guard", () => {
    const review = getWorkflow("pr-review");
    expect(promoteFlakyDiagnosis(review, 99, fix())).toBe(review);
  });
});

// ---------------------------------------------------------------------------
// The wiring — the real pr-fix.yaml, driven end to end
// ---------------------------------------------------------------------------

function makeConfig(): ExecutorConfig {
  return {
    model: OPERATOR,
    maxTurns: 3,
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none",
    buildAssets: "repo",
    buildAssetsDir: "/tmp/build-assets",
  };
}

const DIAGNOSIS = (cls: string) =>
  `DIAGNOSIS_COMPLETE: pr=7 attempt=1 class=${cls} cause=x ci_vs_local=none unreproducible=`;

/** A `RunRepoConfig` as `resolveRepoRunConfig` would have produced it. */
function runRepoConfig(models: ModelConfig): RunRepoConfig {
  return {
    repo: "acme/widgets",
    defaultBranch: "main",
    treeSha: "deadbeefcafe",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    assets: [],
    models,
    variants: {},
    approval: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    fix: defaultFixConfig(),
    dependencies: defaultDependenciesConfig(),
    review: defaultReviewConfig(),
    sources: {
      models: { default: "default" },
      variants: {},
      disabled: {
        workflows: "default",
        crons: "default",
        prompts: "default",
        skills: "default",
        agentContext: "default",
      },
      approval: {},
      fix: {},
      dependencies: {},
      review: {},
    },
    warnings: [],
  };
}

describe("pr-fix — the per-attempt policy reaches a real run", () => {
  let db: StateDb;
  let runId = "";
  let prNumber = 0;

  beforeEach(() => {
    db = new StateDb(":memory:");
    runId = "";
    prNumber += 1;
    // Phase 1 is `diagnose`; every later agent call is the `fix` phase (its
    // gate loop's `until_bash` goes through executeCommand instead).
    mockExecuteCommand.mockResolvedValue({ success: true, output: "", turns: 0, durationMs: 1 });
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  /** Drive the packaged `pr-fix` workflow with a scripted diagnosis. */
  async function run(cls: string, extra: Record<string, unknown>, models?: ModelConfig, repoConfig?: RunRepoConfig) {
    mockExecuteAgent
      .mockResolvedValueOnce({ success: true, output: DIAGNOSIS(cls), turns: 1, durationMs: 1 })
      .mockResolvedValue({
        success: true,
        output: "CI_FIX_COMPLETE: pr=7 outcome=pushed gate=green",
        turns: 1,
        durationMs: 1,
      });

    const result = await runSimpleWorkflow(
      "pr-fix",
      {
        owner: "acme",
        repo: "widgets",
        prNumber,
        sender: "alice",
        extra,
        ...(repoConfig ? { repoConfig } : {}),
      },
      makeConfig(),
      {
        onRunStart: async (id: string) => { runId = id; },
        // The REAL harvest, wired exactly as `src/index.ts` wires it. The
        // `fix` phase's `skip_if` reads `scratch.fixMarkers.diagnosis.class`,
        // so a test that omitted this would drive a workflow whose guard can
        // never match — and would have gone green while asserting nothing.
        onPhaseEnd: async (phase, phaseResult) => {
          harvestFixMarkers(db, runId, "pr-fix", phase, phaseResult.output ?? "");
        },
      },
      db,
      models ?? { default: OPERATOR },
      {},
      "lastlight:bootstrap",
      {},
    );
    return { result, run: db.runs.getRun(runId) };
  }

  /** Did the expensive `fix` phase actually run? */
  const fixRan = () => mockExecuteAgent.mock.calls.length > 1;
  const fixModel = () => mockExecuteAgent.mock.calls[1]?.[1]?.model;

  it("defers the first two `flaky` verdicts and ATTEMPTS the third", async () => {
    // The sequence 09 §S1 names: flaky → flaky → flaky. `flakyDeferrals` counts
    // prior runs, so the third consecutive diagnosis arrives with 2 and is
    // promoted to `reproducible` — an unbounded series of free full runs on one
    // flaky test is exactly what the cap exists to stop, and three flaky
    // reports running is an intermittent REAL failure.
    const { result: r1 } = await run("flaky", { attempt: 1, flakyDeferrals: 0 });
    expect(r1.success).toBe(true);
    expect(fixRan()).toBe(false);

    vi.clearAllMocks();
    mockExecuteCommand.mockResolvedValue({ success: true, output: "", turns: 0, durationMs: 1 });
    const { result: r2 } = await run("flaky", { attempt: 1, flakyDeferrals: 1 });
    expect(r2.success).toBe(true);
    expect(fixRan()).toBe(false);

    vi.clearAllMocks();
    mockExecuteCommand.mockResolvedValue({ success: true, output: "", turns: 0, durationMs: 1 });
    const { result: r3 } = await run("flaky", { attempt: 1, flakyDeferrals: 2 });
    expect(r3.success).toBe(true);
    expect(fixRan()).toBe(true);
  });

  it.each(["infra-dependent", "upstream-broken"])(
    "keeps skipping on class=%s however many flaky deferrals have accrued",
    async (cls) => {
      // The cap is a fact about `flaky` only. These two classes are not "we
      // gave up counting", they are "there is nothing here a fix phase can do".
      const { result } = await run(cls, { attempt: 1, flakyDeferrals: 9 });
      expect(result.success).toBe(true);
      expect(fixRan()).toBe(false);
    },
  );

  it("runs the fix phase on a fixable class regardless of the counters", async () => {
    const { result } = await run("reproducible", { attempt: 1, flakyDeferrals: 0 });
    expect(result.success).toBe(true);
    expect(fixRan()).toBe(true);
  });

  it("escalates the fix phase's model above the threshold, and records it", async () => {
    // The journal is what the substitution reads (locked decision 10), so the
    // dispatch context has to carry it — `renderContext` projects both.
    const { run: row } = await run(
      "reproducible",
      { attempt: 2, priorAttempts: ["attempt 1: class=reproducible cause=stale lockfile"], flakyDeferrals: 0 },
      { default: OPERATOR, "pr-fix-retry": RETRY },
    );
    expect(fixModel()).toBe(RETRY);
    // Persisted on the run context, which is what the admin panel renders — so
    // an operator can see which model the attempt actually used.
    expect((row?.context?.models as ModelConfig | undefined)?.["pr-fix"]).toBe(RETRY);
  });

  it("leaves attempt 1 on the operator's model", async () => {
    const { run: row } = await run(
      "reproducible",
      { attempt: 1, priorAttempts: [], flakyDeferrals: 0 },
      { default: OPERATOR, "pr-fix-retry": RETRY },
    );
    expect(fixModel()).toBe(OPERATOR);
    expect((row?.context?.models as ModelConfig | undefined)?.["pr-fix"]).toBeUndefined();
  });

  it("uses the operator's model at every attempt when no retry model is set", async () => {
    await run(
      "reproducible",
      { attempt: 3, priorAttempts: ["attempt 1: x", "attempt 2: y"], flakyDeferrals: 0 },
      { default: OPERATOR },
    );
    expect(fixModel()).toBe(OPERATOR);
  });

  it("composes with a per-repo `models` override", async () => {
    // `repoConfig.models` is the already-merged `base ⊕ repo` map, so a repo
    // that pinned its own retry model escalates to that one.
    const { run: row } = await run(
      "reproducible",
      { attempt: 2, priorAttempts: ["attempt 1: class=reproducible cause=stale lockfile"], flakyDeferrals: 0 },
      { default: OPERATOR, "pr-fix-retry": RETRY },
      runRepoConfig({ default: OPERATOR, "pr-fix": "openai/gpt-5-repo", "pr-fix-retry": "openai/gpt-5-repo-retry" }),
    );
    expect(fixModel()).toBe("openai/gpt-5-repo-retry");
    expect((row?.context?.models as ModelConfig | undefined)?.["pr-fix"]).toBe("openai/gpt-5-repo-retry");
  });
});
