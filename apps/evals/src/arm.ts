/**
 * The Arm — one column of the model-comparison axis, behind one interface.
 *
 * A comparison run has N arms. Every arm flows through the SAME downstream
 * machinery (work-list → grade → scorecard → dashboard); arms differ only in
 * *how a workflow step picks its model*. That fork has exactly two shapes:
 *
 *   - `models` runs — one model FORCED across every step (`modelsArm`).
 *   - `config` runs — a deployment's REAL per-step model config drives selection
 *     (`configArm`): the merged `models`/`variants` maps from core's
 *     `default.yaml` ← an overlay's `config.yaml`, threaded to core exactly as
 *     production does so core picks the model per phase.
 *
 * Before this module that fork was re-decided in ~5 places across `run.ts` and
 * `run-instance.ts` (every `if (modelConfig)` / `runType === "config"`). Here it
 * lives once, as polymorphism over two adapters. The seam:
 *
 *   - `prepare(ctx)`   — the single per-run model operation: patch `ctx.models`/
 *     `ctx.variants` (config only) AND hand back the `ExecutorConfig.model` +
 *     the `runWorkflow` `models`/`variants` args. Always invoked together, so
 *     it's one call.
 *   - `recordPhaseModel(template, phase)` — the model a phase resolved to, for
 *     the scorecard (runs per-phase, AFTER the workflow — kept separate).
 *   - `activate()` — repoint the process-global asset root to this arm's overlay
 *     (config only; guarded — see ADR 0001). `modelsArm` is a no-op.
 *   - `describe()` — the per-step `k→v` summary for the plan note (config only).
 *
 * `run.ts` owns *which* arms exist (flag + registry resolution); the adapters own
 * *how* to build one. This module imports `config.ts` + `bootstrap.ts` (local)
 * and NEVER the `lastlight/evals` barrel — that coupling stays in
 * `run-instance.ts`, the only file that calls `runWorkflow`.
 */
import { basename } from "node:path";

import {
  loadMergedConfig,
  loadOverlayReview,
  resolvePhaseModel,
  type ModelConfig,
  type VariantConfig,
} from "./config.js";
import { bootstrapAssets } from "./bootstrap.js";

/**
 * The mutable run context an Arm patches in {@link Arm.prepare}. A structural
 * subset of core's `TemplateContext` — kept local so `arm.ts` never imports the
 * `lastlight/evals` barrel (the patch only ever sets `models`/`variants`, which
 * `TemplateContext` doesn't even declare; prod adds them as extra top-level keys
 * the same way).
 */
export type MutableContext = Record<string, unknown>;

/** What {@link Arm.prepare} hands back — the three places a run consumes the
 * arm's model selection, produced in one shot. */
export interface PreparedModels {
  /** `ExecutorConfig.model` — the forced id (`models`) or the merged config's
   * `default` (`config`; the fallback core uses for phases that resolve to
   * nothing). */
  model: string;
  /** `runWorkflow`'s `models` arg (config arms only; undefined for `models`
   * arms so every phase falls back to {@link model}). */
  models?: ModelConfig;
  /** `runWorkflow`'s `variants` arg (config arms only). */
  variants?: VariantConfig;
}

/** One comparison column. Two adapters: {@link modelsArm}, {@link configArm}. */
export interface Arm {
  /** Axis label → `InstanceResult.model` (model id in `models`; overlay/config
   * name in `config`). */
  readonly label: string;
  /** Parallel-grouping key (provider env-key in `models`; the arm id in
   * `config`, which keeps config arms in their own serial family). */
  readonly family: string;
  /**
   * The arm's `review:` policy — its overlay `config.yaml` block, verbatim
   * (undefined when the overlay declares none). Model selection is not the only
   * thing an overlay varies: `review.analysis.enabled` is what switches the
   * review evidence pipeline on, and it is a property of the DEPLOYMENT under
   * test, so it rides on the arm beside `models`/`variants` rather than in the
   * gold dataset. `run-instance.ts` hands it to `prContextPatch`, which merges
   * it over core's `defaultReviewConfig()` and lets core's own `renderContext`
   * project it.
   *
   * Typed loosely (raw YAML) because this module must never import the
   * `lastlight/evals` barrel — the cast to core's `ReviewConfig` happens at the
   * one place that already owns that coupling.
   */
  readonly review?: Record<string, unknown>;
  /** Repoint the process-global asset root to this arm's overlay before its
   * cases run. Guarded (ADR 0001): throws if a second, different overlay is
   * activated while one is still in use. No-op for `models` arms. */
  activate(): void;
  /** Patch `ctx` (config arms set `ctx.models`/`ctx.variants`) and return the
   * executor model + `runWorkflow` model/variant args — one operation, always
   * invoked together. */
  prepare(ctx: MutableContext): PreparedModels;
  /** The model a phase resolved to, for `PhaseMetric.model` (the forced id for
   * `models`; core's resolve precedence for `config`). `phase` is the LEDGER
   * label (`survey_branch_contract`, not `survey`); for a fan-out branch row
   * `fallbackPhase` names the parent phase — core's `fallbackTask` — so the
   * branch falls back `models[<label>]` → `models[<parent>]` → default. */
  recordPhaseModel(template: string | undefined, phase: string, fallbackPhase?: string): string;
  /** Per-step `k→v` model-map summary for the plan note (config arms);
   * undefined for `models` arms (one model = the label). */
  describe(): string | undefined;
}

