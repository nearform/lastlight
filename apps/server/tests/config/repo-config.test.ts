import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  fetchRepoLayer,
  getCachedRepoLayer,
  invalidateRepoLayer,
  listRepoLayerAssets,
  parseRepoConfigYaml,
  refreshRepoLayer,
  repoConfigBaseFromRuntime,
  repoConfigPolicy,
  repoLayerPathKind,
  resetRepoConfigForTests,
  resolveRepoConfig,
  sanitizeRepoConfigLayer,
  sanitizeRepoFiles,
  REPO_CONFIG_MAX_BYTES,
  REPO_CONFIG_MAX_FILES,
  type RepoConfigBase,
  type RepoLayer,
} from "#src/config/repo-config.js";
import { resolveConfigLayers, resolveWithExtraLayer } from "#src/config/config-resolve.js";
import {
  loadConfig,
  resetRuntimeConfigForTests,
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultReviewConfig,
  DEFAULT_REPO_CONFIG_ALLOW_KEYS,
} from "#src/config/config.js";
import type { RepoConfigPolicy } from "#src/config/config.js";
import type { GitHubClient, RepoConfigFile, RepoConfigTreeResult } from "#src/engine/github/github.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY: RepoConfigPolicy = {
  enabled: true,
  allowKeys: ["models", "variants", "disabled.workflows", "disabled.crons", "approval"],
  allowedModels: null,
  allowAssets: true,
};

function policy(overrides: Partial<RepoConfigPolicy> = {}): RepoConfigPolicy {
  return { ...POLICY, ...overrides };
}

/** A boot-resolved base with everything attributed to "default" unless stated. */
function base(overrides: Partial<Record<string, unknown>> = {}, sources: Record<string, unknown> = {}): RepoConfigBase {
  return {
    value: {
      models: { default: "anthropic/claude-sonnet-4-6" },
      variants: {},
      disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
      approval: {},
      ...overrides,
    },
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
      ...sources,
    },
  };
}

function layerWith(config: Record<string, unknown> | undefined): RepoLayer {
  return {
    repo: "acme/widget",
    defaultBranch: "trunk",
    treeSha: "tree-1",
    fetchedAt: new Date().toISOString(),
    root: "/tmp/none",
    config,
    assets: [],
    warnings: [],
  };
}

function file(path: string, content = "x", mode = "100644"): RepoConfigFile {
  const buf = Buffer.from(content);
  return { path, mode, size: buf.length, content: buf };
}

function codes(warnings: Array<{ code: string }>): string[] {
  return warnings.map((w) => w.code);
}

// ---------------------------------------------------------------------------
// Operator bounds in config/default.yaml
// ---------------------------------------------------------------------------

describe("loadConfig — repoConfig bounds", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("normalizes the shipped default.yaml block into an inert policy", () => {
    const config = loadConfig();
    expect(config.repoConfig).toEqual({
      enabled: true,
      allowKeys: [...DEFAULT_REPO_CONFIG_ALLOW_KEYS],
      allowedModels: null,
      allowAssets: true,
    });
  });

  it("surfaces the block in the public config bundle", () => {
    const config = loadConfig();
    expect(config.publicConfig.merged.repoConfig).toMatchObject({ enabled: true, allowAssets: true });
    expect((config.publicConfig.sources as Record<string, Record<string, unknown>>).repoConfig?.enabled).toBe("default");
  });

  it("repoConfigPolicy reads the loaded runtime config", () => {
    loadConfig();
    expect(repoConfigPolicy().allowKeys).toEqual([...DEFAULT_REPO_CONFIG_ALLOW_KEYS]);
  });

  it("repoConfigBaseFromRuntime projects the boot config and its real provenance", () => {
    vi.stubEnv("LASTLIGHT_MODELS", '{"triage":"anthropic/claude-haiku-4-5-20251001"}');
    const config = loadConfig();
    const projected = repoConfigBaseFromRuntime(config);

    expect(projected.value.models).toMatchObject({ triage: "anthropic/claude-haiku-4-5-20251001" });
    expect(projected.value.disabled).toMatchObject({ workflows: [], crons: [] });
    // A leaf the repo does NOT override must keep its real boot provenance.
    expect((projected.sources.models as Record<string, string>).triage).toBe("env");
    expect((projected.sources.disabled as Record<string, string>).workflows).toBe("default");

    // …and that provenance must survive the repo merge untouched.
    const result = resolveRepoConfig(projected, policy(), layerWith({ models: { architect: "openai/gpt-5.5" } }));
    expect(result.sources.models.triage).toBe("env");
    expect(result.sources.models.architect).toBe("repo");
    expect(result.merged.models.triage).toBe("anthropic/claude-haiku-4-5-20251001");
  });
});

