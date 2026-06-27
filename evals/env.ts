/**
 * Minimal `.env` loader for the eval harness (no dotenv dependency).
 *
 * Reads the repo-root `.env` (KEY=VALUE lines) and sets any keys not already
 * present in `process.env`. The provider key (OPENAI_API_KEY / ANTHROPIC_…)
 * lives there for local dev; the eval needs it to make real model calls.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let loaded = false;

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
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY,
  );
}

/** The models to compare, from EVAL_MODELS (comma-separated) or a default. */
export function evalModels(): string[] {
  const raw = process.env.EVAL_MODELS?.trim();
  if (raw) return raw.split(",").map((m) => m.trim()).filter(Boolean);
  if (process.env.ANTHROPIC_API_KEY) return ["anthropic/claude-haiku-4-5"];
  return ["openai/gpt-5.4-mini"];
}
