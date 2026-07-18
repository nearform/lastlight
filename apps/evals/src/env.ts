/**
 * Minimal `.env` loader for the eval harness (no dotenv dependency).
 *
 * Reads the repo-root `.env` (KEY=VALUE lines) and sets any keys not already
 * present in `process.env`. The provider key (OPENAI_API_KEY / ANTHROPIC_…)
 * lives there for local dev; the eval needs it to make real model calls.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { builtinModelsPath } from "./paths.js";

let loaded = false;

/**
 * Active model-registry path. Defaults to the shipped `<pkg>/models.json`; a
 * user/overlay can point it elsewhere via {@link setModelsPath} (run.ts wires
 * `--models-file` / `<overlay>/evals/models.json`) so a deployment can ship its
 * own model set the same way it ships its own datasets.
 */
let modelsPath = builtinModelsPath();

/** Override the model-registry path (call once at CLI startup, before reads). */
export function setModelsPath(path: string): void {
  modelsPath = resolve(path);
}

export function loadDotEnv(root = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** True if at least one provider key the eval can use is set. */
export function hasProviderKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.FIREWORKS_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.KIMI_API_KEY ||
      process.env.MOONSHOT_API_KEY,
  );
}

/**
 * Per-million-token price for a model, in USD — same shape and unit as pi-ai's
 * model `cost` block, so the numbers are directly comparable to the real
 * provider costs the transcript reports. `cacheRead`/`cacheWrite` default to 0.
 */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelEntry {
  id: string;
  label?: string;
  provider?: string;
  envKey?: string;
  /**
   * Optional per-million-token price. A *fallback*: used only when the session
   * transcript reports `$0` for this model (e.g. flat-rate/subscription plans
   * like the kimi.com/code console, whose provider registry carries no
   * pay-as-you-go price). When the transcript already has a real cost, this is
   * ignored. Ships in the overlay's `evals/models.json`, so a deployment prices
   * its own models without patching pi-ai. See {@link modelCost}.
   */
  cost?: ModelRate;
}
interface ModelsConfig {
  default: string;
  compare: ModelEntry[];
}

function modelsConfig(): ModelsConfig {
  return JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsConfig;
}

/** Single-model run: EVAL_MODELS override, else the `default` from models.json. */
export function evalModels(): string[] {
  const raw = process.env.EVAL_MODELS?.trim();
  if (raw) return raw.split(",").map((m) => m.trim()).filter(Boolean);
  return [modelsConfig().default];
}

/**
 * Cross-vendor comparison set from `models.json`, filtered to the models whose
 * provider key is actually present — so `npm run eval:compare` runs whatever
 * you have keys for and silently skips the rest.
 */
export function compareModels(): ModelEntry[] {
  return modelsConfig().compare.filter((m) => !m.envKey || Boolean(process.env[m.envKey]));
}

/** id → display label, from models.json (for the scorecard). */
export function modelLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of modelsConfig().compare) if (m.label) out[m.id] = m.label;
  return out;
}

/**
 * The fallback per-token price for a model id, from its `models.json` compare
 * entry, or undefined if none is declared. The runner uses it to impute a cost
 * only when the transcript reports `$0` (see {@link ModelEntry.cost} and
 * `collectMetrics`). Matches the id exactly, else the same substring rule as
 * {@link resolveModel} so `--model`-resolved ids still find their price.
 */
export function modelCost(id: string): ModelRate | undefined {
  const all = modelsConfig().compare;
  const v = id.toLowerCase();
  const hit =
    all.find((m) => m.id === id) ??
    all.find((m) => m.id.toLowerCase().includes(v) || m.label?.toLowerCase().includes(v));
  return hit?.cost;
}

/** Provider family (env-key) inferred from a `provider/model` id prefix. */
export function familyForId(id: string): string {
  const provider = id.split("/")[0]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    moonshotai: "MOONSHOT_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
  };
  return map[provider] ?? "default";
}

/**
 * Resolve a user-supplied model token (from `--model`) to a concrete entry.
 * Matches a models.json `compare` id exactly, else a case-insensitive substring
 * of its id or label (so `--model haiku` works); failing that, treats the token
 * as a raw `provider/model` id and infers the family from its prefix. Not
 * key-gated — `--model` is an explicit request, so we run it even if the key
 * check would otherwise skip it (the provider call surfaces a missing key).
 */
export function resolveModel(token: string): ModelEntry & { family: string } {
  const all = modelsConfig().compare;
  const v = token.toLowerCase();
  const hit =
    all.find((m) => m.id === token) ??
    all.find((m) => m.id.toLowerCase().includes(v) || m.label?.toLowerCase().includes(v));
  if (hit) return { ...hit, family: hit.envKey ?? familyForId(hit.id) };
  return { id: token, family: familyForId(token) };
}