describe("loadConfig — the fix / dependencies / review blocks", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("normalizes the shipped blocks and keeps reviewPostsCheck a mirror of review.postsCheck", () => {
    const config = loadConfig();
    expect(config.fix).toEqual(defaultFixConfig());
    expect(config.dependencies).toEqual(defaultDependenciesConfig());
    expect(config.review).toEqual(defaultReviewConfig());
    expect(config.reviewPostsCheck).toBe(config.review.postsCheck);
  });

  it("degrades a malformed overlay value to the default rather than throwing", () => {
    // Lenient on purpose: the SAME blocks are read out of an untrusted repo
    // layer, so a typo must cost the typo'd leaf, not the boot.
    const overlay = mkdtempSync(join(tmpdir(), "lastlight-policy-overlay-"));
    writeFileSync(
      join(overlay, "config.yaml"),
      [
        "fix:",
        "  maxAttempts: lots",
        "  localIterations: 1",
        "  maxCostUsd: null",
        "  retryableClasses: nope",
        "dependencies:",
        "  autoMergeMaxImpact: catastrophic",
        "  auditComment: false",
        "review:",
        "  trigger: whenever",
        "  skipDraft: false",
        "",
      ].join("\n"),
    );
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);

    const config = loadConfig();
    expect(config.fix.maxAttempts).toBe(defaultFixConfig().maxAttempts);
    expect(config.fix.retryableClasses).toEqual(defaultFixConfig().retryableClasses);
    expect(config.dependencies.autoMergeMaxImpact).toBe(defaultDependenciesConfig().autoMergeMaxImpact);
    expect(config.review.trigger).toBe(defaultReviewConfig().trigger);
    // …while the well-formed leaves beside them still apply, including an
    // explicit `null` cost ceiling (the documented "no ceiling" value) and an
    // explicit `false` an operator is entitled to set.
    expect(config.fix.localIterations).toBe(1);
    expect(config.fix.maxCostUsd).toBeNull();
    expect(config.dependencies.auditComment).toBe(false);
    expect(config.review.skipDraft).toBe(false);
  });

  it("projects both blocks into the repo-merge base, with provenance", () => {
    // The trap: a block missing from `repoConfigBaseFromRuntime` has no operator
    // value at merge time, so every clamp silently falls back to the shipped
    // default and an overlay's own tightening is ignored.
    const projected = repoConfigBaseFromRuntime(loadConfig());
    expect(projected.value.fix).toEqual(defaultFixConfig());
    expect(projected.value.dependencies).toEqual(defaultDependenciesConfig());
    expect(projected.value.review).toEqual(defaultReviewConfig());
    expect((projected.sources.fix as Record<string, string>).maxAttempts).toBe("default");
    expect((projected.sources.dependencies as Record<string, string>).autoMergeMaxImpact).toBe("default");
    expect((projected.sources.review as Record<string, string>).trigger).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Allow-list enforcement
// ---------------------------------------------------------------------------

describe("resolveRepoConfig — allow-list", () => {
  it("drops a non-allow-listed key with a structured warning", () => {
    const result = resolveRepoConfig(
      base(),
      policy(),
      layerWith({ managedRepos: ["evil/repo"], sandbox: { backend: "none" }, models: { triage: "openai/gpt-5.5" } }),
    );
    expect(result.merged.models.triage).toBe("openai/gpt-5.5");
    expect(result.merged).not.toHaveProperty("managedRepos");
    const dropped = result.warnings.filter((w) => w.code === "key-not-allowed").map((w) => w.path);
    expect(dropped).toEqual(expect.arrayContaining(["managedRepos", "sandbox"]));
  });

  it("drops disabled.prompts (not on the allow-list) while keeping disabled.workflows", () => {
    const result = resolveRepoConfig(
      base(),
      policy(),
      layerWith({ disabled: { workflows: ["build"], prompts: ["architect.md"] } }),
    );
    expect(result.merged.disabled.workflows).toEqual(["build"]);
    expect(result.merged.disabled.prompts).toEqual([]);
    expect(result.warnings.find((w) => w.path === "disabled.prompts")?.code).toBe("key-not-allowed");
  });

  it("honours an operator narrowing the allow-list to a single leaf", () => {
    const result = resolveRepoConfig(
      base(),
      policy({ allowKeys: ["models.triage"] }),
      layerWith({ models: { triage: "openai/gpt-5.5", architect: "openai/gpt-5.5" } }),
    );
    expect(result.merged.models.triage).toBe("openai/gpt-5.5");
    expect(result.merged.models.architect).toBeUndefined();
    expect(result.warnings.find((w) => w.path === "models.architect")?.code).toBe("key-not-allowed");
  });

  it("applies nothing and warns about nothing when the policy is disabled", () => {
    const result = resolveRepoConfig(base(), policy({ enabled: false }), layerWith({ models: { triage: "openai/gpt-5.5" } }));
    expect(result.merged.models).toEqual({ default: "anthropic/claude-sonnet-4-6" });
    expect(result.warnings).toEqual([]);
  });

  it("returns the base untouched when there is no repo layer at all", () => {
    const result = resolveRepoConfig(base(), policy(), undefined);
    expect(result.merged.models).toEqual({ default: "anthropic/claude-sonnet-4-6" });
    expect(result.sources.models.default).toBe("default");
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Model bounds
// ---------------------------------------------------------------------------

describe("resolveRepoConfig — model bounds", () => {
  it("drops a model outside a non-null allowedModels", () => {
    const result = resolveRepoConfig(
      base(),
      policy({ allowedModels: ["anthropic/claude-haiku-4-5-20251001"] }),
      layerWith({ models: { triage: "openai/gpt-5.5", screener: "anthropic/claude-haiku-4-5-20251001" } }),
    );
    expect(result.merged.models.screener).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(result.merged.models.triage).toBeUndefined();
    expect(result.warnings.find((w) => w.path === "models.triage")?.code).toBe("model-not-allowed");
  });

  it("drops a model whose provider prefix is not a provider we can wire", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ models: { triage: "evilcorp/pwn-1" } }));
    expect(result.merged.models.triage).toBeUndefined();
    expect(result.warnings.find((w) => w.path === "models.triage")?.code).toBe("unknown-provider");
  });

  it("drops a bare model id with no provider prefix", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ models: { triage: "claude-sonnet-4-6" } }));
    expect(result.warnings.find((w) => w.path === "models.triage")?.code).toBe("unknown-provider");
  });

  it("accepts an OAuth-provider model prefix", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ models: { chat: "github-copilot/gpt-4o" } }));
    expect(result.merged.models.chat).toBe("github-copilot/gpt-4o");
  });

  it("drops a non-string model value", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ models: { triage: 42 } }));
    expect(result.warnings.find((w) => w.path === "models.triage")?.code).toBe("invalid-value");
  });
});

