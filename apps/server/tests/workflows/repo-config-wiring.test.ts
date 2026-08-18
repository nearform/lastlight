/**
 * Wiring tests for the per-repository config layer (issue #180).
 *
 * `repo-config.test.ts` covers the module in isolation (bounds, sanitizers,
 * merge) and `asset-resolver.test.ts` covers the per-run resolver. THIS file
 * covers the seam between them and a real run: does a repo's `.lastlight/`
 * actually change the model a phase runs on, the prompt it renders, and the
 * approval gates it pauses at — and does it stay pinned to the right run when
 * two repos are in flight at once.
 *
 * Everything below drives the real `runSimpleWorkflow` → `runWorkflow` →
 * engine path with only the agent executor faked, because the interesting
 * failure mode (a repo layer leaking across concurrent runs) lives precisely in
 * the wiring these tests exercise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Fake the agent so no real model call happens; every assertion below reads the
// (prompt, config.model) pairs it was handed.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

import { executeAgent } from "#src/engine/agent-executor.js";
import { StateDb } from "#src/state/db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { runWorkflow } from "#src/workflows/runner.js";
import {
  repoConfigRunRecord,
  resolveRepoRunConfig,
  runSimpleWorkflow,
  soleRepoInContext,
  type RunRepoConfig,
} from "#src/workflows/simple.js";
import { resetRepoConfigForTests, type RepoConfigBase } from "#src/config/repo-config.js";
import {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultNotificationsConfig,
  defaultReviewConfig,
} from "#src/config/config.js";
import type { GitHubClient, RepoConfigTreeResult } from "#src/engine/github/github.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);

// ── Fixtures ────────────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-repo-config-"));
}

/** Write `<root>/workflows/prompts/<name>` — the shape every asset layer mirrors. */
function writePrompt(root: string, name: string, body: string): void {
  mkdirSync(join(root, "workflows", "prompts"), { recursive: true });
  writeFileSync(join(root, "workflows", "prompts", name), body);
}

function writeWorkflow(root: string, name: string, yaml: string): void {
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "workflows", `${name}.yaml`), yaml);
}

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), body);
}

/** A one-phase workflow whose model comes from `{{models.pr-review}}`. */
const REVIEW_YAML = `
kind: agent
name: pr-review
phases:
  - name: pr-review
    label: Review
    prompt: prompts/review.md
    model: "{{models.pr-review}}"
`;

/** Same, with a gate the operator leaves OFF by default. */
const GATED_YAML = `
kind: agent
name: pr-review
phases:
  - name: pr-review
    label: Review
    prompt: prompts/review.md
    approval_gate: post_review
    approval_gate_message: "Approve?"
`;

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

function agentOk(output = "done") {
  return { success: true, output, error: undefined, turns: 1, durationMs: 1 };
}

/**
 * A `RunRepoConfig` as `resolveRepoRunConfig` would have produced it — built by
 * hand here so the run-level tests don't need a GitHub round-trip. The
 * fetch/merge half is exercised end-to-end further down.
 */
function runRepoConfig(overrides: Partial<RunRepoConfig> & { repo: string }): RunRepoConfig {
  return {
    defaultBranch: "main",
    treeSha: "deadbeefcafe",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    assets: [],
    models: { default: "anthropic/operator-default" },
    variants: {},
    approval: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    fix: defaultFixConfig(),
    dependencies: defaultDependenciesConfig(),
    review: defaultReviewConfig(),
    notifications: defaultNotificationsConfig(),
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
      notifications: {},
    },
    warnings: [],
    ...overrides,
  };
}

/** The boot config a repo layer merges onto. */
function baseConfig(): RepoConfigBase {
  return {
    value: {
      models: { default: "anthropic/operator-default" },
      variants: {},
      disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
      approval: { post_review: false },
      // The policy blocks a repo layer is clamped against, exactly as
      // `repoConfigBaseFromRuntime` projects them.
      fix: { ...defaultFixConfig() },
      dependencies: { ...defaultDependenciesConfig() },
      review: { ...defaultReviewConfig() },
    },
    sources: {
      models: { default: "default" },
      variants: {},
      disabled: { workflows: "default", crons: "default" },
      approval: { post_review: "default" },
      fix: { maxAttempts: "default" },
      dependencies: { autoMergeMaxImpact: "default" },
      review: { trigger: "default" },
    },
  };
}

