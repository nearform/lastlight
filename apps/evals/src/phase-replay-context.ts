/**
 * The slice of a pr-review run's template context a PHASE REPLAY needs and
 * cannot rebuild from the preserved artifacts — `run-context.json`, written
 * beside the run's `pr-review/` artifact dir.
 *
 * `select` renders `{{#if priorDiscussion}}` (the PR's earlier conversation)
 * and `{{#if priorLedger}}` (issue #429: what earlier reviews of this PR
 * already posted). Both are projected at dispatch from GitHub and the run
 * store, neither is a file in `.lastlight/pr-review/`, so a `micro-select`
 * replay of a re-review used to render them empty — replaying a first review
 * of a PR that had already been reviewed. Only those keys are kept: the rest
 * of the context is either rebuilt by the replay (`promptContext`) or not a
 * prompt input.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUN_CONTEXT_FILE = "run-context.json";
/** The context keys a replay restores, when the run had them. */
export const STORED_CONTEXT_KEYS = ["priorDiscussion", "priorLedger", "headSha"] as const;

/** Keep the replayable keys of a run's context — non-empty strings only. */
export function storedRunContext(ctx: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of STORED_CONTEXT_KEYS) {
    const v = ctx[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** Write `<trialDir>/run-context.json`; nothing when there is nothing to keep. Best-effort. */
export function writeStoredRunContext(trialDir: string, ctx: Record<string, unknown>): void {
  const kept = storedRunContext(ctx);
  if (!Object.keys(kept).length) return;
  try {
    mkdirSync(trialDir, { recursive: true });
    writeFileSync(join(trialDir, RUN_CONTEXT_FILE), `${JSON.stringify(kept, null, 2)}\n`);
  } catch {
    /* a replay without it renders the empty branches, as before */
  }
}

/**
 * The stored context for a preserved `pr-review/` artifact dir (the file sits
 * beside it). `{}` for a run recorded before the file existed — the replay
 * then renders exactly what it rendered before.
 */
export function readStoredRunContext(artifactsDir: string): Record<string, string> {
  const file = join(dirname(artifactsDir.replace(/\/+$/, "")), RUN_CONTEXT_FILE);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return storedRunContext(raw);
  } catch {
    return {};
  }
}