// ---------------------------------------------------------------------------
// Approval — add-only
// ---------------------------------------------------------------------------

describe("resolveRepoConfig — approval is add-only", () => {
  it("honours an upgrade (repo raises a gate the operator left off)", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ approval: { post_architect: true } }));
    expect(result.merged.approval.post_architect).toBe(true);
    expect(result.sources.approval.post_architect).toBe("repo");
    expect(result.warnings).toEqual([]);
  });

  it("rejects a downgrade of an operator-set gate and keeps the operator value", () => {
    const result = resolveRepoConfig(
      base({ approval: { post_architect: true } }, { approval: { post_architect: "overlay" } }),
      policy(),
      layerWith({ approval: { post_architect: false } }),
    );
    expect(result.merged.approval.post_architect).toBe(true);
    expect(result.sources.approval.post_architect).toBe("overlay");
    expect(result.warnings.find((w) => w.path === "approval.post_architect")?.code).toBe("approval-downgrade");
  });

  it("drops a `false` gate the operator never set (a no-op, still reported)", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ approval: { post_architect: false } }));
    expect(result.merged.approval.post_architect).toBeUndefined();
    expect(result.warnings.find((w) => w.path === "approval.post_architect")).toBeDefined();
  });

  it("drops a non-boolean gate value", () => {
    const result = resolveRepoConfig(base(), policy(), layerWith({ approval: { post_architect: "yes" } }));
    expect(result.warnings.find((w) => w.path === "approval.post_architect")?.code).toBe("invalid-value");
  });
});

// ---------------------------------------------------------------------------
// The fix / dependencies / review policy blocks (issues #251, #252)
// ---------------------------------------------------------------------------

/** The shipped bounds, which admit the three policy blocks. */
function policyBlocks(): RepoConfigPolicy {
  return policy({ allowKeys: [...POLICY.allowKeys, "fix", "dependencies", "review"] });
}

/**
 * A base carrying explicit operator values for the three blocks, with the
 * per-leaf provenance `repoConfigBaseFromRuntime` builds for them — so a leaf
 * the repo fails to win keeps its real boot source rather than vanishing.
 */
function policyBase(overrides: Record<string, unknown> = {}): RepoConfigBase {
  const value = {
    fix: { ...defaultFixConfig() },
    dependencies: { ...defaultDependenciesConfig() },
    review: { ...defaultReviewConfig() },
    ...overrides,
  };
  const allDefault = (node: object) => Object.fromEntries(Object.keys(node).map((k) => [k, "default"]));
  return base(value, {
    fix: allDefault(value.fix),
    dependencies: allDefault(value.dependencies),
    review: allDefault(value.review),
  });
}

