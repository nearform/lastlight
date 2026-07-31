/**
 * Per-repository config layer (issue #180) — the eval harness's wiring.
 *
 * A managed repo may commit a `.lastlight/` directory that overrides a bounded
 * subset of config for runs against THAT repo: `lastlight.yml`,
 * `workflows/prompts/*.md`, `skills/<name>/SKILL.md`, `agent-context/*.md`. It
 * is always read from the repo's default branch — never a PR head — which is the
 * whole security model.
 *
 * This module is the eval-side half of that feature. It does NOT re-implement
 * any of it: a case declares a fixture tree on disk, `fake-github.ts` serves it
 * through the `fetchRepoConfigTree` seam, and core's OWN dispatch-time resolver
 * (`resolveRepoRunConfig` → `fetchRepoLayer` → `sanitizeRepoFiles` → unpack →
 * `resolveRepoConfig`) runs against it unmodified. The resulting `RunRepoConfig`
 * goes to `runWorkflow`'s repo-config argument exactly as `dispatchWorkflow`
 * passes it in production, so the layer reaches the agent through the real
 * per-run asset resolver — prompts, skills and agent-context included.
 *
 * ── How a case declares a layer ───────────────────────────────────────────
 * Drop the tree at `<datasetDir>/lastlight/<instance_id>/`, laid out exactly as
 * the repo would commit it under `.lastlight/`:
 *
 *   datasets/repo-config/lastlight/repoconfig__prompt-override/
 *     lastlight.yml
 *     workflows/prompts/answer.md
 *     agent-context/repo-notes.md
 *
 * No instance field, no code change — presence of the directory IS the
 * declaration, mirroring the `repos/<id>/`, `tests/<id>/` and `context/<id>/`
 * conventions. A case with no such directory gets `status: "absent"` from the
 * mock and therefore no layer at all, which is every pre-existing eval case.
 *
 * Core coupling goes through the `lastlight-core/evals` barrel like every other
 * file here — never a deep `lastlight-core/dist/...` path, even though core's
 * `exports` map would resolve one. `invalidateRepoLayer` is part of that surface
 * because the layer fetch is cached per repo with a ~60s TTL: an A/B across two
 * arms in one process would otherwise silently reuse the first arm's layer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  invalidateRepoLayer,
  resolveRepoRunConfig,
  type RepoRunConfigOptions,
  type RunRepoConfig,
} from "lastlight-core/evals";

import type { RepoConfigSeedFile } from "./fake-github.js";

export type { RunRepoConfig };

/** The client seam `fetchRepoLayer` reads a layer through. `FakeGitHub` satisfies it. */
export type RepoConfigClient = NonNullable<RepoRunConfigOptions["client"]>;

/** The boot config a repo layer merges onto (core's `RepoConfigBase`). */
type RepoConfigBase = NonNullable<RepoRunConfigOptions["base"]>;

/** Dataset subdirectory holding per-instance `.lastlight/` fixture trees. */
export const REPO_CONFIG_FIXTURE_DIR = "lastlight";

/**
 * Read a case's `.lastlight/` fixture from `<datasetDir>/lastlight/<id>/`.
 *
 * Returns `undefined` when there is no fixture — the mock then reports the repo
 * as having no layer at all, which must stay the zero-cost default: every tier
 * that predates this feature relies on it.
 *
 * Everything under the directory is seeded verbatim, including files the
 * sanitizer will reject (a stray `workflows/x.yaml`, an out-of-bounds key), so a
 * case can measure the REJECTION path as well as the happy one. Symlinks are the
 * one exception: they're seeded as git's symlink mode rather than followed, both
 * because that's what the tree API would report and because following one would
 * let a fixture read outside the dataset.
 */
export function loadRepoConfigFixture(
  datasetDir: string | undefined,
  instanceId: string,
): RepoConfigSeedFile[] | undefined {
  if (!datasetDir) return undefined;
  const root = join(datasetDir, REPO_CONFIG_FIXTURE_DIR, instanceId);
  if (!existsSync(root) || !statSync(root).isDirectory()) return undefined;

  const files: RepoConfigSeedFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        files.push({ path: rel, mode: "120000", content: "" });
      } else if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        files.push({ path: rel, content: readFileSync(abs) });
      }
    }
  };
  walk(root, "");
  return files;
}

