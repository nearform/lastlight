import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { ExecutorConfig } from "../engine/github/profiles.js";
import type { StateDb, WorkflowRun, TriggerActorType } from "../state/db.js";
import type { DisabledConfig } from "lastlight-shared/config-types";
import {
  getBotName,
  getRuntimeConfig,
  type ModelConfig,
  type RepoConfigPolicy,
  type VariantConfig,
} from "../config/config.js";
import type { ConfigSource } from "../config/config-resolve.js";
import type { GitHubClient } from "../engine/github/github.js";
import {
  fetchRepoLayer,
  getCachedRepoLayer,
  repoConfigBaseFromRuntime,
  repoConfigPolicy,
  resolveRepoConfig,
  type RepoConfigBase,
  type RepoConfigSources,
  type RepoConfigWarning,
  type RepoLayer,
} from "../config/repo-config.js";
import { reapSandboxWorkspace } from "../sandbox/reap.js";
import { artifactStore } from "../sandbox/artifact-store.js";
import { getWorkflow } from "./loader.js";
import {
  runWorkflow,
  type ApprovalGateConfig,
  type RunnerCallbacks,
  type WorkflowResult,
} from "./runner.js";
import { PhaseRef } from "./phase-ref.js";
import { K8S_SANITY_FUSE } from "./admission.js";
import type { TemplateContext } from "./templates.js";
import { slugify } from "./templates.js";
import { wrapUntrusted } from "../engine/screen/screen.js";
import { buildProgressModel, runDashboardUrl } from "../notify/model.js";
import { buildAssetIssueKey } from "../state/build-assets.js";
import {
  PER_TARGET_REUSE_WORKFLOWS,
  PER_TARGET_RECREATE_WORKFLOWS,
  PREPOPULATE_SYNTH_WORKFLOWS,
  PR_HEADREF_PREPOPULATE_WORKFLOWS,
  PR_FIX_SHAPED_WORKFLOWS,
} from "./target-policy.js";

// ---------------------------------------------------------------------------
// Per-repository config layer (issue #180)
// ---------------------------------------------------------------------------

/**
 * A managed repo's `.lastlight/` layer, already merged onto the boot config and
 * frozen for the duration of ONE run.
 *
 * Resolved once at the dispatch choke point (`resolveRepoRunConfig`, driven from
 * `dispatchWorkflow` in src/index.ts) and then carried explicitly through the
 * run — never installed into a module global. Up to `concurrency.maxWorkflows`
 * runs plus a cron fan-out across every managed repo are in flight at once, so a
 * global would race and hand repo B's model override to repo A's run.
 *
 * `models` / `variants` / `approval` are the EFFECTIVE maps (base ⊕ repo), not
 * the repo's deltas, so every consumer can use them as a drop-in replacement for
 * the boot config's maps. The deltas are recoverable from {@link sources}.
 */
export interface RunRepoConfig {
  /** `owner/repo` the layer was read from. */
  repo: string;
  /** The ref the layer was read from — always the repo's default branch. */
  defaultBranch: string;
  /** Git tree SHA of `.lastlight/` — the content identity of these values. */
  treeSha: string;
  /** ISO timestamp of the last successful download of the layer. */
  fetchedAt: string;
  /**
   * Absolute host path of the unpacked layer, when the repo contributed assets
   * AND the operator allows them. Undefined otherwise — the run then keeps the
   * module-level (built-in + overlay) asset resolver untouched.
   */
  assetRoot?: string;
  /** Asset paths the repo contributed, relative to {@link assetRoot}. */
  assets: string[];
  /** Effective per-task model map. */
  models: ModelConfig;
  /** Effective per-task reasoning-effort map. */
  variants: VariantConfig;
  /** Effective approval gates. Add-only: the repo can raise a gate, never clear one. */
  approval: Record<string, boolean>;
  /** Effective disables. `workflows` is enforced at dispatch (see below). */
  disabled: DisabledConfig;
  /** Per-leaf provenance — which layer won each key (`default`/`overlay`/`env`/`repo`). */
  sources: RepoConfigSources;
  /** Everything the layer dropped, fetching + validating. Never thrown. */
  warnings: RepoConfigWarning[];
}

/** Options for {@link resolveRepoRunConfig}. */
export interface RepoRunConfigOptions {
  /**
   * GitHub client to fetch through. `null` means chat-only mode (no App, no
   * PAT) — there is nothing to fetch through, so the layer is skipped entirely.
   * Omitted means "let `fetchRepoLayer` resolve the harness client itself".
   */
  client?: GitHubClient | null;
  /** Operator bounds. Defaults to the boot config's `repoConfig` block. */
  policy?: RepoConfigPolicy;
  /** Config the layer merges onto. Defaults to the boot runtime config. */
  base?: RepoConfigBase;
  /** Cache root override, forwarded to `fetchRepoLayer` (tests). */
  cacheRoot?: string;
}

/** Result of {@link resolveRepoRunConfig}. */
export interface RepoRunConfigResult {
  /** Present only when a repo layer actually applies to this dispatch. */
  repoConfig?: RunRepoConfig;
  /**
   * Set when the repo's own `disabled.workflows` refuses this workflow. The
   * caller must abandon the dispatch — no `workflow_runs` row, no agent call.
   */
  refusal?: string;
}

/**
 * The single repo a dispatch context names, or `undefined` for none/many.
 *
 * A repo layer is per-REPO, so it is only meaningful when the run acts on
 * exactly one: a repo-less Slack explore has nothing to read, and a multi-repo
 * context (a cron fan-out envelope that hasn't been split yet) would have to
 * pick a winner — silently applying one repo's model override to a run that
 * touches another is worse than applying none.
 */
export function soleRepoInContext(context: { repo?: unknown; repos?: unknown }): string | undefined {
  const refs = new Set<string>();
  if (typeof context.repo === "string" && context.repo) refs.add(context.repo);
  if (Array.isArray(context.repos)) {
    for (const r of context.repos) if (typeof r === "string" && r) refs.add(r);
  }
  return refs.size === 1 ? [...refs][0] : undefined;
}