describe("resolveRepoConfig — fix policy is clamped one way", () => {
  it("honours a repo tightening every budget it may set", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({
        fix: { maxAttempts: 1, localIterations: 1, maxCostUsd: 0.5, maxFlakyDeferrals: 0, retryableClasses: ["flaky"] },
      }),
    );

    expect(result.merged.fix.maxAttempts).toBe(1);
    expect(result.merged.fix.localIterations).toBe(1);
    expect(result.merged.fix.maxCostUsd).toBe(0.5);
    expect(result.merged.fix.maxFlakyDeferrals).toBe(0);
    expect(result.sources.fix.maxAttempts).toBe("repo");
    // `flaky` is not in the operator's retryable list, so the subset rule drops
    // it — tightening in one key and loosening in another are judged separately.
    expect(result.merged.fix.retryableClasses).toEqual([]);
    expect(codes(result.warnings)).toEqual(["policy-downgrade"]);
  });

  it("rejects raising a budget above the operator's and keeps the operator value", () => {
    const result = resolveRepoConfig(
      policyBase({ fix: { ...defaultFixConfig(), maxAttempts: 2 } }),
      policyBlocks(),
      layerWith({ fix: { maxAttempts: 9 } }),
    );

    expect(result.merged.fix.maxAttempts).toBe(2);
    expect(result.sources.fix.maxAttempts).toBe("default");
    expect(result.warnings.find((w) => w.path === "fix.maxAttempts")?.code).toBe("policy-downgrade");
  });

  it("rejects `maxCostUsd: null` — no ceiling is the loosest value there is", () => {
    const result = resolveRepoConfig(policyBase(), policyBlocks(), layerWith({ fix: { maxCostUsd: null } }));

    expect(result.merged.fix.maxCostUsd).toBe(defaultFixConfig().maxCostUsd);
    expect(result.warnings.find((w) => w.path === "fix.maxCostUsd")?.code).toBe("policy-downgrade");
  });

  it("accepts a ceiling under an unbounded operator", () => {
    const result = resolveRepoConfig(
      policyBase({ fix: { ...defaultFixConfig(), maxCostUsd: null } }),
      policyBlocks(),
      layerWith({ fix: { maxCostUsd: 2 } }),
    );

    expect(result.merged.fix.maxCostUsd).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("keeps retryableClasses a subset of the operator's list", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ fix: { retryableClasses: ["reproducible", "infra-dependent"] } }),
    );

    expect(result.merged.fix.retryableClasses).toEqual(["reproducible"]);
    expect(result.warnings.find((w) => w.path === "fix.retryableClasses")?.code).toBe("policy-downgrade");
  });

  it("reports a misspelt class as a typo, not as a policy decision", () => {
    // Two different problems with two different fixes: "you spelled it wrong"
    // (`invalid-value`) and "the operator doesn't retry that"
    // (`policy-downgrade`). Reporting the first as the second sends the repo
    // owner to ask the operator about a key they typed wrong (#256).
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ fix: { retryableClasses: ["reproducable"] } }),
    );

    expect(result.merged.fix.retryableClasses).toEqual([]);
    const warning = result.warnings.find((w) => w.path === "fix.retryableClasses");
    expect(warning?.code).toBe("invalid-value");
    expect(warning?.message).toContain("reproducable");
    expect(warning?.message).toContain("reproducible"); // the five, named
  });

  it("separates a typo from a genuine downgrade in the same list", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ fix: { retryableClasses: ["reproducible", "reproducable", "infra-dependent"] } }),
    );

    expect(result.merged.fix.retryableClasses).toEqual(["reproducible"]);
    expect(codes(result.warnings).sort()).toEqual(["invalid-value", "policy-downgrade"]);
  });

  it("refuses the operator-only keys outright", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ fix: { escalateModelAfterAttempt: 9, gateTimeoutSeconds: 60 } }),
    );

    expect(result.merged.fix.escalateModelAfterAttempt).toBe(defaultFixConfig().escalateModelAfterAttempt);
    // 60 is *tighter* than the operator's 900 and still refused: this is not a
    // clamp, it is "not your key" — the gate budget is a shared resource.
    expect(result.merged.fix.gateTimeoutSeconds).toBe(defaultFixConfig().gateTimeoutSeconds);
    expect(codes(result.warnings)).toEqual(["key-not-allowed", "key-not-allowed"]);
  });

  it("drops an unknown leaf and a malformed value without failing the layer", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ fix: { maxAttempts: "lots", nonsense: true } }),
    );

    expect(result.merged.fix.maxAttempts).toBe(defaultFixConfig().maxAttempts);
    expect(codes(result.warnings)).toEqual(["invalid-value", "invalid-value"]);
  });
});

describe("resolveRepoConfig — dependencies policy is clamped one way", () => {
  it("honours a repo lowering its auto-merge ceiling", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ dependencies: { autoMergeMaxImpact: "none", auditComment: true } }),
    );

    expect(result.merged.dependencies.autoMergeMaxImpact).toBe("none");
    expect(result.sources.dependencies.autoMergeMaxImpact).toBe("repo");
    // auditComment is add-only `true` — asking for the record is always allowed.
    expect(result.merged.dependencies.auditComment).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("refuses to let a repo silence the audit comment the operator requires", () => {
    // The audit comment records a MAJOR bump this deployment auto-merged into
    // that repo, so the party it would silence is the party being audited
    // (#256). Turning it on when the operator has it off stays allowed.
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ dependencies: { auditComment: false } }),
    );

    expect(result.merged.dependencies.auditComment).toBe(true);
    expect(result.sources.dependencies.auditComment).not.toBe("repo");
    expect(codes(result.warnings)).toEqual(["policy-downgrade"]);
  });

  it("lets a repo turn the audit comment ON when the operator has it off", () => {
    const result = resolveRepoConfig(
      policyBase({ dependencies: { ...defaultDependenciesConfig(), auditComment: false } }),
      policyBlocks(),
      layerWith({ dependencies: { auditComment: true } }),
    );

    expect(result.merged.dependencies.auditComment).toBe(true);
    expect(result.sources.dependencies.auditComment).toBe("repo");
    expect(result.warnings).toEqual([]);
  });

  it("rejects raising the ceiling above the operator's tier", () => {
    const result = resolveRepoConfig(
      policyBase({ dependencies: { ...defaultDependenciesConfig(), autoMergeMaxImpact: "low" } }),
      policyBlocks(),
      layerWith({ dependencies: { autoMergeMaxImpact: "high" } }),
    );

    expect(result.merged.dependencies.autoMergeMaxImpact).toBe("low");
    expect(result.warnings.find((w) => w.path === "dependencies.autoMergeMaxImpact")?.code).toBe("policy-downgrade");
  });

  it("rejects an impact tier that isn't one of the four", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ dependencies: { autoMergeMaxImpact: "catastrophic" } }),
    );

    expect(result.merged.dependencies.autoMergeMaxImpact).toBe(defaultDependenciesConfig().autoMergeMaxImpact);
    expect(codes(result.warnings)).toEqual(["invalid-value"]);
  });

  it("treats requireSettledChecks as add-only", () => {
    const off = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ dependencies: { requireSettledChecks: false } }),
    );
    expect(off.merged.dependencies.requireSettledChecks).toBe(true);
    expect(off.warnings.find((w) => w.path === "dependencies.requireSettledChecks")?.code).toBe("policy-downgrade");

    const on = resolveRepoConfig(
      policyBase({ dependencies: { ...defaultDependenciesConfig(), requireSettledChecks: false } }),
      policyBlocks(),
      layerWith({ dependencies: { requireSettledChecks: true } }),
    );
    expect(on.merged.dependencies.requireSettledChecks).toBe(true);
    expect(on.warnings).toEqual([]);
  });

  it("refuses minSettledChecks in either direction — it is operator-only", () => {
    // 09 locked decision 18: a `max(repo, operator)` clamp would weld the escape
    // hatch shut for a repo with no CI, so the key simply isn't repo-settable.
    const raise = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ dependencies: { minSettledChecks: 5 } }),
    );
    const lower = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ dependencies: { minSettledChecks: 0 } }),
    );

    expect(raise.merged.dependencies.minSettledChecks).toBe(1);
    expect(lower.merged.dependencies.minSettledChecks).toBe(1);
    expect(codes(raise.warnings)).toEqual(["key-not-allowed"]);
    expect(codes(lower.warnings)).toEqual(["key-not-allowed"]);
  });
});

