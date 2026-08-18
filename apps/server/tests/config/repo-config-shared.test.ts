import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultNotificationsConfig,
  defaultReviewConfig,
} from "lastlight-shared/config-types";
import {
  DEFAULT_REPO_CONFIG_ALLOW_KEYS,
  defaultRepoConfigPolicy,
  mergeLayer,
  resolveRepoConfig,
  sanitizeRepoConfigLayer,
  type RepoConfigBase,
  type RepoLayer,
} from "lastlight-shared/repo-config-schema";
import { DEFAULT_REPO_CONFIG_ALLOW_KEYS as CORE_ALLOW_KEYS } from "#src/config/config.js";
import { mergeLayer as coreMergeLayer } from "#src/config/config-resolve.js";

/**
 * The per-repo config bounds have exactly ONE definition (issue #180).
 *
 * Three things used to be duplicated across `lastlight-shared`, core's
 * `config.ts` and core's `config-resolve.ts`: the default allow-list, the
 * `RepoConfigPolicy` shape, and the layer merge. Duplication here is not a
 * tidiness problem — the shared copies are what the CLI validates a repo's
 * `.lastlight/` against offline and what `repoConfigPolicy()` falls back to when
 * config isn't loaded, so a divergence tells repo owners the wrong answer. These
 * tests pin the copies to one another and to `config/default.yaml`.
 */