export interface EvalRepoConfigOptions {
  /** `owner/repo` the layer belongs to (the instance's `repo`). */
  repo: string;
  /** Workflow being dispatched — the repo's `disabled.workflows` is checked against it. */
  workflowName: string;
  /** The seam the layer is fetched through (the run's `FakeGitHub`). */
  client: RepoConfigClient;
  /** The run's effective per-task model map (a `config` arm's merged config). */
  models?: Record<string, string>;
  /** The run's effective per-task variant map. */
  variants?: Record<string, string | undefined>;
  /** The arm's executor model — the `models.default` a repo layer merges onto. */
  defaultModel: string;
  /** Where the fetched layer is unpacked. Per-run (under the run's temp state dir). */
  cacheRoot: string;
}

/**
 * Resolve the run's repo layer, or `{}` when none applies.
 *
 * Thin by design — the interesting parts (bounds, merge, provenance, warnings)
 * all happen inside `resolveRepoRunConfig`. What this adds is the two things
 * core reads from boot state that an out-of-process harness has to supply:
 *
 *  - the **base config** the layer merges onto. Core builds one from the loaded
 *    runtime config; the eval never loads one, so we project the ARM's model
 *    selection into the same shape. That keeps `repoConfig.models` — which
 *    `runWorkflow` prefers over the `models` argument once a layer exists —
 *    equal to what the arm would have produced, so a layer that doesn't set
 *    `models:` leaves the comparison axis untouched. (A fixture that DOES set
 *    `models:` overrides the arm for that case. Production-faithful, and
 *    occasionally the point, but it makes the case's model column a lie about
 *    the arm — so only do it deliberately.)
 *  - a per-run **cache root**, so the unpacked tree lands in the run's temp
 *    state dir instead of `./data/repo-config`.
 *
 * The in-memory layer cache is dropped for this repo first: it is a module
 * global with a 60s TTL keyed on `owner/repo`, which is right for a long-lived
 * harness and wrong for a batch of independent cases that may reuse a repo name
 * across arms and trials.
 */
export async function resolveEvalRepoConfig(
  opts: EvalRepoConfigOptions,
): Promise<{ repoConfig?: RunRepoConfig; refusal?: string }> {
  const base: RepoConfigBase = {
    value: {
      models: { default: opts.defaultModel, ...(opts.models ?? {}) },
      // Core's `VariantConfig` allows an explicitly-unset key; the merge shape
      // takes plain strings, so drop the holes rather than merging `undefined`.
      variants: Object.fromEntries(Object.entries(opts.variants ?? {}).filter(([, v]) => typeof v === "string")),
      disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
      // Empty, matching the eval's empty `approvalConfig`: the repo layer is
      // add-only, so a fixture can raise a gate but never clear one — and with
      // no `db` a raised gate is inert anyway (gates need a db to pause on).
      approval: {},
    },
    sources: { models: {}, variants: {}, disabled: {}, approval: {} },
  };

  invalidateRepoLayer(opts.repo);
  return resolveRepoRunConfig(
    opts.workflowName,
    { repo: opts.repo },
    { client: opts.client, base, cacheRoot: opts.cacheRoot },
  );
}

/**
 * The dotted config paths the repo layer actually WON, from the resolved
 * provenance tree. Recorded on the result so a scorecard row says which leaves
 * came from the repo rather than the operator — the same "applied" projection
 * production persists on `workflow_runs.context.repoConfig`.
 */
export function appliedRepoConfigKeys(cfg: RunRepoConfig): string[] {
  const out: string[] = [];
  for (const [group, leaves] of Object.entries(cfg.sources)) {
    for (const [leaf, source] of Object.entries(leaves as Record<string, string>)) {
      if (source === "repo") out.push(`${group}.${leaf}`);
    }
  }
  return out.sort();
}