describe("resolveRepoConfig — review policy", () => {
  it("lets a repo opt DOWN the automation scale, and name its own request label", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ review: { trigger: "on-request", requestLabel: "please-review" } }),
    );

    expect(result.merged.review.trigger).toBe("on-request");
    expect(result.merged.review.requestLabel).toBe("please-review");
    expect(result.sources.review.trigger).toBe("repo");
    expect(result.warnings).toEqual([]);
  });

  it("refuses a repo buying itself MORE review automation than the operator runs", () => {
    // `eager` is a full agent review per push, on the operator's budget (#256).
    // Same direction as the fix budgets: only ever less.
    const result = resolveRepoConfig(
      policyBase({ review: { ...defaultReviewConfig(), trigger: "on-request" } }),
      policyBlocks(),
      layerWith({ review: { trigger: "eager" } }),
    );

    expect(result.merged.review.trigger).toBe("on-request");
    expect(result.sources.review.trigger).not.toBe("repo");
    expect(codes(result.warnings)).toEqual(["policy-downgrade"]);
  });

  it("clamps the middle tier too, not just the extremes", () => {
    const result = resolveRepoConfig(
      policyBase({ review: { ...defaultReviewConfig(), trigger: "after-checks" } }),
      policyBlocks(),
      layerWith({ review: { trigger: "eager" } }),
    );

    expect(result.merged.review.trigger).toBe("after-checks");
    expect(codes(result.warnings)).toEqual(["policy-downgrade"]);
  });

  it("allows the equal tier without a warning", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ review: { trigger: defaultReviewConfig().trigger } }),
    );

    expect(result.merged.review.trigger).toBe(defaultReviewConfig().trigger);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an unknown trigger mode and a label that looks like a path", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policyBlocks(),
      layerWith({ review: { trigger: "whenever", requestLabel: "../etc/passwd" } }),
    );

    expect(result.merged.review.trigger).toBe(defaultReviewConfig().trigger);
    expect(result.merged.review.requestLabel).toBeNull();
    expect(codes(result.warnings)).toEqual(["invalid-value", "invalid-value"]);
  });

  it("treats skipDraft and postsCheck as add-only", () => {
    const result = resolveRepoConfig(
      policyBase({ review: { ...defaultReviewConfig(), postsCheck: true } }),
      policyBlocks(),
      layerWith({ review: { skipDraft: false, postsCheck: false } }),
    );

    expect(result.merged.review.skipDraft).toBe(true);
    expect(result.merged.review.postsCheck).toBe(true);
    expect(codes(result.warnings)).toEqual(["policy-downgrade", "policy-downgrade"]);
  });

  it("is dropped wholesale when the operator narrows it out of allowKeys", () => {
    const result = resolveRepoConfig(
      policyBase(),
      policy({ allowKeys: [...POLICY.allowKeys, "fix", "dependencies"] }),
      layerWith({ review: { trigger: "eager" } }),
    );

    expect(result.merged.review.trigger).toBe(defaultReviewConfig().trigger);
    expect(codes(result.warnings)).toEqual(["key-not-allowed"]);
  });
});

// ---------------------------------------------------------------------------
// Merge semantics
// ---------------------------------------------------------------------------

