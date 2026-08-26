/**
 * Per-step model config loader — the heart of the `config` run type.
 *
 * The `models` run type forces ONE model across every workflow step. The
 * `config` run type instead reproduces what a real deployment ships: a
 * per-workflow-step model map (`models.guardrails`, `models.architect`, …)
 * merged from core's `config/default.yaml` and an overlay's `config.yaml`,
 * exactly as production's {@link https://…/dist/config.js loadConfig} does.
 *
 * Core does NOT export its `loadConfig`/`ModelConfig` via the `lastlight/evals`
 * barrel, so we read + deep-merge the two YAMLs ourselves — but ONLY the
 * `models` / `variants` maps, and with the same semantics core uses
 * (per-key overlay-wins, string values only, a guaranteed `default`). The
 * resolved maps are then handed to core's runner via `ctx.models`/`ctx.variants`
 * + the `runWorkflow` args, so actual per-phase selection is still delegated to
 * core — we never re-implement the selection itself, only mirror it for
 * RECORDING (see {@link resolvePhaseModel}).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderTemplate, type TemplateContext } from "lastlight-workflow-engine";
import { parse as parseYaml } from "yaml";

/** Maps a workflow task/phase key → model id. `default` is always present. */
export interface ModelConfig {
  default: string;
  [taskType: string]: string;
}

/** Maps a task/phase key → reasoning-effort variant. Mirrors core's shape. */
export interface VariantConfig {
  default?: string;
  [taskType: string]: string | undefined;
}

export interface MergedConfig {
  models: ModelConfig;
  variants: VariantConfig;
}

/** Core's fallback when neither default.yaml nor the overlay sets a default. */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a YAML file's top-level mapping, or {} if absent/empty. */
function readYamlMap(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = parseYaml(readFileSync(path, "utf-8"));
  return isPlainObject(parsed) ? parsed : {};
}

/** Pull a sub-map of string values from a raw config object (core semantics:
 * non-string entries are dropped). */
function stringMap(raw: Record<string, unknown>, key: string): Record<string, string> {
  const sub = isPlainObject(raw[key]) ? (raw[key] as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sub)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Load the merged `models`/`variants` config, mirroring production's
 * default.yaml ← overlay/config.yaml deep-merge (overlay wins per key).
 *
 * @param builtInRoot the lastlight package root (from `resolveCoreRoot()`),
 *   which holds `config/default.yaml`.
 * @param overlayDir  optional overlay dir holding `config.yaml`. Absent ⇒ just
 *   the core defaults (a degenerate single-model config — still a valid arm).
 */
export function loadMergedConfig(builtInRoot: string, overlayDir?: string): MergedConfig {
  const def = readYamlMap(join(builtInRoot, "config", "default.yaml"));
  const overlay = overlayDir ? readYamlMap(join(overlayDir, "config.yaml")) : {};

  const models: ModelConfig = {
    default: DEFAULT_MODEL,
    ...stringMap(def, "models"),
    ...stringMap(overlay, "models"),
  };
  const variants: VariantConfig = {
    ...stringMap(def, "variants"),
    ...stringMap(overlay, "variants"),
  };
  return { models, variants };
}

/**
 * The overlay's `review:` block — the arm's REVIEW POLICY, not its model map.
 *
 * `review.analysis.enabled` is what turns the review evidence pipeline on
 * (core's `specContext` projects it to `analysisEnabled`, which every WP3 phase
 * in `pr-review.yaml` gates on with `skip_if: "analysisEnabled != true"`). It
 * therefore belongs to the ARM — the deployment config under test — exactly
 * like `models`/`variants`, and NOT to the gold dataset: `instances.json` is the
 * human-signed-off answer key, and a policy switch living there would make the
 * two arms differ by an edit to gold rather than by an overlay.
 *
 * Only the overlay is read, deliberately — core's `config/default.yaml` is NOT
 * merged in here the way {@link loadMergedConfig} merges it, because the base
 * this override lands on is core's own `defaultReviewConfig()` (see
 * `pr-context.ts`), which is the same set of defaults `default.yaml` documents.
 * Reading both would be two copies of one default, and the YAML copy would win.
 *
 * @returns the raw block (shape-checked only as "a mapping"), or undefined when
 *   the overlay declares none — which must stay indistinguishable from having no
 *   overlay at all, so the baseline arm runs the shipped two-phase review.
 */
export function loadOverlayReview(overlayDir?: string): Record<string, unknown> | undefined {
  if (!overlayDir) return undefined;
  const raw = readYamlMap(join(overlayDir, "config.yaml"));
  const review = raw["review"];
  return isPlainObject(review) && Object.keys(review).length ? review : undefined;
}

/**
 * Render a phase `model:` template against the models map — by calling CORE'S
 * OWN template engine (`lastlight-workflow-engine`'s `renderTemplate`, the
 * exact function `resolveModelVariant` feeds these templates through), not a
 * local subset of it.
 *
 * This used to be a bare-variable regex copy, and the divergence was a real
 * defect: pr-review.yaml's `adjudicate` model is an `{{#if}}`/`{{#if !x}}`
 * conditional pair, which the copy left un-rendered — so with
 * `models.review-adjudicate` unset the recorded PhaseMetric.model was the
 * literal `{{#if …}}` residue instead of what `models.review` resolves to.
 *
 * The cast is safe for this call: `TemplateContext`'s required fields feed the
 * `{{slugify}}`/`{{branchUrl}}`/`{{artifactUrl}}` helpers, which no `model:`
 * template uses — a model template only ever reads `models.*` (and `{{#if}}`
 * over them), and `lookupContextKey` walks whatever context it's handed.
 */
function renderModelTemplate(template: string, models: ModelConfig): string {
  return renderTemplate(template, { models } as unknown as TemplateContext);
}

/**
 * Resolve the model a phase will actually run on, mirroring core's
 * `resolveModelVariant` precedence for RECORDING into the scorecard
 * (`PhaseMetric.model`). Core does the real selection; this just lets the
 * dashboard show the per-step assignment without a round-trip.
 *
 *   rendered `{{models.X}}` template  →  models[phaseName]
 *     →  models[fallbackPhase]  →  models.default
 *
 * `fallbackPhase` mirrors core's `fallbackTask` parameter (both resolvers:
 * `phase-executor.ts resolveModelVariant` and `fanout.ts`'s copy) — for a
 * fan-out branch row the task name is the branch LABEL
 * (`survey_branch_contract`) and the fallback task is the parent phase name,
 * so a branch resolves `models[<label>]` → `models[<parent>]` → default.
 *
 * @param template  the raw `model:` field governing the row — for a branch,
 *   `branch.model ?? phase.model` (see `fanout.ts branchConfig`) — or
 *   undefined for phases that name no model.
 */
export function resolvePhaseModel(
  template: string | undefined,
  phaseName: string,
  models: ModelConfig,
  fallbackPhase?: string,
): string {
  const rendered = template ? renderModelTemplate(template, models).trim() : "";
  return rendered || models[phaseName] || (fallbackPhase ? models[fallbackPhase] : "") || models.default;
}