/**
 * `models` arm — one model id forced across every workflow step. No ctx patch,
 * no per-step map: the label IS the model and every phase runs it.
 *
 * It still takes an `overlayDir`, because an overlay carries more than a model
 * map. `bootstrapAssets` has always wired the overlay's workflows/skills for a
 * `models` run (run.ts does it once, up front — hence the no-op `activate()`),
 * and its `review:` policy is the same kind of fact: the arm's deployment
 * config, which a forced model neither supplies nor overrides. Omitting it
 * would mean a `--model X --overlay wp3` run silently ran the baseline policy.
 */
export function modelsArm(id: string, family: string, overlayDir?: string): Arm {
  return {
    label: id,
    family,
    review: loadOverlayReview(overlayDir),
    activate() {
      /* no overlay to switch — built-in assets only */
    },
    prepare() {
      // No `models`/`variants` → core falls every phase back to config.model = id.
      return { model: id };
    },
    recordPhaseModel() {
      return id;
    },
    describe() {
      return undefined;
    },
  };
}

/**
 * `config` arm — a deployment's REAL per-step config drives model selection.
 * Owns the YAML merge (`loadMergedConfig`), the optional `--model` default
 * override, and its own label (`basename(overlayDir)` or `"config"`).
 *
 * @param builtInRoot     the lastlight package root (holds `config/default.yaml`).
 * @param overlayDir      the overlay whose `config.yaml` merges over the defaults
 *   (and whose workflows/skills {@link Arm.activate} repoints to). Absent ⇒ core
 *   defaults only (a degenerate single-model config — still a valid arm).
 * @param defaultOverride a `--model`-resolved id that replaces the merged
 *   config's `default` for quick what-if runs (run.ts resolves the token).
 */
export function configArm(builtInRoot: string, overlayDir: string | undefined, defaultOverride?: string): Arm {
  const merged = loadMergedConfig(builtInRoot, overlayDir);
  if (defaultOverride) merged.models.default = defaultOverride;
  const label = overlayDir ? basename(overlayDir) : "config";
  return {
    label,
    review: loadOverlayReview(overlayDir),
    // config arms keep their own serial family (one overlay at a time — the
    // asset root is a process global; see ADR 0001).
    family: label,
    activate() {
      activateOverlay(overlayDir);
    },
    prepare(ctx) {
      // Thread the merged maps onto ctx EXACTLY as production (`simple.js`) does
      // so `model: "{{models.X}}"` phase templates resolve against `ctx.models`.
      ctx.models = merged.models;
      ctx.variants = merged.variants;
      return { model: merged.models.default, models: merged.models, variants: merged.variants };
    },
    recordPhaseModel(template, phase, fallbackPhase) {
      return resolvePhaseModel(template, phase, merged.models, fallbackPhase);
    },
    describe() {
      return Object.entries(merged.models)
        .map(([k, v]) => `${k}→${v}`)
        .join("  ");
    },
  };
}

// ── The process-global overlay guard (ADR 0001) ──────────────────────────────
// Core's asset root is module-level state inside the `lastlight` package — there
// is one "current overlay" for the whole process. Config arms switch it between
// arms (serial), which is safe; two overlays active AT ONCE would race. The
// guard turns that discipline-maintained invariant into a runtime-checked one:
// it records the active overlay and throws if a different one is activated while
// the current is still in use. The serial run loop calls `releaseOverlayGuard()`
// when it finishes an arm, so the legitimate sequential switch never trips it.
let activeOverlay: string | undefined;
let overlayActive = false;

function activateOverlay(overlayDir: string | undefined): void {
  if (overlayActive && overlayDir !== activeOverlay) {
    throw new Error(
      `Refusing to activate overlay ${overlayDir ?? "(core defaults)"} while ` +
        `${activeOverlay ?? "(core defaults)"} is still in use — the workflow asset root is ` +
        `process-global (see ADR 0001), so config arms must run serially. Call ` +
        `releaseOverlayGuard() before switching overlays.`,
    );
  }
  bootstrapAssets({ overlayDir });
  activeOverlay = overlayDir;
  overlayActive = true;
}

/**
 * Release the overlay guard so the next arm may activate a different overlay.
 * The serial run loop calls this on each arm change (and a focused test calls it
 * to reset between assertions). Reaching {@link activateOverlay} with a different
 * overlay WITHOUT a release first is the parallel footgun the guard catches.
 */
export function releaseOverlayGuard(): void {
  activeOverlay = undefined;
  overlayActive = false;
}