describe("repo layer merge semantics match the boot layers", () => {
  it("deep-merges maps key-by-key and attributes each leaf independently", () => {
    const result = resolveRepoConfig(
      base(
        { models: { default: "anthropic/claude-sonnet-4-6", architect: "openai/gpt-5.5" } },
        { models: { default: "default", architect: "overlay" } },
      ),
      policy(),
      layerWith({ models: { triage: "anthropic/claude-haiku-4-5-20251001" } }),
    );
    expect(result.merged.models).toEqual({
      default: "anthropic/claude-sonnet-4-6",
      architect: "openai/gpt-5.5",
      triage: "anthropic/claude-haiku-4-5-20251001",
    });
    expect(result.sources.models).toEqual({ default: "default", architect: "overlay", triage: "repo" });
  });

  it("replaces arrays wholesale rather than appending", () => {
    const result = resolveRepoConfig(
      base({ disabled: { workflows: ["build", "explore"], crons: [], prompts: [], skills: [], agentContext: [] } }),
      policy(),
      layerWith({ disabled: { workflows: ["pr-review"] } }),
    );
    expect(result.merged.disabled.workflows).toEqual(["pr-review"]);
    expect(result.sources.disabled.workflows).toBe("repo");
    expect(result.sources.disabled.crons).toBe("default");
  });

  it("resolveWithExtraLayer produces the same shape as a fourth boot layer would", () => {
    const boot = resolveConfigLayers({
      default: { models: { default: "d" }, disabled: { workflows: ["a"] } },
      overlay: { models: { architect: "o" } },
      env: {},
    });
    const viaExtra = resolveWithExtraLayer(
      boot.value,
      boot.sources,
      { models: { triage: "r" }, disabled: { workflows: ["b"] } },
      "repo",
    );
    expect(viaExtra.value).toEqual({
      models: { default: "d", architect: "o", triage: "r" },
      disabled: { workflows: ["b"] },
    });
    expect(viaExtra.sources).toEqual({
      models: { default: "default", architect: "overlay", triage: "repo" },
      disabled: { workflows: "repo" },
    });
  });

  it("resolveWithExtraLayer does not mutate the boot result it is given", () => {
    const boot = resolveConfigLayers({ default: { models: { default: "d" } }, overlay: null, env: {} });
    resolveWithExtraLayer(boot.value, boot.sources, { models: { default: "r" } }, "repo");
    expect(boot.value).toEqual({ models: { default: "d" } });
    expect(boot.sources).toEqual({ models: { default: "default" } });
  });
});

// ---------------------------------------------------------------------------
// YAML parsing
// ---------------------------------------------------------------------------

describe("parseRepoConfigYaml", () => {
  it("ignores a malformed file wholesale", () => {
    const parsed = parseRepoConfigYaml("models:\n  - [unclosed\n\t\tbad: :", "acme/widget");
    expect(parsed.config).toBeUndefined();
    expect(parsed.warnings[0]?.code).toBe("invalid-yaml");
  });

  it("ignores a top level that is not a mapping", () => {
    const parsed = parseRepoConfigYaml("- one\n- two");
    expect(parsed.config).toBeUndefined();
    expect(parsed.warnings[0]?.code).toBe("not-a-mapping");
  });

  it("treats an empty file as an empty (warning-free) layer", () => {
    expect(parseRepoConfigYaml("")).toEqual({ warnings: [] });
  });

  it("returns the mapping for a valid file", () => {
    const parsed = parseRepoConfigYaml("models:\n  triage: openai/gpt-5.5\n");
    expect(parsed.config).toEqual({ models: { triage: "openai/gpt-5.5" } });
  });

  it("a malformed file leaves the whole config untouched end-to-end", () => {
    const parsed = parseRepoConfigYaml("models: [unclosed", "acme/widget");
    const result = resolveRepoConfig(base(), policy(), { ...layerWith(parsed.config), warnings: parsed.warnings });
    expect(result.merged.models).toEqual({ default: "anthropic/claude-sonnet-4-6" });
    expect(codes(result.warnings)).toContain("invalid-yaml");
  });
});

// ---------------------------------------------------------------------------
// File guards
// ---------------------------------------------------------------------------

describe("repoLayerPathKind", () => {
  it("classifies the overlay-shaped paths", () => {
    expect(repoLayerPathKind("lastlight.yml")).toBe("config");
    expect(repoLayerPathKind("workflows/prompts/foo.md")).toBe("prompt");
    expect(repoLayerPathKind("skills/pr-review/SKILL.md")).toBe("skill");
    expect(repoLayerPathKind("agent-context/rules.md")).toBe("agent-context");
  });

  it("returns null for build-handoff docs and anything else in .lastlight/", () => {
    expect(repoLayerPathKind("issue-42/architect-plan.md")).toBeNull();
    expect(repoLayerPathKind("workflows/build.yaml")).toBeNull();
    expect(repoLayerPathKind("lastlight.yaml")).toBeNull();
  });
});