/**
 * Resolve a dispatch's per-repository config layer (issue #180).
 *
 * Called from the `dispatchWorkflow` choke point in `src/index.ts`, right beside
 * the unmanaged-repo guard, so every trigger path — webhook, router, cron, the
 * direct `/api/run` + `/api/build` triggers, approval resume — gets the same
 * answer from one place.
 *
 * **Never throws and never fails a run.** Every degenerate case (feature off, no
 * repo, several repos, chat-only mode, a GitHub outage, a malformed
 * `lastlight.yml`) returns "no layer applies" or a layer with warnings attached,
 * and the run proceeds on the un-overridden operator config. The one refusal it
 * CAN return is the repo's own `disabled.workflows` — the repo opting itself out
 * of a workflow, which is a deliberate answer rather than a failure.
 */
export async function resolveRepoRunConfig(
  workflowName: string,
  context: { repo?: unknown; repos?: unknown },
  options: RepoRunConfigOptions = {},
): Promise<RepoRunConfigResult> {
  const policy = options.policy ?? repoConfigPolicy();
  if (!policy.enabled) return {};
  // Chat-only mode: no App and no PAT, so there is no client to read the
  // default branch through. Skip rather than serve a possibly-stale disk cache.
  if (options.client === null) return {};

  const repo = soleRepoInContext(context);
  if (!repo) return {};

  const runtime = getRuntimeConfig();
  const base = options.base ?? (runtime ? repoConfigBaseFromRuntime(runtime) : undefined);
  // No boot config (unit tests, pre-boot paths) means no base to merge onto.
  if (!base) return {};

  let layer;
  try {
    layer = await fetchRepoLayer(repo, {
      client: options.client ?? undefined,
      policy,
      cacheRoot: options.cacheRoot,
    });
  } catch (err: unknown) {
    // `fetchRepoLayer` is documented never to reject; this is the belt to its
    // braces. A repo config problem must never be the thing that fails a run.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[repo-config] ${repo}: layer resolution failed (${msg}) — running with the operator config`);
    return {};
  }
  if (!layer) return {};

  const resolved = resolveRepoConfig(base, policy, layer);
  for (const warning of resolved.warnings) {
    console.warn(`[repo-config] ${repo}: ${warning.message}`);
  }

  // The repo opting ITSELF out of a workflow. Enforced here, next to the
  // unmanaged-repo guard, so every dispatch path honours it — including the
  // direct CLI/API triggers that bypass the connector/router ingress filters.
  if (resolved.merged.disabled.workflows.includes(workflowName)) {
    return {
      refusal:
        `${repo} disables the "${workflowName}" workflow in .lastlight/lastlight.yml ` +
        `(disabled.workflows, read from ${layer.defaultBranch}@${layer.treeSha.slice(0, 7)})`,
    };
  }

  const hasAssets = policy.allowAssets && layer.assets.length > 0;
  return {
    repoConfig: {
      repo,
      defaultBranch: layer.defaultBranch,
      treeSha: layer.treeSha,
      fetchedAt: layer.fetchedAt,
      assetRoot: hasAssets ? layer.root : undefined,
      assets: hasAssets ? [...layer.assets] : [],
      // The merge only ever ADDS keys on top of the boot config, so the
      // `default` entry `ModelConfig` requires is still there — the resolver
      // just types its output as a plain string map.
      models: resolved.merged.models as ModelConfig,
      variants: resolved.merged.variants,
      approval: resolved.merged.approval,
      disabled: resolved.merged.disabled,
      sources: resolved.sources,
      warnings: resolved.warnings,
    },
  };
}

/**
 * The JSON projection of a {@link RunRepoConfig} persisted on
 * `workflow_runs.context.repoConfig`, so a specific run stays explainable long
 * after the TTL cache has moved on.
 *
 * `applied` holds ONLY the leaves the repo actually won (provenance `repo`) —
 * the effective full maps are already on `context.models` / `context.variants`,
 * and a diff of the two is exactly what the dashboard wants to render.
 */
export interface RepoConfigRunRecord {
  repo: string;
  defaultBranch: string;
  treeSha: string;
  fetchedAt: string;
  applied: {
    models?: Record<string, string>;
    variants?: Record<string, string>;
    approval?: Record<string, boolean>;
    disabled?: Partial<Record<keyof DisabledConfig, string[]>>;
  };
  assets: string[];
  warnings: RepoConfigWarning[];
}

