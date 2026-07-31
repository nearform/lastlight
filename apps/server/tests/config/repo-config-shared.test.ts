import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
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

/** `repoConfig.allowKeys` as the shipped deployment config actually declares it. */
function defaultYamlAllowKeys(): string[] {
  const path = fileURLToPath(new URL("../../config/default.yaml", import.meta.url));
  const parsed = parseYaml(readFileSync(path, "utf-8")) as {
    repoConfig?: { allowKeys?: string[] };
  };
  return parsed.repoConfig?.allowKeys ?? [];
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

  it("is the same constant core re-exports — one definition, not two", () => {
    expect(CORE_ALLOW_KEYS).toBe(DEFAULT_REPO_CONFIG_ALLOW_KEYS);
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
