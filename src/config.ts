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

/** Walk a dotted key (e.g. `models.guardrails`) over a context object. */
function walkKey(ctx: Record<string, unknown>, key: string): unknown {
  let cur: unknown = ctx;
  for (const seg of key.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Render a `{{models.X}}`-style template against the models map (the subset of
 * core's renderTemplate that phase `model:` fields ever use). */
function renderModelTemplate(template: string, models: ModelConfig): string {
  return template.replace(/\{\{([\w-]+(?:\.[\w-]+)*)\}\}/g, (_m, key: string) => {
    const val = walkKey({ models }, key);
    return val === undefined || val === null ? "" : String(val);
  });
}

/**
 * Resolve the model a phase will actually run on, mirroring core's
 * `resolveModelVariant` precedence for RECORDING into the scorecard
 * (`PhaseMetric.model`). Core does the real selection; this just lets the
 * dashboard show the per-step assignment without a round-trip.
 *
 *   rendered `{{models.X}}` template  →  models[phaseName]  →  models.default
 *
 * @param template  the phase's raw `model:` field (e.g. `"{{models.executor}}"`),
 *   or undefined for phases that name no model.
 */
export function resolvePhaseModel(
  template: string | undefined,
  phaseName: string,
  models: ModelConfig,
): string {
  const rendered = template ? renderModelTemplate(template, models).trim() : "";
  return rendered || models[phaseName] || models.default;
}