/** The shipped `config/default.yaml`, parsed. */
function defaultYaml(): Record<string, unknown> {
  const path = fileURLToPath(new URL("../../config/default.yaml", import.meta.url));
  return parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** `repoConfig.allowKeys` as the shipped deployment config actually declares it. */
function defaultYamlAllowKeys(): string[] {
  return (defaultYaml().repoConfig as { allowKeys?: string[] } | undefined)?.allowKeys ?? [];
}

function base(): RepoConfigBase {
  return {
    value: {
      models: { default: "anthropic/claude-sonnet-4-6" },
      variants: {},
      disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
      approval: {},
    },
    sources: {
      models: { default: "default" },
      variants: {},
      disabled: { workflows: "default", crons: "default", prompts: "default", skills: "default", agentContext: "default" },
      approval: {},
    },
  };
}

function layer(config: Record<string, unknown>): RepoLayer {
  return {
    repo: "acme/widget",
    defaultBranch: "main",
    treeSha: "tree-1",
    fetchedAt: "2026-07-31T09:00:00.000Z",
    root: "/nonexistent",
    config,
    assets: [],
    warnings: [],
  };
}

describe("default allow-list", () => {
  it("matches repoConfig.allowKeys in config/default.yaml exactly", () => {
    // Order included: these are two spellings of the same list, and a reader
    // diffing them should see no difference at all.
    expect([...DEFAULT_REPO_CONFIG_ALLOW_KEYS]).toEqual(defaultYamlAllowKeys());
  });

  it("admits `crons`, so a repo committing a crons: block is in bounds", () => {
    // The drift that motivated this test: default.yaml allowed `crons` while the
    // shared constant did not, so the no-config fallback and the CLI's offline
    // validator both rejected a legitimate file.
    expect(DEFAULT_REPO_CONFIG_ALLOW_KEYS).toContain("crons");
    expect(defaultYamlAllowKeys()).toContain("crons");
    // The offline CLI validator resolves its bounds through this.
    expect(defaultRepoConfigPolicy().allowKeys).toContain("crons");
  });

  it("allows `services` by default, but grants no image", () => {
    // The KEY is settable so a repo's file is in bounds; the CAPABILITY is withheld
    // until an operator lists images. Note the polarity is the inverse of
    // allowedModels, where null means permissive — getting these two the same way
    // round would ship a deny-nothing default for arbitrary container images.
    expect(DEFAULT_REPO_CONFIG_ALLOW_KEYS).toContain("services");
    expect(defaultYamlAllowKeys()).toContain("services");
    expect(defaultRepoConfigPolicy().allowedImages).toBeNull();
    expect(defaultRepoConfigPolicy().allowedModels).toBeNull();
  });

  it("is the same constant core re-exports — one definition, not two", () => {
    expect(CORE_ALLOW_KEYS).toBe(DEFAULT_REPO_CONFIG_ALLOW_KEYS);
  });

  it("admits the fix / dependencies / review policy blocks", () => {
    // Each is allow-listed AND has a validator in `sanitizeRepoConfigLayer`: an
    // allow-listed key with no validator is silently dropped as
    // `key-not-allowed`, which reads to a repo owner exactly like "not allowed".
    for (const key of ["fix", "dependencies", "review", "notifications"]) {
      expect(DEFAULT_REPO_CONFIG_ALLOW_KEYS).toContain(key);
      const { warnings } = sanitizeRepoConfigLayer({ [key]: {} }, defaultRepoConfigPolicy(), base(), "acme/widget");
      expect(warnings).toEqual([]);
    }
  });
});

describe("the fix / dependencies / review defaults", () => {
  // Same rule as the allow-list above: `config/default.yaml` is the operator's
  // documentation, the exported `default*Config()` functions are what the
  // clamps and the offline CLI validator compare against when a base carries no
  // block. Two spellings of one thing — pinned so they can't drift.
  it("match the blocks shipped in config/default.yaml", () => {
    expect(defaultYaml().fix).toEqual(defaultFixConfig());
    expect(defaultYaml().dependencies).toEqual(defaultDependenciesConfig());
    expect(defaultYaml().review).toEqual(defaultReviewConfig());
    expect(defaultYaml().notifications).toEqual(defaultNotificationsConfig());
  });

  it("ship the decided values (a change here is a behaviour change for every deployment)", () => {
    expect(defaultFixConfig()).toMatchObject({ maxAttempts: 3, maxCostUsd: 5.0, maxFlakyDeferrals: 2 });
    expect(defaultDependenciesConfig()).toMatchObject({ autoMergeMaxImpact: "medium", minSettledChecks: 1 });
    expect(defaultReviewConfig()).toMatchObject({ trigger: "after-checks", skipDraft: true });
    // 09 locked decision 14 deleted `review.afterChecks`; it must not come back.
    expect(defaultReviewConfig()).not.toHaveProperty("afterChecks");
    expect(defaultYaml().review).not.toHaveProperty("afterChecks");
  });
});

describe("a repo's crons: block", () => {
  const policy = defaultRepoConfigPolicy();

  it("validates cleanly — no key-not-allowed, no 'no validator' warning", () => {
    const { layer: sanitized, warnings } = sanitizeRepoConfigLayer(
      { crons: { enable: ["security-scan"], disable: ["repo-health"] } },
      policy,
      base(),
      "acme/widget",
    );

    expect(warnings).toEqual([]);
    // Accepted, but not merged: cron participation is read off the RAW layer by
    // the scheduler (`src/cron/repo-crons.ts`) at tick time, before any run
    // exists, so it is deliberately absent from the merged per-run shape.
    expect(sanitized).toEqual({});
  });

  it("still validates cleanly alongside keys that DO merge", () => {
    const { layer: sanitized, warnings } = sanitizeRepoConfigLayer(
      { crons: { disable: ["repo-health"] }, models: { triage: "openai/gpt-5.5" } },
      policy,
      base(),
      "acme/widget",
    );

    expect(warnings).toEqual([]);
    expect(sanitized).toEqual({ models: { triage: "openai/gpt-5.5" } });
  });

  it("resolves to the inherited config with no warnings and no `crons` leaf", () => {
    const resolved = resolveRepoConfig(base(), policy, layer({ crons: { enable: ["security-scan"] } }));

    expect(resolved.warnings).toEqual([]);
    expect(resolved.merged.disabled.crons).toEqual([]);
    expect(resolved.merged).not.toHaveProperty("crons");
  });

  it("is dropped with a warning when an operator narrows `crons` out of allowKeys", () => {
    // The documented kill switch: removing `crons` makes the operator's own
    // cron block un-overridable, and the repo is told why.
    const narrowed = { ...policy, allowKeys: policy.allowKeys.filter((k) => k !== "crons") };
    const { warnings } = sanitizeRepoConfigLayer({ crons: { enable: ["security-scan"] } }, narrowed, base());

    expect(warnings.map((w) => w.code)).toEqual(["key-not-allowed"]);
  });
});

describe("a repo's notifications: block", () => {
  const policy = defaultRepoConfigPolicy();

  /** The base a real deployment provides — `notifications` present, channel null. */
  function notifyBase(): RepoConfigBase {
    const b = base();
    (b.value as Record<string, unknown>).notifications = { slack: { channel: null } };
    (b.sources as Record<string, unknown>).notifications = { slack: { channel: "default" } };
    return b;
  }

  it("accepts a channel id and tags the leaf `repo`", () => {
    const resolved = resolveRepoConfig(
      notifyBase(),
      policy,
      layer({ notifications: { slack: { channel: "C01ABCDEFGH" } } }),
    );

    expect(resolved.warnings).toEqual([]);
    expect(resolved.merged.notifications.slack.channel).toBe("C01ABCDEFGH");
    expect(resolved.sources.notifications["slack.channel"]).toBe("repo");
  });

  it("accepts a #channel-name", () => {
    const resolved = resolveRepoConfig(
      notifyBase(),
      policy,
      layer({ notifications: { slack: { channel: "#eng-widgets" } } }),
    );
    expect(resolved.warnings).toEqual([]);
    expect(resolved.merged.notifications.slack.channel).toBe("#eng-widgets");
  });

  it("keeps an explicit null AND tags it `repo` — the opt-out signal", () => {
    // The channel resolver reads that provenance to tell "send me nothing"
    // apart from "I said nothing". A merged null alone cannot express it.
    const resolved = resolveRepoConfig(
      notifyBase(),
      policy,
      layer({ notifications: { slack: { channel: null } } }),
    );

    expect(resolved.warnings).toEqual([]);
    expect(resolved.merged.notifications.slack.channel).toBeNull();
    expect(resolved.sources.notifications["slack.channel"]).toBe("repo");
  });

  it("drops a channel that is not a plausible reference", () => {
    for (const bad of ["has spaces", "a".repeat(81), 42, {}, ["C1"]]) {
      const { layer: sanitized, warnings } = sanitizeRepoConfigLayer(
        { notifications: { slack: { channel: bad } } },
        policy,
        notifyBase(),
        "acme/widget",
      );
      expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
      expect(sanitized).toEqual({});
    }
  });

  it("drops an unknown notification target and an unknown slack leaf", () => {
    const discord = sanitizeRepoConfigLayer(
      { notifications: { discord: { channel: "x" } } },
      policy,
      notifyBase(),
    );
    expect(discord.warnings.map((w) => w.path)).toEqual(["notifications.discord"]);

    const leaf = sanitizeRepoConfigLayer(
      { notifications: { slack: { mentionOnFailure: true } } },
      policy,
      notifyBase(),
    );
    expect(leaf.warnings.map((w) => w.path)).toEqual(["notifications.slack.mentionOnFailure"]);
  });

  it("is dropped with a warning when an operator narrows it out of allowKeys", () => {
    // The kill switch: an operator who wants channel choice back removes
    // `notifications`, and the repo is told why rather than silently ignored.
    const narrowed = { ...policy, allowKeys: policy.allowKeys.filter((k) => k !== "notifications") };
    const { warnings } = sanitizeRepoConfigLayer(
      { notifications: { slack: { channel: "C01ABCDEFGH" } } },
      narrowed,
      notifyBase(),
    );

    expect(warnings.map((w) => w.code)).toEqual(["key-not-allowed"]);
  });

  it("resolves to the operator's value when the repo says nothing", () => {
    const resolved = resolveRepoConfig(notifyBase(), policy, layer({}));
    expect(resolved.merged.notifications.slack.channel).toBeNull();
    expect(resolved.sources.notifications["slack.channel"]).toBe("default");
  });
});

describe("layer merge", () => {
  it("is the same function core's config-resolve exports — one definition", () => {
    // The repo layer must merge byte-for-byte the way default/overlay/env do,
    // or a repo could acquire precedence the operator's layers don't have.
    // Identity is the only assertion that can't drift.
    expect(coreMergeLayer).toBe(mergeLayer);
  });

  it("deep-merges plain objects and replaces arrays/scalars wholesale", () => {
    const value: Record<string, unknown> = { models: { default: "a", triage: "b" }, list: [1, 2], flag: true };
    const sources: Record<string, unknown> = { models: { default: "default", triage: "default" }, list: "default", flag: "default" };
    coreMergeLayer(value, sources, { models: { triage: "c" }, list: [3], flag: false }, "repo");

    expect(value).toEqual({ models: { default: "a", triage: "c" }, list: [3], flag: false });
    expect(sources).toEqual({
      models: { default: "default", triage: "repo" },
      list: "repo",
      flag: "repo",
    });
  });
});