/** Project a {@link RunRepoConfig} into its persisted form. */
export function repoConfigRunRecord(cfg: RunRepoConfig): RepoConfigRunRecord {
  const wonBy = <T>(
    values: Record<string, T | undefined>,
    sources: Record<string, ConfigSource>,
  ): Record<string, T> | undefined => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(values)) {
      if (sources[key] === "repo" && value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const disabled: Partial<Record<keyof DisabledConfig, string[]>> = {};
  for (const key of Object.keys(cfg.disabled) as Array<keyof DisabledConfig>) {
    if (cfg.sources.disabled[key] === "repo") disabled[key] = cfg.disabled[key];
  }

  return {
    repo: cfg.repo,
    defaultBranch: cfg.defaultBranch,
    treeSha: cfg.treeSha,
    fetchedAt: cfg.fetchedAt,
    applied: {
      models: wonBy(cfg.models, cfg.sources.models),
      variants: wonBy(cfg.variants, cfg.sources.variants),
      approval: wonBy(cfg.approval, cfg.sources.approval),
      disabled: Object.keys(disabled).length > 0 ? disabled : undefined,
    },
    assets: cfg.assets,
    warnings: cfg.warnings,
  };
}

/** Result of {@link restoreRepoRunConfig}. */
export interface RestoredRepoConfig {
  /** The layer as the original dispatch resolved it, minus anything unrecoverable. */
  repoConfig: RunRepoConfig;
  /**
   * Set when the repo's ASSET layer could not be restored (see
   * {@link restoreRepoRunConfig}). The run still proceeds — on the operator's
   * prompts/skills/agent-context — and the caller is expected to record this
   * where the run is explained.
   */
  warning?: RepoConfigWarning;
}

/** Options for {@link restoreRepoRunConfig}. */
export interface RestoreRepoRunConfigOptions {
  /** Effective maps to re-apply the repo's leaves onto. Normally the run's own
   *  persisted `context.models` / `context.variants`; the operator's boot maps
   *  for a row written before those were stored. */
  models?: ModelConfig;
  variants?: VariantConfig;
  approval?: Record<string, boolean>;
  disabled?: DisabledConfig;
  /** Layer lookup seam (tests). Defaults to the cache, then one conditional refetch. */
  resolveLayer?: (repo: string) => Promise<RepoLayer | undefined>;
}

const EMPTY_DISABLED: DisabledConfig = {
  workflows: [],
  crons: [],
  prompts: [],
  skills: [],
  agentContext: [],
};

/**
 * The unpacked `.lastlight/` tree for `repo` **at the exact tree sha a run
 * recorded**, or undefined.
 *
 * Content identity is the whole point: a repo's default branch moves, and the
 * layer cache is a TTL/eviction cache, so "the layer for this repo" today is not
 * necessarily the layer the run started under. Only an exact `treeSha` match
 * (with the unpacked files still on disk) is accepted; anything else is a
 * different config and the caller degrades rather than silently swapping it in.
 * The refetch is the cheap conditional one — a 304 just re-hydrates from disk.
 */
async function repoLayerForTree(
  repo: string,
  treeSha: string,
  resolveLayer?: (repo: string) => Promise<RepoLayer | undefined>,
): Promise<RepoLayer | undefined> {
  const usable = (layer?: RepoLayer): RepoLayer | undefined =>
    layer && layer.treeSha === treeSha && existsSync(layer.root) ? layer : undefined;
  try {
    if (resolveLayer) return usable(await resolveLayer(repo));
    return usable(getCachedRepoLayer(repo)) ?? usable(await fetchRepoLayer(repo));
  } catch (err: unknown) {
    // `fetchRepoLayer` is documented never to reject; belt to its braces. A
    // resume must never die because a repo's config couldn't be re-read.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[repo-config] ${repo}: could not restore the cached layer (${msg})`);
    return undefined;
  }
}

/**
 * Rebuild a {@link RunRepoConfig} from the {@link RepoConfigRunRecord} persisted
 * on a run row — the inverse of {@link repoConfigRunRecord}, used when
 * *continuing* a run rather than starting one (`resume.ts`).
 *
 * Why restore instead of re-resolving: a resume (boot orphan recovery, the
 * dashboard's Retry, an admission promotion) is a continuation of a run that
 * already executed phases under a specific config. Re-reading `.lastlight/` from
 * the repo's default branch would let an edit made while the run was
 * paused/queued/dead retarget it mid-flight — half the phases on one model, half
 * on another. The record holds everything needed for a faithful continuation and
 * needs no network.
 *
 * Two things are NOT in the record, by design:
 *  - **The unpacked asset root.** It's a cache path with its own lifetime, so it
 *    is recovered by content identity ({@link repoLayerForTree}) and dropped —
 *    with a warning — when the tree the run used is gone. Prompts/skills/agent
 *    context then come from the operator's layers: a degraded run, never a
 *    crashed one, and never a *different* repo config.
 *  - **Per-leaf provenance for the leaves the repo did NOT win.** `applied` only
 *    records the repo's own leaves, so the restored `sources` marks those `repo`
 *    and everything else `default`. Nothing on the resume path reads `sources`
 *    (it exists to build a record, which a resume never re-derives), so the
 *    approximation stays inside this type.
 */
export async function restoreRepoRunConfig(
  record: RepoConfigRunRecord,
  options: RestoreRepoRunConfigOptions = {},
): Promise<RestoredRepoConfig> {
  const applied = record.applied ?? {};
  // Re-applying the repo's leaves is idempotent when `options.models` is the
  // run's own persisted EFFECTIVE map (it already contains them); it matters for
  // an older row that only has the operator's maps to offer.
  const models = { ...(options.models ?? {}), ...(applied.models ?? {}) } as ModelConfig;
  const variants: VariantConfig = { ...(options.variants ?? {}), ...(applied.variants ?? {}) };
  // Approval is add-only for a repo layer (enforced at resolve time), so the
  // repo's raised gates over the operator's CURRENT map reproduces the original
  // effective map — and a gate the operator has since raised still applies.
  const approval = { ...(options.approval ?? {}), ...(applied.approval ?? {}) };
  const disabled: DisabledConfig = {
    ...EMPTY_DISABLED,
    ...(options.disabled ?? {}),
    ...(applied.disabled ?? {}),
  };

  const sourcesOf = (values: Record<string, unknown>, won?: Record<string, unknown>): Record<string, ConfigSource> => {
    const out: Record<string, ConfigSource> = {};
    for (const key of Object.keys(values)) out[key] = won && key in won ? "repo" : "default";
    return out;
  };
  const disabledSources = Object.fromEntries(
    (Object.keys(EMPTY_DISABLED) as Array<keyof DisabledConfig>).map((key) => [
      key,
      applied.disabled && key in applied.disabled ? "repo" : "default",
    ]),
  ) as Record<keyof DisabledConfig, ConfigSource>;

  let assetRoot: string | undefined;
  let warning: RepoConfigWarning | undefined;
  if (record.assets.length > 0) {
    const layer = await repoLayerForTree(record.repo, record.treeSha, options.resolveLayer);
    assetRoot = layer?.root;
    if (!assetRoot) {
      warning = {
        code: "fetch-failed",
        repo: record.repo,
        path: ".lastlight",
        message:
          `The .lastlight/ assets this run started with (tree ${record.treeSha.slice(0, 7)}) are no longer ` +
          `available — the default branch has moved on, or the cache was evicted. The rest of the run used ` +
          `the operator's prompts, skills and agent context.`,
      };
      console.warn(`[repo-config] ${record.repo}: ${warning.message}`);
    }
  }

  return {
    repoConfig: {
      repo: record.repo,
      defaultBranch: record.defaultBranch,
      treeSha: record.treeSha,
      fetchedAt: record.fetchedAt,
      assetRoot,
      // The paths the repo contributed stay on the record even when the tree is
      // gone — they describe what the run USED, which is the question anyone
      // reading a resumed run's provenance is asking.
      assets: record.assets,
      models,
      variants,
      approval,
      disabled,
      sources: {
        models: sourcesOf(models, applied.models),
        variants: sourcesOf(variants, applied.variants),
        disabled: disabledSources,
        approval: sourcesOf(approval, applied.approval),
      },
      // The original fetch/merge warnings, plus this restore's own if it dropped
      // the asset layer — so a resumed run explains itself as fully as the first.
      warnings: warning ? [...record.warnings, warning] : record.warnings,
    },
    warning,
  };
}

/**
 * Lightweight invocation request for any agent workflow. The runner handles
 * all phase-level logic generically, so this single entry point covers
 * everything from single-phase triage skills to the full multi-phase build
 * cycle — including resume, approval gates, and the paused/approved/rejected
 * dance after a human responds to an approval.
 */
export interface SimpleWorkflowRequest {
  owner: string;
  repo: string;
  /** Optional — populated for issue-scoped workflows */
  issueNumber?: number;
  /** Optional — populated for PR-scoped workflows */
  prNumber?: number;
  /** Issue title (best-effort, may be empty for repo-scoped workflows) */
  issueTitle?: string;
  /** Issue body (best-effort) */
  issueBody?: string;
  /** Labels currently on the issue/PR */
  issueLabels?: string[];
  /** The triggering comment body, if applicable */
  commentBody?: string;
  /** Originating user (or "cli" / "cron" etc.) */
  sender: string;
  /**
   * Actor logging (issue #205): who triggered this run and how, persisted on
   * the `workflow_runs` row for the dashboard's "Triggered by". Defaults to
   * `sender` / undefined when the dispatch layer doesn't supply them.
   */
  triggeredBy?: string;
  triggerActorType?: TriggerActorType;
  /**
   * Explicit trigger id override. Slack-initiated workflows pass a
   * `slack:{teamId}:{channel}:{threadTs}` string here so pause/resume uses
   * the Slack thread as the stable key. When unset, the trigger id is
   * derived from owner/repo/issueNumber as usual.
   */
  triggerId?: string;
  /**
   * Extra context to merge into the template context. Use this for
   * workflow-specific args like { mode: "scan" } from cron jobs, or the
   * pr-fix workflow's failedChecks/branch/prNumber payload.
   */
  extra?: Record<string, unknown>;
  /**
   * When set, the harness pre-clones the repo at this branch into the
   * sandbox workspace before the agent starts. Used by pr-review /
   * pr-fix so the agent enters a workspace already checked out at the
   * PR's head ref — saves a redundant `clone_repo` call inside the
   * session.
   */
  prePopulateBranch?: string;
  /**
   * The target repo's own `.lastlight/` layer, already merged onto the boot
   * config by {@link resolveRepoRunConfig} at the dispatch choke point (issue
   * #180). Absent ⇒ no layer applies and the run behaves exactly as it did
   * before the feature existed.
   */
  repoConfig?: RunRepoConfig;
}

// Per-target workspace provisioning policy lives in `./target-policy.js` (a
// leaf module the runner can share without an import cycle). Imported at the
// top for local use; re-exported here for existing callers (e.g. src/index.ts
// imports PR_HEADREF_PREPOPULATE_WORKFLOWS).
export {
  PER_TARGET_REUSE_WORKFLOWS,
  PER_TARGET_RECREATE_WORKFLOWS,
  PREPOPULATE_SYNTH_WORKFLOWS,
  PR_HEADREF_PREPOPULATE_WORKFLOWS,
  PR_FIX_SHAPED_WORKFLOWS,
};

export function workflowScopedTaskId(
  repo: string,
  number: number | undefined,
  workflowName: string,
  workflowId: string,
): string {
  // Reusable / recreatable per-target workspaces are keyed by (repo, issue)
  // only — no run suffix — so a re-run lands on the same dir (reused for
  // pr-review/pr-fix, recreated-from-base for build; see the two sets above).
  if (
    number !== undefined &&
    (PER_TARGET_REUSE_WORKFLOWS.has(workflowName) ||
      PER_TARGET_RECREATE_WORKFLOWS.has(workflowName))
  ) {
    return `${repo}-${number}-${workflowName}`;
  }
  const suffix = workflowId.slice(0, 8);
  return number !== undefined
    ? `${repo}-${number}-${workflowName}-${suffix}`
    : `${repo}-${workflowName}-${suffix}`;
}

/**
 * Reap the sandbox workspace of a run that just finished **successfully**
 * (issue #106). Only ephemeral per-run workspaces are removed here: the
 * reusable per-target ones (`PER_TARGET_REUSE_WORKFLOWS` /
 * `PER_TARGET_RECREATE_WORKFLOWS`) are a warm cache (issue #107) whose eviction
 * is owned by the backstop TTL/LRU sweep, so re-review fanout keeps its warm
 * `node_modules`. Failures are left for the sweep too (post-mortem debugging).
 * Best-effort — never throws into the already-succeeded run.
 *
 * Also GCs the run's `.lastlight/` artifact-store namespace (Plan 8), but
 * ONLY when the workspace dir was actually removed above — this runs well
 * after `post-review` (the run has already finished), and the reuse/recreate
 * early-return above means a per-target run (pr-review, pr-fix, build) skips
 * gc here too, exactly like it skips the workspace reap: those artifacts stay
 * on disk as part of the same warm cache. For the local backend this is
 * redundant with the `rmSync` above (both remove the same on-disk tree); the
 * real payoff is a future S3 backend, where `gc` is the only thing that
 * reaches the remote objects.
 */
export function reapOnSuccess(workflowName: string, taskId: string, config: ExecutorConfig): void {
  const rt = getRuntimeConfig();
  if (rt?.cleanup?.sandbox?.reapOnCompletion === false) return;
  if (PER_TARGET_REUSE_WORKFLOWS.has(workflowName) || PER_TARGET_RECREATE_WORKFLOWS.has(workflowName)) {
    return;
  }
  try {
    const { removed } = reapSandboxWorkspace({
      taskId,
      stateDir: config.stateDir ?? rt?.stateDir ?? "data",
      sandboxDir: config.sandboxDir ?? rt?.sandboxDir,
    });
    if (removed) {
      artifactStore.gc(taskId).catch((err: unknown) => {
        console.warn(`[reap] artifact gc failed for ${taskId}:`, err);
      });
    }
  } catch {
    /* best effort — a reap failure must not fail a successful run */
  }
}

/**
 * Resolve the `{{branch}}` template var (and the matching sandbox
 * `prePopulateBranch`) for a dispatch.
 *
 * The branch a build-style run creates and pushes is `lastlight/N-<title-slug>`,
 * derived from the issue title at **first** dispatch. Every later re-entry of the
 * same run — an approval-gate resume, a retry — comes through `runSimpleWorkflow`
 * again, but the resume event carries an **empty** issue title, so a naive
 * recompute collapses to the `lastlight/N-issue-N` fallback. That drifted name
 * is harmless for phases that `git push origin HEAD` (the persisted workspace is
 * still on the real branch) but fatal for the PR phase, whose prompt feeds
 * `{{branch}}` straight into `github_create_pull_request`'s `head` — GitHub 422s
 * because the fallback ref was never pushed.
 *
 * So when reusing an existing run we pin to the branch stored on the run row at
 * creation, mirroring `resume.ts`'s `stored.branch ?? …` precedence. `stored`
 * is `undefined` for a fresh run (no row yet).
 */
export function resolveRunBranch(args: {
  stored?: Record<string, unknown>;
  requestPrePopulateBranch?: string;
  issueNumber?: number;
  issueTitle?: string;
  workflowName: string;
}): { branch: string; prePopulateBranch: string | undefined } {
  const { stored, requestPrePopulateBranch, issueNumber, issueTitle, workflowName } = args;

  const storedBranch = typeof stored?.branch === "string" && stored.branch ? stored.branch : undefined;
  const storedPrePopulate =
    typeof stored?.prePopulateBranch === "string" && stored.prePopulateBranch
      ? stored.prePopulateBranch
      : undefined;

  const branch = storedBranch
    ?? requestPrePopulateBranch
    ?? (issueNumber !== undefined
      ? `lastlight/${issueNumber}-${slugify(issueTitle || `issue-${issueNumber}`)}`
      : `lastlight/${workflowName}`);

  // Pre-populate (clone into the sandbox, cwd = repo root) for the workflows in
  // PREPOPULATE_SYNTH_WORKFLOWS even though they synthesize a not-yet-pushed
  // branch — see that const's doc comment for why (the verify/qa-test harvest
  // fix in particular).
  const prePopulateBranch = storedPrePopulate
    ?? requestPrePopulateBranch
    ?? (PREPOPULATE_SYNTH_WORKFLOWS.has(workflowName) ? branch : undefined);

  return { branch, prePopulateBranch };
}

/**
 * The agent-facing path for a run's build-handoff docs (`{{issueDir}}`).
 *
 * Server mode on a **pre-cloned** workflow (cwd = the checkout) whose backend
 * mounts the whole workspace (docker/none/smol) relocates the docs to the
 * workspace ROOT — a sibling of the repo — reached via `../`, so the executor's
 * `git add -A` can never sweep them into the feature commit. gondolin mounts
 * only cwd, so a workspace-root sibling would be invisible/unharvestable in the
 * guest; it keeps the in-repo path and leans on the prompt-level commit gate.
 * Repo mode always keeps the in-repo path (the docs are meant to be committed).
 *
 * The orchestrator's `hostRepoDirFor` must stage/harvest in the same place; it
 * keys off `config.buildAssetsRelocated`, which simple.ts derives from the
 * `../` prefix this function produces — so the two can't disagree.
 */
export function artifactIssueDir(
  config: Pick<ExecutorConfig, "buildAssets" | "sandbox">,
  issueKey: string,
  preCloned: boolean,
): string {
  const relocate =
    config.buildAssets === "server" &&
    (config.sandbox ?? "gondolin") !== "gondolin" &&
    preCloned;
  return relocate ? `../.lastlight/${issueKey}` : `.lastlight/${issueKey}`;
}

/**
 * Run a named agent workflow against a target.
 *
 * If a workflow_run row already exists for this trigger, we reuse it and let
 * the runner's definition-driven resume pick up after the last completed
 * phase — including the paused/approved/rejected paths. Otherwise we create a
 * fresh row so the dashboard sees it immediately.
 */
export async function runSimpleWorkflow(
  workflowName: string,
  request: SimpleWorkflowRequest,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  bootstrapLabel = "lastlight:bootstrap",
  variants?: VariantConfig,
  concurrency?: { maxWorkflows: number; maxQueueWaitMs: number },
): Promise<WorkflowResult & { backpressure?: boolean }> {
  // Kill switch — if an admin has disabled this workflow in the dashboard,
  // skip every trigger source (cron, webhooks, mentions, Slack) without
  // creating a workflow_runs row. Returning success=true keeps callers
  // (router, cron tick, etc.) from treating this as an error.
  if (!db.isWorkflowEnabled(workflowName)) {
    console.log(
      `[workflow] skipped "${workflowName}" — disabled in admin dashboard`,
    );
    return { success: true, phases: [] };
  }

  const definition = getWorkflow(workflowName);
  const { owner, repo, issueNumber, prNumber } = request;
  const notify = callbacks.postComment || (async () => {});

  // ── Effective (base ⊕ repo) config for this run ────────────────────────────
  //
  // The repo layer was resolved once at dispatch (issue #180). From here down,
  // ONLY the effective maps are used — they're already the merged result, so
  // every downstream consumer (the `{{models.x}}` template chain seeded on
  // `ctx` below, the runner's PhaseResolver, the approval gate) sees one
  // consistent view without re-deriving the merge. No layer ⇒ these are the
  // caller's own maps by identity, so behaviour is unchanged.
  const repoConfig = request.repoConfig;
  const effectiveModels = repoConfig?.models ?? models;
  const effectiveVariants = repoConfig?.variants ?? variants;
  const effectiveApproval = repoConfig?.approval ?? approvalConfig;

  // Identify the trigger uniquely. Issue/PR-scoped workflows include the
  // number; repo-scoped workflows (e.g. health) just identify by repo+name;
  // Slack-initiated runs pass an explicit `slack:*` id for thread scoping.
  const number = issueNumber ?? prNumber;
  const triggerId = request.triggerId
    ?? (number !== undefined
      ? `${owner}/${repo}#${number}`
      : `${owner}/${repo}::${workflowName}`);

  // When the dispatcher passes `prePopulateBranch` (set for pr-review /
  // pr-fix from the actual PR head ref), use that as the `branch` template
  // var too — the agent's workspace is going to be checked out at that
  // ref, so the prompt should reflect reality rather than a lastlight/N-slug
  // name that doesn't exist. Build-style workflows still get the synthesized
  // lastlight/N-slug branch they create themselves.
  // `let`, not `const`: when we reuse an existing run below the resolution is
  // redone with the run's stored context so the branch can't drift off the
  // already-pushed name on resume — see `resolveRunBranch`.
  let { branch, prePopulateBranch: effectivePrePopulateBranch } = resolveRunBranch({
    requestPrePopulateBranch: request.prePopulateBranch,
    issueNumber: number,
    issueTitle: request.issueTitle,
    workflowName,
  });

  // ── Resume handling ────────────────────────────────────────────────────────
  //
  // If a workflow_run already exists for this trigger, reuse its id. The
  // runner re-runs from the top and the executions ledger (`shouldRunPhase`)
  // skips already-completed phases — no per-workflow branching needed.

  // Only reuse a workflow_run row when the existing run is still live
  // (running/paused). `getWorkflowRunByTrigger` already filters out
  // completed rows — a fresh re-trigger for a succeeded run falls through
  // to the `else` branch, creating a new workflow_run_id and a new set of
  // dedup-scoped executions.
  let workflowId: string;
  let taskId: string;
  let issueDir: string;
  const existingRun = db.runs.getByTrigger(triggerId);
  if (existingRun && existingRun.workflowName === workflowName) {
    workflowId = existingRun.id;
    const stored = (existingRun.context || {}) as Record<string, unknown>;
    taskId = (stored.taskId as string | undefined) ||
      workflowScopedTaskId(repo, number, workflowName, workflowId);
    // Recover issueDir from stored context so resumed runs use the same
    // workspace path as the original.
    issueDir = (stored.issueDir as string | undefined)
      || `.lastlight/${buildAssetIssueKey(workflowName, number, workflowId)}`;
    // Re-resolve the branch with the run's stored context. A resume event (e.g.
    // an approval response) carries an empty issue title, so the fresh
    // computation above drifts to the `lastlight/N-issue-N` fallback — but the
    // executor already pushed under the original title-slug name. Pinning to the
    // stored branch keeps every re-entered phase's `{{branch}}` correct, most
    // critically the PR phase's `head:` ref (otherwise GitHub 422s on create).
    ({ branch, prePopulateBranch: effectivePrePopulateBranch } = resolveRunBranch({
      stored,
      requestPrePopulateBranch: request.prePopulateBranch,
      issueNumber: number,
      issueTitle: request.issueTitle,
      workflowName,
    }));
    const handled = await handleExistingRun(existingRun, definition, notify, db);
    if (handled) return handled;
  } else {
    workflowId = randomUUID();
    taskId = workflowScopedTaskId(repo, number, workflowName, workflowId);
    // Issue-scoped workflows share a dir by issue number; non-issue
    // workflows (explore, health, etc.) get a run-scoped dir so
    // concurrent sessions never overlap.
    //
    // Server mode + pre-cloned + a whole-workspace backend relocates the docs
    // to the workspace root (reached via `../`) so `git add -A` can't sweep
    // them in; see artifactIssueDir.
    issueDir = artifactIssueDir(
      config,
      buildAssetIssueKey(workflowName, number, workflowId),
      !!effectivePrePopulateBranch,
    );
    // Concurrency authority differs by backend: docker/gondolin use the tuned
    // app-level `maxWorkflows`; the k8s backend defers to the namespace
    // ResourceQuota (spec/09-sandbox.md (Concurrency)) and keeps only an absurdly-high sanity fuse,
    // so it admits freely here and requeues later if a pod-create is quota-rejected.
    const admitCap =
      config.sandbox === "kubernetes" ? K8S_SANITY_FUSE : concurrency?.maxWorkflows ?? Infinity;
    const overCap = db.runs.countRunning() >= admitCap;
    const runStatus: "running" | "queued" = overCap ? "queued" : "running";
    db.runs.createRun({
      id: workflowId,
      workflowName,
      triggerId,
      owner,
      repo,
      issueNumber: issueNumber ?? prNumber,
      currentPhase: definition.phases[0]?.name || "phase_0",
      status: runStatus,
      // Actor logging (issue #205): the ORIGINAL trigger. Falls back to
      // `sender` so pre-actor callers still attribute to the acting handle.
      triggeredBy: request.triggeredBy ?? request.sender,
      triggerActorType: request.triggerActorType,
      context: {
        kind: definition.kind,
        owner,
        branch,
        taskId,
        issueDir,
        prePopulateBranch: effectivePrePopulateBranch,
        models: effectiveModels as Record<string, unknown> | undefined,
        variants: effectiveVariants as Record<string, unknown> | undefined,
        // What the repo's own `.lastlight/` contributed to THIS run — the tree
        // sha it came from, the leaves it actually won, and everything that was
        // dropped. Persisted (rather than re-derived on read) because the layer
        // is TTL-cached and mutable: by the time anyone asks why a run picked a
        // model, the repo's default branch may have moved on.
        repoConfig: repoConfig ? repoConfigRunRecord(repoConfig) : undefined,
        ...request.extra,
      },
      startedAt: new Date().toISOString(),
    });
    console.log(`[simple] Created workflow run ${workflowId} (${workflowName}) status=${runStatus}`);
    if (overCap) {
      // On k8s the cap is the runaway-loop sanity fuse (the ResourceQuota is the
      // real authority), not a tuned concurrency limit — word it accurately.
      const capReason =
        config.sandbox === "kubernetes"
          ? `the safety fuse (${admitCap}) is reached`
          : `the concurrency limit (${admitCap}) is reached`;
      const ackId = await notify(
        `\`${workflowName}\` is queued — ${capReason}.` +
        ` It'll start automatically when a slot frees.`,
      );
      // The ack is TRANSIENT: it promises the run will start, so it stops being
      // true the moment the run leaves the queue. Stash the comment handle so
      // the admission controller can retract it on admit / rewrite it on TTL
      // expiry (issue #244) — otherwise a run that starts and then legitimately
      // no-ops leaves this comment as the only trace, reading as "it queued and
      // never came back". Only GitHub surfaces return an id; Slack resolves void.
      if (typeof ackId === "number") {
        db.runs.mergeScratch(workflowId, { queuedAck: { commentId: ackId } });
      }
      return { success: true, queued: true, phases: [] };
    }
  }

  // The server-store key for this run's artifacts (owner/repo/issueKey). Kept
  // separate from issueDir because issueDir is an agent-facing *path* that may
  // now carry a `../` prefix (relocated runs) — deriving the key by stripping
  // `.lastlight/` off issueDir would then break. `buildAssetsRelocated` reads
  // the decision back off the resolved issueDir so reused/resumed rows stay
  // consistent with however the original dispatch formed it.
  const issueKey = buildAssetIssueKey(workflowName, number, workflowId);
  const buildAssetsRelocated = issueDir.startsWith("../");

  // Surface the run id to the dispatch layer as soon as it's known (either
  // fresh or reused). Fire-and-forget so a slow/broken downstream hook can't
  // stall the workflow.
  if (callbacks.onRunStart) {
    callbacks.onRunStart(workflowId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple] onRunStart callback threw: ${msg}`);
    });
  }

  // ── Seed the in-place progress checklist ───────────────────────────────────
  //
  // For workflows that opt into `status_checklist`, build the task-list model
  // from the definition's phases and publish the initial surface (one GitHub
  // comment / one Slack message that subsequent phases edit in place). On a
  // resumed run we re-seed the SAME surface (the transport re-attaches to the
  // stored comment id / message ts) and mark already-completed phases done.
  if (callbacks.reporter && definition.status_checklist) {
    const completed = new Set(
      (existingRun?.phaseHistory ?? []).map((h) => h.phase),
    );
    const model = buildProgressModel(definition, {
      workflowName,
      number,
      issueTitle: request.issueTitle,
      owner,
      repo,
      branch,
      completed,
      runUrl: runDashboardUrl(callbacks.publicUrl, workflowId, workflowName),
    });
    await callbacks.reporter.start(model).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple] reporter.start threw: ${msg}`);
    });
  }

  // ── Build template context ─────────────────────────────────────────────────
  //
  // The context snapshot is the agent's primary view of the task. All
  // user-provided text is wrapped in <<<USER_CONTENT_UNTRUSTED>>> markers so
  // the agent — anchored by agent-context/security.md — treats them as data
  // rather than instructions. The trigger metadata (sender, branch, issue
  // ref) sits outside the wrappers so identity is established out-of-band.
  //
  // For build/pr-fix/explore workflows the dispatch path (src/index.ts)
  // pre-fetches the real issue body + full comment thread and stitches them
  // into request.extra.combinedContext (one screening call). For everything
  // else we fall back to whatever the envelope carried.

  const combinedContext = (request.extra?.combinedContext as string | undefined) || "";
  const issueRef = `${owner}/${repo}${issueNumber ? `#${issueNumber}` : ""}`;
  const hasAnyUserContent = !!(combinedContext || request.issueBody || request.commentBody);

  const contextSnapshot = hasAnyUserContent
    ? [
        `Repo: ${issueRef}`,
        `Issue title: ${request.issueTitle || "(none)"}`,
        request.commentBody
          ? `Triggering comment:\n${wrapUntrusted(request.commentBody, { source: "github-comment", author: request.sender })}`
          : "",
        `Requested by: ${request.sender}`,
        `Branch: ${branch}`,
        combinedContext
          ? `Issue body and full thread:\n${wrapUntrusted(combinedContext, { source: "github-issue-thread" })}`
          : request.issueBody
          ? `Issue body:\n${wrapUntrusted(request.issueBody, { source: "github-issue-body" })}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";

  const ctx: TemplateContext = {
    owner,
    repo,
    // A PR is its own GitHub number, so for PR-scoped workflows (pr-review /
    // pr-fix, triggered by a `pr.*` webhook that carries only `prNumber`)
    // fall back to it — otherwise `issueNumber` is 0 and the `post-review`
    // action can't find the PR to post against. Mirrors the DB run row and
    // taskId, both of which already key off `issueNumber ?? prNumber`.
    issueNumber: issueNumber ?? prNumber ?? 0,
    // Surface the PR number explicitly too; `post-review` prefers it over
    // `issueNumber`, and PR-scoped prompts can reference `{{prNumber}}`.
    prNumber,
    issueTitle: request.issueTitle || "",
    issueBody: request.issueBody || "",
    issueLabels: request.issueLabels || [],
    commentBody: request.commentBody || "",
    sender: request.sender,
    // The bot's `@mention` handle (e.g. `@last-light`), for approval-gate and
    // command help strings in workflow YAML — `{{botMention}} approve`.
    botMention: `@${getBotName()}`,
    branch,
    taskId,
    issueDir,
    // True only in server mode — prompts gate their `git add .lastlight/ &&
    // commit` behind `{{#if !externalizeArtifacts}}` so the handoff docs are
    // never committed into the target repo (they're harvested to the server
    // store instead). Absent/false ⇒ repo behaviour (commit the docs).
    externalizeArtifacts: config.buildAssets === "server",
    // Dashboard base URL for the {{artifactUrl}} helper (server-mode doc links).
    publicUrl: callbacks.publicUrl,
    // Public, unauthenticated, image-only base URL for inline screenshot embeds
    // in the browser-QA comment (so GitHub's image proxy can fetch them without
    // a login). The agent appends `/<name>.png` per screenshot it saves. Empty
    // when no PUBLIC_URL is configured — the prompt then falls back to
    // filename-only references via `{{#if !artifactBaseUrl}}`. issueKey is
    // issueDir minus the `.lastlight/` prefix.
    artifactBaseUrl: callbacks.publicUrl
      ? `${String(callbacks.publicUrl).replace(/\/+$/, "")}/admin/api/public/artifacts/${owner}/${repo}/${issueKey}`
      : "",
    bootstrapLabel,
    contextSnapshot,
    // Forwarded to the executor (via gitSandboxAccessForWorkflow) so the
    // harness pre-clones this branch into the sandbox workspace before
    // the agent starts. Stored on the workflow_run row above; also lives
    // on ctx so the runner can read it without an extra DB lookup.
    prePopulateBranch: effectivePrePopulateBranch,
    // EFFECTIVE models — the repo layer is already folded in, so the existing
    // `{{models.<phase>}}` chain in the engine's `resolveModelVariant` needs no
    // knowledge of repo config at all.
    models: effectiveModels as unknown as Record<string, unknown>,
    // Reasoning-effort overrides per phase. Empty/undefined entries skip
    // the --variant flag (model uses its default effort). Effective, as above.
    variants: effectiveVariants as unknown as Record<string, unknown> | undefined,
    // Slack-initiated runs need the runner to pause/resume on the thread id,
    // not on owner/repo#N. Passing the override through here keeps the
    // runner's triggerId derivation in one place.
    triggerIdOverride: request.triggerId,
    // Extra workflow-specific args (e.g. mode: scan from cron, or the PR fix
    // payload). These become top-level ctx keys so prompt templates can read
    // them directly via {{failedChecks}} etc.
    ...(request.extra || {}),
  };

  // In server mode, tag the run's config with its artifact identity so the
  // executor's stage-in/harvest seam can locate this run's docs in the store
  // at `<buildAssetsDir>/<owner>/<repo>/<issueKey>/`, plus whether the docs
  // live at the workspace root (relocated) so `hostRepoDirFor` stages/harvests
  // there instead of inside the repo checkout.
  const runConfig: ExecutorConfig =
    config.buildAssets === "server"
      ? {
          ...config,
          buildAssetsKey: { owner, repo, issueKey },
          buildAssetsRelocated,
        }
      : config;

  try {
    const result = await runWorkflow(
      definition,
      ctx,
      runConfig,
      callbacks,
      db,
      effectiveModels,
      effectiveApproval,
      workflowId,
      effectiveVariants,
      // 10th arg: the repo layer itself, for the per-run asset resolver. The
      // merged config above is already effective; this carries the on-disk
      // layer root the runner appends to the asset stack.
      repoConfig,
    );

    if (result.success && !result.paused) {
      db.runs.finishRun(workflowId, "succeeded");
      reapOnSuccess(workflowName, taskId, config);
    } else if (result.backpressure) {
      // k8s ResourceQuota rejected a pod-create: requeue, don't fail. The
      // AdmissionController promotes it again as capacity frees (spec/09-sandbox.md (Concurrency)).
      db.runs.requeueRunning(workflowId);
      await notify(
        `\`${workflowName}\` is waiting for cluster capacity — it'll start automatically when a slot frees.`,
      );
      return { success: true, queued: true, backpressure: true, phases: result.phases };
    } else if (!result.success && !result.paused) {
      db.runs.finishRun(workflowId, "failed", {
        error: result.phases.find((p) => !p.success)?.error || "workflow failed",
      });
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.runs.finishRun(workflowId, "failed", { error: msg });
    throw err;
  }
}