/** A GitHub client that serves one canned `.lastlight/` tree (or throws). */
function fakeClient(
  handler: () => Promise<RepoConfigTreeResult> | RepoConfigTreeResult,
): GitHubClient {
  return { fetchRepoConfigTree: vi.fn(handler) } as unknown as GitHubClient;
}

function treeOf(files: Record<string, string>, treeSha = "sha-1"): RepoConfigTreeResult {
  return {
    status: "ok",
    defaultBranch: "main",
    treeSha,
    files: Object.entries(files).map(([path, body]) => ({
      path,
      mode: "100644",
      size: Buffer.byteLength(body),
      content: Buffer.from(body),
    })),
    truncated: false,
  };
}

/**
 * Callbacks that capture the workflow-run id. `getByTrigger` deliberately hides
 * finished rows, so a completed run can only be re-read by id.
 */
function capturingCallbacks(): { callbacks: { onRunStart: (id: string) => Promise<void> }; runId: () => string } {
  let id = "";
  return {
    callbacks: {
      onRunStart: async (runId: string) => {
        id = runId;
      },
    },
    runId: () => id,
  };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
    issueTitle: "Add a rate limiter",
    sender: "alice",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("per-repo config — effective config reaches a run (issue #180)", () => {
  let builtIn: string;
  let db: StateDb;

  beforeEach(() => {
    builtIn = tmp();
    writeWorkflow(builtIn, "pr-review", REVIEW_YAML);
    writePrompt(builtIn, "review.md", "BUILT-IN REVIEW PROMPT");
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    db = new StateDb(":memory:");
    mockExecuteAgent.mockResolvedValue(agentOk());
  });

  afterEach(() => {
    db.close();
    configureWorkflowAssets();
    clearWorkflowCache();
    vi.clearAllMocks();
  });

  it("routes the phase to the repo's models.pr-review override", async () => {
    const result = await runSimpleWorkflow(
      "pr-review",
      baseRequest({
        repoConfig: runRepoConfig({
          repo: "acme/widgets",
          models: { default: "anthropic/operator-default", "pr-review": "openai/gpt-5-repo" },
          sources: {
            ...runRepoConfig({ repo: "acme/widgets" }).sources,
            models: { default: "default", "pr-review": "repo" },
          },
        }),
      }),
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledOnce();
    expect(mockExecuteAgent.mock.calls[0]![1].model).toBe("openai/gpt-5-repo");
  });

  it("persists the applied repo config, its warnings and its treeSha on the run row", async () => {
    const repoConfig = runRepoConfig({
      repo: "acme/widgets",
      treeSha: "abc1234def",
      models: { default: "anthropic/operator-default", "pr-review": "openai/gpt-5-repo" },
      variants: { "pr-review": "high" },
      approval: { post_review: true },
      assets: ["workflows/prompts/review.md"],
      sources: {
        models: { default: "default", "pr-review": "repo" },
        variants: { "pr-review": "repo" },
        disabled: {
          workflows: "default",
          crons: "default",
          prompts: "default",
          skills: "default",
          agentContext: "default",
        },
        approval: { post_review: "repo" },
        fix: {},
        dependencies: {},
        review: {},
        notifications: {},
      },
      warnings: [
        { code: "key-not-allowed", repo: "acme/widgets", path: "sandbox", message: "Ignored \"sandbox\"." },
      ],
    });

    const { callbacks, runId } = capturingCallbacks();
    await runSimpleWorkflow(
      "pr-review",
      baseRequest({ repoConfig }),
      makeConfig(),
      callbacks,
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );

    const run = db.runs.getRun(runId());
    const stored = run?.context?.repoConfig as ReturnType<typeof repoConfigRunRecord>;
    expect(stored.repo).toBe("acme/widgets");
    expect(stored.treeSha).toBe("abc1234def");
    expect(stored.defaultBranch).toBe("main");
    // `applied` holds only the leaves the repo actually won…
    expect(stored.applied.models).toEqual({ "pr-review": "openai/gpt-5-repo" });
    expect(stored.applied.variants).toEqual({ "pr-review": "high" });
    expect(stored.applied.approval).toEqual({ post_review: true });
    expect(stored.applied.disabled).toBeUndefined();
    expect(stored.assets).toEqual(["workflows/prompts/review.md"]);
    expect(stored.warnings).toHaveLength(1);
    // …while the full EFFECTIVE maps stay on the usual context keys.
    expect(run?.context?.models).toEqual({
      default: "anthropic/operator-default",
      "pr-review": "openai/gpt-5-repo",
    });
  });

  it("renders and persists the repo's clamped fix/dependencies policy (issues #251, #252)", async () => {
    // The blocks are inert config for now, so the assertion is the plumbing:
    // does a repo's clamped value reach the template context a prompt renders
    // from, and the run row anyone later asks "under which budget did this
    // run?" — not what any phase does with it.
    writePrompt(
      builtIn,
      "review.md",
      // `{{review.*}}` deliberately resolves to NOTHING from the policy block:
      // `build.yaml`'s reviewer loop owns that name via `output_var: review`
      // (read by prompts/pr.md as `{{review.approved}}`), so seeding the review
      // policy onto ctx would shadow it. Pinned here because the failure is
      // silent — a shadowed `{{#if !review.approved}}` renders the wrong branch.
      "attempts={{fix.maxAttempts}} impact={{dependencies.autoMergeMaxImpact}} trigger=[{{review.trigger}}]",
    );
    clearWorkflowCache();

    const repoConfig = runRepoConfig({
      repo: "acme/widgets",
      // As `resolveRepoConfig` would have produced it: the repo tightened
      // maxAttempts to 1 and its bid for `high` was clamped back to the
      // operator's `medium`.
      fix: { ...defaultFixConfig(), maxAttempts: 1 },
      dependencies: defaultDependenciesConfig(),
      sources: {
        ...runRepoConfig({ repo: "acme/widgets" }).sources,
        fix: { maxAttempts: "repo" },
      },
    });

    const { callbacks, runId } = capturingCallbacks();
    await runSimpleWorkflow(
      "pr-review",
      baseRequest({ repoConfig }),
      makeConfig(),
      callbacks,
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );

    expect(mockExecuteAgent.mock.calls[0]![0]).toBe("attempts=1 impact=medium trigger=[]");

    const stored = db.runs.getRun(runId())?.context?.repoConfig as ReturnType<typeof repoConfigRunRecord>;
    // Only the leaf the repo actually won is recorded…
    expect(stored.applied.fix).toEqual({ maxAttempts: 1 });
    // …and a block it won nothing in contributes nothing at all.
    expect(stored.applied.dependencies).toBeUndefined();
  });

  it("falls back to the operator's policy blocks when no repo layer applies", async () => {
    writePrompt(builtIn, "review.md", "attempts={{fix.maxAttempts}} impact={{dependencies.autoMergeMaxImpact}}");
    clearWorkflowCache();

    await runSimpleWorkflow(
      "pr-review",
      baseRequest(),
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );

    // No boot config is loaded in this suite, so the shipped defaults answer —
    // the same values `config/default.yaml` documents.
    expect(mockExecuteAgent.mock.calls[0]![0]).toBe(
      `attempts=${defaultFixConfig().maxAttempts} impact=${defaultDependenciesConfig().autoMergeMaxImpact}`,
    );
  });

  it("pauses on an approval gate the repo raised but the operator left off", async () => {
    writeWorkflow(builtIn, "pr-review", GATED_YAML);
    clearWorkflowCache();

    const result = await runSimpleWorkflow(
      "pr-review",
      baseRequest({
        repoConfig: runRepoConfig({
          repo: "acme/widgets",
          approval: { post_review: true },
          sources: {
            ...runRepoConfig({ repo: "acme/widgets" }).sources,
            approval: { post_review: "repo" },
          },
        }),
      }),
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      // The operator's own gate map says NO gate — the repo added it.
      {},
      "lastlight:bootstrap",
      {},
    );

    expect(result.paused).toBe(true);
    const run = db.runs.getByTrigger("acme/widgets#7");
    expect(run?.status).toBe("paused");
  });

  it("stages the repo's skill directory instead of the built-in one of the same name", async () => {
    // Skills travel to every backend as HOST paths (docker copies them, k8s
    // tars them, in-process symlinks them), so a repo-cache dir needs no
    // per-backend plumbing — this asserts the path the port hands over.
    const repoRoot = tmp();
    writeSkill(builtIn, "reviewhelper", "BUILT-IN SKILL");
    writeSkill(repoRoot, "reviewhelper", "REPO SKILL");
    writeWorkflow(
      builtIn,
      "pr-review",
      `${REVIEW_YAML}    skill: reviewhelper\n`,
    );
    clearWorkflowCache();

    await runSimpleWorkflow(
      "pr-review",
      baseRequest({
        repoConfig: runRepoConfig({
          repo: "acme/widgets",
          assetRoot: repoRoot,
          assets: ["skills/reviewhelper/SKILL.md"],
        }),
      }),
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );

    expect(mockExecuteAgent.mock.calls[0]![1].skillPaths).toEqual([
      join(repoRoot, "skills", "reviewhelper"),
    ]);
  });

  it("behaves identically to today when no repo layer applies", async () => {
    // The frozen `lastlight/evals` arity — the repo-layer parameter is
    // defaulted precisely so this number doesn't move.
    expect(runWorkflow.length).toBe(9);

    const { callbacks, runId } = capturingCallbacks();
    const result = await runSimpleWorkflow(
      "pr-review",
      baseRequest(),
      makeConfig(),
      callbacks,
      db,
      { default: "anthropic/operator-default", "pr-review": "anthropic/operator-review" },
      {},
      "lastlight:bootstrap",
      {},
    );

    expect(result.success).toBe(true);
    const [prompt, cfg] = mockExecuteAgent.mock.calls[0]!;
    expect(prompt).toBe("BUILT-IN REVIEW PROMPT");
    expect(cfg.model).toBe("anthropic/operator-review");
    const run = db.runs.getRun(runId());
    expect(run).not.toBeNull();
    expect(run?.context?.repoConfig).toBeUndefined();
    expect(run?.scratch?.repoConfig).toBeUndefined();
  });
});

describe("per-repo config — concurrent runs stay pinned to their own repo", () => {
  let builtIn: string;
  let repoA: string;
  let repoB: string;
  let db: StateDb;

  beforeEach(() => {
    builtIn = tmp();
    repoA = tmp();
    repoB = tmp();
    writeWorkflow(builtIn, "pr-review", REVIEW_YAML);
    writePrompt(builtIn, "review.md", "BUILT-IN REVIEW PROMPT");
    writePrompt(repoA, "review.md", "REPO A REVIEW PROMPT");
    writePrompt(repoB, "review.md", "REPO B REVIEW PROMPT");
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    db = new StateDb(":memory:");
  });

  afterEach(() => {
    db.close();
    configureWorkflowAssets();
    clearWorkflowCache();
    vi.clearAllMocks();
  });

  /**
   * The regression the whole per-run-resolver refactor exists to prevent: two
   * workflows genuinely overlapping in time (both agents in flight before
   * either returns), each with its own prompt AND model override. A resolver
   * installed into the module globals would hand the second run's prompt to
   * the first.
   */
  it("resolves each run's own prompt and model with both agents in flight", async () => {
    const seen: Array<{ prompt: string; model?: string }> = [];
    let release!: () => void;
    const bothArrived = new Promise<void>((r) => {
      release = r;
    });
    mockExecuteAgent.mockImplementation(async (prompt: string, cfg: ExecutorConfig) => {
      seen.push({ prompt, model: cfg.model });
      // Hold every agent call open until BOTH runs have reached this point, so
      // the two resolvers provably coexist rather than running back to back.
      if (seen.length === 2) release();
      await bothArrived;
      return agentOk();
    });

    const runFor = (repo: string, assetRoot: string, model: string, prNumber: number) =>
      runSimpleWorkflow(
        "pr-review",
        baseRequest({
          repo,
          prNumber,
          repoConfig: runRepoConfig({
            repo: `acme/${repo}`,
            assetRoot,
            assets: ["workflows/prompts/review.md"],
            models: { default: "anthropic/operator-default", "pr-review": model },
            sources: {
              ...runRepoConfig({ repo: `acme/${repo}` }).sources,
              models: { default: "default", "pr-review": "repo" },
            },
          }),
        }),
        makeConfig(),
        {},
        db,
        { default: "anthropic/operator-default" },
        {},
        "lastlight:bootstrap",
        {},
      );

    const [a, b] = await Promise.all([
      runFor("alpha", repoA, "openai/model-a", 1),
      runFor("beta", repoB, "openai/model-b", 2),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(seen).toHaveLength(2);
    // Each pairing must be internally consistent — A's prompt with A's model.
    expect(seen).toEqual(
      expect.arrayContaining([
        { prompt: "REPO A REVIEW PROMPT", model: "openai/model-a" },
        { prompt: "REPO B REVIEW PROMPT", model: "openai/model-b" },
      ]),
    );
    // …and the module-level facade is untouched: a third, layer-less run still
    // sees the built-in prompt.
    mockExecuteAgent.mockResolvedValue(agentOk());
    await runSimpleWorkflow(
      "pr-review",
      baseRequest({ repo: "gamma", prNumber: 3 }),
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );
    expect(mockExecuteAgent.mock.calls[2]![0]).toBe("BUILT-IN REVIEW PROMPT");
  });
});

describe("resolveRepoRunConfig — the dispatch choke point", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = tmp();
    resetRepoConfigForTests();
  });

  afterEach(() => {
    resetRepoConfigForTests();
    vi.clearAllMocks();
  });

  const resolve = (workflow: string, context: Record<string, unknown>, client?: GitHubClient | null) =>
    resolveRepoRunConfig(workflow, context, { client, base: baseConfig(), cacheRoot });

  it("refuses a workflow the repo disabled in its own .lastlight/", async () => {
    const client = fakeClient(() =>
      treeOf({ "lastlight.yml": "disabled:\n  workflows: [pr-review]\n" }),
    );
    const result = await resolve("pr-review", { repo: "acme/widgets" }, client);

    expect(result.repoConfig).toBeUndefined();
    expect(result.refusal).toContain("acme/widgets");
    expect(result.refusal).toContain("pr-review");
  });

  it("still dispatches a workflow the repo did NOT disable", async () => {
    const client = fakeClient(() =>
      treeOf({ "lastlight.yml": "disabled:\n  workflows: [build]\nmodels:\n  pr-review: openai/gpt-5\n" }),
    );
    const result = await resolve("pr-review", { repo: "acme/widgets" }, client);

    expect(result.refusal).toBeUndefined();
    expect(result.repoConfig?.models["pr-review"]).toBe("openai/gpt-5");
    expect(result.repoConfig?.sources.models["pr-review"]).toBe("repo");
  });

  it("clamps a repo's fix/dependencies block at the choke point, end to end", async () => {
    const client = fakeClient(() =>
      treeOf({
        "lastlight.yml":
          "fix:\n  maxAttempts: 1\n  gateTimeoutSeconds: 60\n" +
          "dependencies:\n  autoMergeMaxImpact: high\n  auditComment: false\n",
      }),
    );
    const result = await resolve("pr-review", { repo: "acme/widgets" }, client);

    expect(result.refusal).toBeUndefined();
    // Tightened: kept, and attributed to the repo.
    expect(result.repoConfig?.fix.maxAttempts).toBe(1);
    expect(result.repoConfig?.sources.fix.maxAttempts).toBe("repo");
    // Loosened: clamped back to the operator's tier.
    expect(result.repoConfig?.dependencies.autoMergeMaxImpact).toBe("medium");
    // Operator-only: refused even though 60 < 900.
    expect(result.repoConfig?.fix.gateTimeoutSeconds).toBe(defaultFixConfig().gateTimeoutSeconds);
    // Add-only key: a repo may ask for the auto-merge audit record, never
    // silence one the operator requires — it is the audit OF that repo.
    expect(result.repoConfig?.dependencies.auditComment).toBe(true);
    expect(result.repoConfig?.warnings.map((w) => w.code).sort()).toEqual([
      "key-not-allowed",
      "policy-downgrade",
      "policy-downgrade",
    ]);
  });

  it("degrades to the operator config when the fetch fails, rather than failing the run", async () => {
    const client = fakeClient(() => {
      throw new Error("502 Bad Gateway");
    });
    const result = await resolve("pr-review", { repo: "acme/widgets" }, client);

    expect(result).toEqual({});
  });

  it("keeps a repo's malformed lastlight.yml from failing the run", async () => {
    const client = fakeClient(() => treeOf({ "lastlight.yml": "models: [not, a, mapping]\n" }));
    const result = await resolve("pr-review", { repo: "acme/widgets" }, client);

    expect(result.refusal).toBeUndefined();
    // The bad key is dropped with a warning; everything else still resolves.
    expect(result.repoConfig?.models).toEqual({ default: "anthropic/operator-default" });
    expect(result.repoConfig?.warnings.map((w) => w.code)).toContain("invalid-value");
  });

  it("carries the layer's asset root only when the repo actually shipped assets", async () => {
    const withAssets = fakeClient(() =>
      treeOf({
        "lastlight.yml": "models:\n  pr-review: openai/gpt-5\n",
        "workflows/prompts/review.md": "REPO PROMPT",
      }),
    );
    const a = await resolve("pr-review", { repo: "acme/widgets" }, withAssets);
    expect(a.repoConfig?.assetRoot).toBeTruthy();
    expect(a.repoConfig?.assets).toEqual(["workflows/prompts/review.md"]);

    resetRepoConfigForTests();
    const configOnly = fakeClient(() => treeOf({ "lastlight.yml": "models:\n  pr-review: openai/gpt-5\n" }));
    const b = await resolve("pr-review", { repo: "acme/other" }, configOnly);
    expect(b.repoConfig?.assetRoot).toBeUndefined();
  });

  it("skips without a fetch when the feature is off, chat-only, or the repo is ambiguous", async () => {
    const client = fakeClient(() => treeOf({ "lastlight.yml": "models:\n  pr-review: openai/gpt-5\n" }));
    const calls = () => vi.mocked(client.fetchRepoConfigTree).mock.calls.length;

    // Master switch off.
    expect(
      await resolveRepoRunConfig(
        "pr-review",
        { repo: "acme/widgets" },
        { client, base: baseConfig(), cacheRoot, policy: { enabled: false, allowKeys: [], allowedModels: null, allowAssets: true } },
      ),
    ).toEqual({});
    // Chat-only: no GitHub auth at all.
    expect(await resolve("pr-review", { repo: "acme/widgets" }, null)).toEqual({});
    // Repo-less (a Slack explore) and multi-repo (an unsplit cron fan-out).
    expect(await resolve("explore", {}, client)).toEqual({});
    expect(await resolve("issue-triage", { repos: ["acme/a", "acme/b"] }, client)).toEqual({});
    expect(calls()).toBe(0);
  });

  it("identifies the single repo a context names", () => {
    expect(soleRepoInContext({ repo: "acme/widgets" })).toBe("acme/widgets");
    // The same repo named twice is still one repo.
    expect(soleRepoInContext({ repo: "acme/widgets", repos: ["acme/widgets"] })).toBe("acme/widgets");
    expect(soleRepoInContext({ repos: ["acme/a", "acme/b"] })).toBeUndefined();
    expect(soleRepoInContext({})).toBeUndefined();
  });
});