describe("sanitizeRepoFiles", () => {
  it("accepts a well-formed layer", () => {
    const { accepted, warnings } = sanitizeRepoFiles(
      [
        file("lastlight.yml"),
        file("workflows/prompts/foo.md"),
        file("skills/review/SKILL.md"),
        file("agent-context/rules.md"),
      ],
      policy(),
    );
    expect(accepted.map((f) => f.path)).toEqual([
      "lastlight.yml",
      "workflows/prompts/foo.md",
      "skills/review/SKILL.md",
      "agent-context/rules.md",
    ]);
    expect(warnings).toEqual([]);
  });

  it("rejects a workflow YAML but accepts a prompt beside it", () => {
    const { accepted, warnings } = sanitizeRepoFiles(
      [file("workflows/foo.yaml"), file("workflows/bar.yml"), file("workflows/prompts/foo.md")],
      policy(),
    );
    expect(accepted.map((f) => f.path)).toEqual(["workflows/prompts/foo.md"]);
    expect(codes(warnings)).toEqual(["workflow-not-allowed", "workflow-not-allowed"]);
  });

  it("rejects path escapes", () => {
    const { accepted, warnings } = sanitizeRepoFiles(
      [
        file("../../etc/passwd"),
        file("skills/../../escape/SKILL.md"),
        file("/etc/shadow"),
        file("agent-context/./rules.md"),
      ],
      policy(),
    );
    expect(accepted).toEqual([]);
    expect(codes(warnings)).toEqual(["path-escape", "path-escape", "path-escape", "path-escape"]);
  });

  it("rejects symlinks and other non-regular blobs", () => {
    const { accepted, warnings } = sanitizeRepoFiles(
      [file("agent-context/rules.md", "/etc/passwd", "120000"), file("skills/x/SKILL.md", "", "160000")],
      policy(),
    );
    expect(accepted).toEqual([]);
    expect(codes(warnings)).toEqual(["symlink", "symlink"]);
  });

  it("enforces the file-count cap", () => {
    const files = Array.from({ length: REPO_CONFIG_MAX_FILES + 5 }, (_, i) => file(`agent-context/f${i}.md`));
    const { accepted, warnings } = sanitizeRepoFiles(files, policy());
    expect(accepted).toHaveLength(REPO_CONFIG_MAX_FILES);
    expect(warnings).toHaveLength(5);
    expect(codes(warnings).every((c) => c === "file-count-cap")).toBe(true);
  });

  it("enforces the total size cap", () => {
    const big = "z".repeat(Math.floor(REPO_CONFIG_MAX_BYTES / 2) + 1);
    const { accepted, warnings } = sanitizeRepoFiles(
      [file("agent-context/a.md", big), file("agent-context/b.md", big), file("agent-context/c.md", "small")],
      policy(),
    );
    expect(accepted.map((f) => f.path)).toEqual(["agent-context/a.md", "agent-context/c.md"]);
    expect(codes(warnings)).toEqual(["size-cap"]);
  });

  it("ignores non-layer paths silently but reports wrong-shaped layer assets once", () => {
    const { accepted, warnings } = sanitizeRepoFiles(
      [file("issue-42/architect-plan.md"), file("issue-42/status.md"), file("skills/loose.md"), file("workflows/x.txt")],
      policy(),
    );
    expect(accepted).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("unrecognised-asset");
    expect(warnings[0]?.message).toContain("2 file(s)");
  });

  it("drops assets when allowAssets is false, keeping lastlight.yml", () => {
    const { accepted, warnings } = sanitizeRepoFiles(
      [file("lastlight.yml"), file("agent-context/rules.md"), file("skills/x/SKILL.md")],
      policy({ allowAssets: false }),
    );
    expect(accepted.map((f) => f.path)).toEqual(["lastlight.yml"]);
    expect(codes(warnings)).toEqual(["assets-not-allowed"]);
  });

  it("tags every warning with the repo when given one", () => {
    const { warnings } = sanitizeRepoFiles([file("workflows/foo.yaml")], policy(), "acme/widget");
    expect(warnings[0]?.repo).toBe("acme/widget");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRepoConfigLayer directly (shape of the layer handed to the merger)
// ---------------------------------------------------------------------------

describe("sanitizeRepoConfigLayer", () => {
  it("rejects a disabled entry that looks like a path", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      { disabled: { workflows: ["../../etc/passwd"] } },
      policy(),
      base(),
    );
    expect(layer).toEqual({});
    expect(warnings[0]?.code).toBe("invalid-value");
  });

  it("rejects a non-mapping value for an allow-listed key", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer({ models: ["openai/gpt-5.5"] }, policy(), base());
    expect(layer).toEqual({});
    expect(warnings[0]?.code).toBe("invalid-value");
  });

  it("does not emit an empty sub-tree when every leaf was dropped", () => {
    const { layer } = sanitizeRepoConfigLayer({ models: { triage: "nope/nope" } }, policy(), base());
    expect(layer).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// fetchRepoLayer — cache, conditional refetch, unpack
// ---------------------------------------------------------------------------

interface FakeClient {
  client: GitHubClient;
  calls: Array<{ etag?: string; treeSha?: string }>;
  next: RepoConfigTreeResult;
}

function fakeClient(next: RepoConfigTreeResult): FakeClient {
  const state: FakeClient = {
    calls: [],
    next,
    client: undefined as unknown as GitHubClient,
  };
  state.client = {
    async fetchRepoConfigTree(_owner: string, _repo: string, options: { etag?: string; treeSha?: string } = {}) {
      state.calls.push({ etag: options.etag, treeSha: options.treeSha });
      return state.next;
    },
  } as unknown as GitHubClient;
  return state;
}

const YML = "models:\n  triage: openai/gpt-5.5\n";

describe("fetchRepoLayer", () => {
  let cacheRoot: string;

  beforeEach(() => {
    resetRepoConfigForTests();
    cacheRoot = mkdtempSync(join(tmpdir(), "lastlight-repo-config-"));
  });
  afterEach(() => {
    resetRepoConfigForTests();
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  const okResult = (): RepoConfigTreeResult => ({
    status: "ok",
    defaultBranch: "trunk",
    treeSha: "tree-1",
    etag: 'W/"abc"',
    truncated: false,
    files: [file("lastlight.yml", YML), file("workflows/prompts/foo.md", "# hi"), file("workflows/bad.yaml", "kind: cron")],
  });

  it("fetches, unpacks to <cacheRoot>/<owner>/<repo>/files and persists a sidecar", async () => {
    const fake = fakeClient(okResult());
    const layer = await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });

    expect(layer).toBeDefined();
    expect(layer!.defaultBranch).toBe("trunk");
    expect(layer!.config).toEqual({ models: { triage: "openai/gpt-5.5" } });
    expect(layer!.root).toBe(join(cacheRoot, "acme/widget", "files"));
    expect(readFileSync(join(layer!.root, "lastlight.yml"), "utf-8")).toBe(YML);
    expect(existsSync(join(layer!.root, "workflows/prompts/foo.md"))).toBe(true);
    expect(existsSync(join(layer!.root, "workflows/bad.yaml"))).toBe(false);
    expect(listRepoLayerAssets(layer!.root)).toEqual(["workflows/prompts/foo.md"]);

    const sidecar = JSON.parse(readFileSync(join(cacheRoot, "acme/widget", "meta.json"), "utf-8"));
    expect(sidecar).toMatchObject({ repo: "acme/widget", defaultBranch: "trunk", treeSha: "tree-1", etag: 'W/"abc"' });
    expect(codes(layer!.warnings)).toContain("workflow-not-allowed");
  });

  it("serves the cached layer inside the TTL without a second request", async () => {
    const fake = fakeClient(okResult());
    await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    expect(fake.calls).toHaveLength(1);
    expect(getCachedRepoLayer("acme/widget")?.treeSha).toBe("tree-1");
  });

  it("sends the stored etag + treeSha on a forced refresh and treats not-modified as a hit", async () => {
    const fake = fakeClient(okResult());
    const first = await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    fake.next = { status: "not-modified", defaultBranch: "trunk", treeSha: "tree-1", etag: 'W/"abc"' };

    const second = await refreshRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    expect(fake.calls[1]).toEqual({ etag: 'W/"abc"', treeSha: "tree-1" });
    expect(second?.config).toEqual(first?.config);
    expect(second?.treeSha).toBe("tree-1");
  });

  it("rebuilds the layer from disk after a cold start (memory cache empty, sidecar present)", async () => {
    const fake = fakeClient(okResult());
    await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });

    resetRepoConfigForTests(); // simulate a process restart
    fake.next = { status: "not-modified", defaultBranch: "trunk", treeSha: "tree-1", etag: 'W/"abc"' };
    const layer = await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });

    expect(fake.calls[1]).toEqual({ etag: 'W/"abc"', treeSha: "tree-1" });
    expect(layer?.config).toEqual({ models: { triage: "openai/gpt-5.5" } });
  });

  it("treats an absent .lastlight/ as a cheap negative and caches it", async () => {
    const fake = fakeClient({ status: "absent", defaultBranch: "trunk" });
    expect(await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot })).toBeUndefined();
    expect(await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot })).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it("never throws on a fetch error and keeps the last good layer", async () => {
    const fake = fakeClient(okResult());
    await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    const broken = {
      async fetchRepoConfigTree() {
        throw new Error("boom");
      },
    } as unknown as GitHubClient;

    const layer = await refreshRepoLayer("acme/widget", { client: broken, policy: policy(), cacheRoot });
    expect(layer?.config).toEqual({ models: { triage: "openai/gpt-5.5" } });
    expect(codes(layer!.warnings)).toContain("fetch-failed");
  });

  it("does nothing at all when the policy is disabled", async () => {
    const fake = fakeClient(okResult());
    expect(
      await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy({ enabled: false }), cacheRoot }),
    ).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a malformed repo name without calling GitHub", async () => {
    const fake = fakeClient(okResult());
    expect(await fetchRepoLayer("../../etc", { client: fake.client, policy: policy(), cacheRoot })).toBeUndefined();
    expect(await fetchRepoLayer("acme/widget/extra", { client: fake.client, policy: policy(), cacheRoot })).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("never writes a file outside the cache dir, even for a hostile tree", async () => {
    const fake = fakeClient({
      status: "ok",
      defaultBranch: "trunk",
      treeSha: "tree-escape",
      truncated: false,
      files: [file("../../escaped.md", "nope"), file("agent-context/ok.md", "yes")],
    });
    const layer = await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    expect(existsSync(join(cacheRoot, "..", "escaped.md"))).toBe(false);
    expect(listRepoLayerAssets(layer!.root)).toEqual(["agent-context/ok.md"]);
    expect(codes(layer!.warnings)).toContain("path-escape");
  });

  it("invalidateRepoLayer forces the next call back onto the network", async () => {
    const fake = fakeClient(okResult());
    await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    invalidateRepoLayer("acme/widget");
    expect(getCachedRepoLayer("acme/widget")).toBeUndefined();
    fake.next = { status: "not-modified", defaultBranch: "trunk", treeSha: "tree-1", etag: 'W/"abc"' };
    await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    expect(fake.calls).toHaveLength(2);
  });

  it("feeds straight into resolveRepoConfig", async () => {
    const fake = fakeClient(okResult());
    const layer = await fetchRepoLayer("acme/widget", { client: fake.client, policy: policy(), cacheRoot });
    const result = resolveRepoConfig(base(), policy(), layer);
    expect(result.merged.models.triage).toBe("openai/gpt-5.5");
    expect(result.sources.models.triage).toBe("repo");
    expect(codes(result.warnings)).toContain("workflow-not-allowed");
  });
});