/**
 * Short-circuit for a workflow run that already has state. Returns a
 * WorkflowResult to return directly (already complete / rejected / still
 * paused), or `null` to continue into `runWorkflow` for normal resume.
 */
async function handleExistingRun(
  run: WorkflowRun,
  definition: ReturnType<typeof getWorkflow>,
  notify: (msg: string) => Promise<number | void>,
  db: StateDb,
): Promise<WorkflowResult | null> {
  // Dedup: a duplicate trigger on an already-queued run must be a no-op.
  // Do NOT fall through to runWorkflow — that would execute it outside the cap.
  if (run.status === "queued") {
    console.log(
      `[simple] Duplicate trigger for queued run ${run.id} (${run.workflowName}) — returning queued dedup`,
    );
    return { success: true, queued: true, phases: [] };
  }

  // Workflow already completed: currentPhase is a terminal set_phase marker
  // (e.g. "complete") — i.e. not a declared phase, not a generated loop label
  // (`*_fix_N` / `*_recheck_N` / `*_iter_N`), and not the synthetic
  // "waiting_approval" pause marker. Don't re-run.
  if (
    run.currentPhase &&
    run.currentPhase !== "waiting_approval" &&
    !definition.phases.some((p) => p.name === run.currentPhase) &&
    PhaseRef.parse(run.currentPhase).kind === "phase"
  ) {
    await notify(`Workflow \`${run.workflowName}\` is already complete for this trigger.`);
    return {
      success: true,
      phases: [{ phase: "resume", success: true, output: "Already complete" }],
    };
  }

  // Paused awaiting approval — see if a human has responded.
  if (run.status === "paused" && run.currentPhase === "waiting_approval") {
    const pendingApproval = db.approvals.getPendingForWorkflow(run.id);
    if (pendingApproval?.status === "approved") {
      // Resume is ledger-driven: the runner re-runs from the top and every
      // completed phase skips via `shouldRunPhase` (the executions ledger).
      // No currentPhase manipulation is needed — for an approve gate the
      // gated phase is already `done` so the runner proceeds past it; for a
      // reply gate the loop node resumes from `scratch.iteration`.
      console.log(
        `[simple] ${pendingApproval.kind === "reply" ? "Reply" : "Approval"} received for gate ${pendingApproval.gate} — resuming ${run.workflowName}`,
      );
      db.runs.setRunning(run.id);
      if (pendingApproval.kind !== "reply") {
        await notify(`**Approval received** — resuming \`${run.workflowName}\`.`);
      }
      return null; // fall through to runWorkflow
    } else if (pendingApproval?.status === "rejected") {
      const reason = pendingApproval.response || "no reason given";
      db.runs.finishRun(run.id, "failed", { error: `Rejected: ${reason}` });
      await notify(`Workflow \`${run.workflowName}\` was rejected. Reason: ${reason}`);
      return {
        success: false,
        phases: [{ phase: "rejected", success: false, output: `Rejected: ${reason}` }],
      };
    } else {
      await notify(`Workflow \`${run.workflowName}\` is paused, awaiting approval.`);
      return { success: true, phases: [], paused: true };
    }
  }

  // Normal resume — the runner's definition-driven resume takes over.
  console.log(
    `[simple] Resuming ${run.workflowName} for ${run.triggerId} (last phase: ${run.currentPhase})`,
  );
  return null;
}
