/**
 * The marker harvest — the impure half of `./fix-markers.ts` AND of
 * `./pr-notes.ts`.
 *
 * Two things a fix run leaves behind travel this way, and they ride the same
 * `onPhaseEnd` hook on purpose: the two marker lines the agent emits in its
 * OUTPUT, and the journal it appends to a FILE in the checkout
 * (10-pr-memory.md). One hook, one scratch namespace, one merge — a second hook
 * would be a second thing to wire at three call sites and a second thing to
 * forget to wire at the fourth.
 *
 * A fix run's only durable output, besides the commit it may or may not have
 * pushed, is the pair of marker lines the agent emits. Nothing else survives
 * the run boundary: `{{phaseOutputs}}` is empty across runs, and the shared
 * per-PR workspace is `reset --hard`-ed between them. So the harness reads the
 * markers out of each phase's output as it completes and persists them on the
 * run's `scratch`, where the NEXT dispatch's `applyDerivedState` reads them
 * back off `latestForTrigger` (04-retry.md §4.2, 09-state-machine.md §S1).
 *
 * ## Why `scratch` and not `context`
 *
 * `context.prState` is the resolved snapshot, and it is written at DISPATCH —
 * before any phase runs. The harvest is a post-hoc fact about the run that
 * dispatch produced, so it cannot go there without rewriting the record of
 * what the dispatch decision was actually taken on. `scratch` is the run's
 * mutable phase-to-phase channel and already rides back on the same
 * `latestForTrigger` row, so the transport costs no new column, no new query
 * and no second write path.
 *
 * ## Two traps this module exists to absorb
 *
 * - **`phase` is a LABEL, not a phase name.** A `generic_loop` iteration
 *   arrives as `fix_iter_1` / `fix_iter_2`, a soft retry as `fix_iter_1_retry`.
 *   Keying on `phase === "fix"` would silently harvest nothing the moment the
 *   gate loop lands. This module does not key on the phase at all — the marker
 *   lines are self-identifying, so every phase of a fix-shaped workflow is
 *   scanned and the LAST marker of each kind wins (which is also the right
 *   answer for a loop: iteration 2 supersedes iteration 1).
 * - **`mergeScratch` is a TOP-LEVEL shallow merge.** Writing
 *   `{ fixMarkers: { diagnosis } }` after a previous write of
 *   `{ fixMarkers: { fix } }` would drop the first. Every write here therefore
 *   re-reads the namespace and merges into it.
 */

import { closeSync, openSync, readFileSync, readSync, rmSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import { getRuntimeConfig } from "../config/config.js";
import { sandboxRoot } from "../sandbox/reap.js";
import { PR_FIX_SHAPED_WORKFLOWS } from "../workflows/target-policy.js";
import {
  parseAttemptMarkers,
  type AttemptMarkers,
  type DiagnosisMarker,
  type FixOutcomeMarker,
} from "./fix-markers.js";
import { PR_NOTES_FILE_NAME, VERIFY_SCRIPT_NAME } from "./fix-scratch.js";
import {
  boundNotes,
  coerceNotes,
  parseNoteFile,
  type NoteProvenance,
  type PrNote,
} from "./pr-notes.js";
import { logger } from "../logging/logger.js";

const log = logger("fix-harvest");

/**
 * The `scratch` key the harvest owns.
 *
 * Deliberately NOT `fix`: a `generic_loop` declares its own `scratch_key` in
 * YAML, `fix` is the obvious name for the gate loop's slot, and both would be
 * merged into the same top-level object by `mergeScratch`.
 */
export const FIX_HARVEST_SCRATCH_KEY = "fixMarkers";

/** What one run's harvest records. */
export interface HarvestedFixMarkers extends AttemptMarkers {
  /**
   * Phase bases the harvest has run over, in order, de-duplicated.
   *
   * Its presence — not the presence of a marker — is what says "the harvest
   * ran on this run". A run row with NO `fixMarkers` key at all is either
   * older than this feature or died before its first phase ended, which
   * `didSpendAttempt` distinguishes.
   */
  phases: string[];
  /** ISO timestamp of the most recent harvest write. */
  at: string;
  /**
   * Notes this run's agent wrote into the journal (10-pr-memory.md). Already
   * sanitized and bounded; `applyDerivedState` folds them onto
   * {@link PrState.notes} for the next dispatch. Empty on every run that wrote
   * none, which is most of them.
   */
  notes: PrNote[];
  /**
   * The push gate this run actually ran — the contents of
   * `.git/lastlight-verify.sh` as the agent wrote it (09-state-machine.md §S1,
   * item 1: *"record the script's contents on the run record, surfaced in the
   * §S3 panel — this is the most useful debugging artifact in the fix loop"*).
   *
   * The gate is a file the agent writes FOR ITSELF, and `until_bash` only reads
   * its exit code. That is a bounded hazard by design (real CI is always the
   * merge authority, so a weak gate costs a wasted attempt, never a bad merge)
   * — but only if the script is *inspectable* afterwards. Without this, "the
   * gate went green and the fix was still wrong" is unanswerable: the workspace
   * is reset on the next attempt and the script goes with it.
   *
   * Deliberately NOT static-validated. 09 §S1 is explicit that checking the
   * script's contents is an arms race against your own agent; recording it lets
   * a human see the problem instead of guessing at it.
   *
   * `null` on every run that wrote no gate — which includes every run on the
   * kubernetes backend, where the harness has no filesystem access to the PVC
   * (the same narrowing the PR journal carries there).
   */
  verifyScript: string | null;
}

/**
 * Strip the engine's generated loop suffixes off a phase label.
 *
 * `fix_iter_2` → `fix`, `fix_iter_2_retry` → `fix`, `review_recheck_1` →
 * `review`. Used only for the recorded {@link HarvestedFixMarkers.phases}
 * breadcrumb — the harvest itself is label-agnostic on purpose.
 */
export function phaseBase(label: string): string {
  return label
    .replace(/_iter_\d+_retry$/, "")
    .replace(/_iter_\d+$/, "")
    .replace(/_fix_\d+$/, "")
    .replace(/_recheck_\d+$/, "");
}

/**
 * Read a run row's harvested markers, or null when the run has none.
 *
 * Tolerates every shape a `scratch` column can hold, including rows written
 * before this key existed — `null` means "nothing was harvested here", which
 * callers must be able to tell from "harvested, and there was no marker".
 */
export function readHarvestedMarkers(
  run: Pick<WorkflowRun, "scratch"> | null | undefined,
): HarvestedFixMarkers | null {
  const slot = run?.scratch?.[FIX_HARVEST_SCRATCH_KEY];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
  const raw = slot as Record<string, unknown>;
  return {
    diagnosis: (raw.diagnosis as DiagnosisMarker | undefined) ?? null,
    fix: (raw.fix as FixOutcomeMarker | undefined) ?? null,
    phases: Array.isArray(raw.phases) ? raw.phases.filter((p) => typeof p === "string") : [],
    at: typeof raw.at === "string" ? raw.at : "",
    notes: coerceNotes(raw.notes),
    verifyScript: typeof raw.verifyScript === "string" ? raw.verifyScript : null,
  };
}

// ---------------------------------------------------------------------------
// The journal — where it lives, and why not `../`
// ---------------------------------------------------------------------------

/**
 * The journal is a file inside the checkout's own `.git/` directory
 * (`<workspace>/<repo>/.git/lastlight-notes`) on EVERY backend.
 *
 * That is deliberately the same resolution `.git/lastlight-verify.sh` reached
 * (`./executors/shared.ts` → the push gate), and for the same reasons — with one
 * extra:
 *
 * 1. **Git structurally cannot see it.** `.git/` is the repository, not the
 *    work tree; no pathspec walk enters it, so `git add -A` cannot commit the
 *    journal on any backend, in any `buildAssets` mode, with nothing to
 *    register anywhere. That last clause is the whole point: the journal used
 *    to sit at the checkout root and depend on each backend adding it to the
 *    local `.git/info/exclude`, and the kubernetes backend never got that code
 *    (#256). A guarantee that every new backend must re-implement is not a
 *    guarantee.
 * 2. **gondolin is the packaged default** (`sandbox.backend: gondolin`) and
 *    mounts only cwd, so a workspace-root sibling reached via `../` is simply
 *    unreachable inside the guest. A `../` journal would silently never be
 *    written on the default backend — the worst possible failure mode for a
 *    memory feature, because it looks like "the agent had nothing to say".
 *    `.git/` is inside cwd, so it is reachable there.
 * 3. **One uniform path is what makes the prompt and the harvest agree.** The
 *    agent is told a bare relative path with its cwd already the checkout; the
 *    harvest resolves the same path from the run row. Neither has to know the
 *    backend, which is exactly what `artifactIssueDir` DOES have to know — its
 *    relocation is conditional on `buildAssets === "server"` AND a non-gondolin
 *    backend, so it is not reusable here.
 *
 * `git clean -fdx -e node_modules` on a cross-run workspace refresh does NOT
 * reach inside `.git/`, so the explicit `resetPrNotesJournal` delete is the only
 * thing that clears a file a crashed run left behind — which is the point of it
 * existing. The journal is DRAINED into the run's scratch at the end of every
 * phase, so its durable home is the snapshot either way.
 */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * Host path to the checkout a run's journal lives in, or null when the run has
 * no workspace we can name.
 *
 * Resolved from the run row exactly as `createTaskSandbox` / `reapSandboxWorkspace`
 * resolve it — `<sandboxes root>/<taskId>/<repo>` — so the three never disagree.
 * A taskId that escapes the sandboxes root is refused rather than followed, the
 * same guard the reaper applies.
 *
 * ## Where the two halves come from
 *
 * `taskId` is on `context` (written at creation). **`repo` is on the run ROW,
 * not on `context`** — and that asymmetry is load-bearing enough to have broken
 * this function for its whole life. `dispatchWorkflow` reads `context.repo` as
 * a QUALIFIED `owner/repo`, splits it into the row's `owner` + bare `repo`
 * columns, and the persisted context keeps only `owner`. So reading the repo
 * off `context` resolved to `""` on every real run, this returned `null`, and
 * BOTH callers — the push-gate read and the journal drain — were silently
 * skipped: `scratch.fixMarkers.verifyScript` was `null` and `notes` was `[]` on
 * every fix run ever recorded, while the files sat on disk in the workspace.
 * The unit tests missed it by hand-building `context: { taskId, repo }`, a
 * shape production never produces.
 *
 * The row's column is also the RIGHT source independent of that bug: it is
 * documented as the bare, path-safe name, which is exactly what
 * `prePopulateWorkspace` uses for the checkout dir. The `context` fallback is
 * kept for callers that synthesize a run without a row (tests, the evals
 * harness) and is de-qualified so either shape resolves.
 */
export function prNotesRepoDir(
  run: Pick<WorkflowRun, "context" | "repo"> | null | undefined,
  overrides: { stateDir?: string; sandboxDir?: string } = {},
): string | null {
  const ctx = run?.context as Record<string, unknown> | undefined;
  const taskId = typeof ctx?.taskId === "string" ? ctx.taskId : "";
  const rowRepo = typeof run?.repo === "string" ? run.repo : "";
  const ctxRepo = typeof ctx?.repo === "string" ? ctx.repo : "";
  // `.split("/").pop()` de-qualifies an `owner/repo` fallback and is a no-op on
  // an already-bare name; the path-escape guard below still has the last word.
  const repo = (rowRepo || ctxRepo).split("/").pop() ?? "";
  if (!taskId || !repo) return null;
  const rt = getRuntimeConfig();
  const stateDir = overrides.stateDir || rt?.stateDir || process.env.STATE_DIR || "data";
  const base = sandboxRoot(stateDir, overrides.sandboxDir ?? rt?.sandboxDir);
  const dir = resolve(base, taskId, repo);
  if (!isWithin(base, dir)) return null;
  return dir;
}

/**
 * Cap on how much of the journal file is read.
 *
 * The file is written by a language model inside a sandbox, so "it will be a
 * handful of lines" is a hope, not a bound. Reading only the TAIL keeps a
 * runaway loop that appended a gigabyte from being pulled into the harness
 * process, and the tail is the right end to keep: notes are appended, so the
 * newest are last — the same "keep the newest" rule the cap itself uses.
 */
const MAX_NOTES_FILE_BYTES = 64 * 1024;

/** Read at most the last {@link MAX_NOTES_FILE_BYTES} of a file, or null. */
function readTail(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null; // no journal — the overwhelmingly common case
  }
  if (size <= MAX_NOTES_FILE_BYTES) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(MAX_NOTES_FILE_BYTES);
    const read = readSync(fd, buf, 0, MAX_NOTES_FILE_BYTES, size - MAX_NOTES_FILE_BYTES);
    // Drop the first (probably partial) line rather than parsing half a note.
    return buf.subarray(0, read).toString("utf8").replace(/^[^\n]*\n/, "");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Cap on how much of the gate script is recorded.
 *
 * Smaller than the journal's cap and taken from the HEAD rather than the tail:
 * a shell script is read top-down, and the interesting part of a runaway one is
 * where it starts, not where it ends.
 */
const MAX_VERIFY_SCRIPT_BYTES = 8 * 1024;

/**
 * Read the push gate the agent wrote for itself, or null when it wrote none.
 *
 * A READ, not a drain (`drainPrNotes` below is the drain): the same file is the
 * live gate `generic_loop.until_bash` runs on the next iteration, so removing
 * it would disarm the loop this harvest is reporting on. The reset that DOES
 * clear it happens once per attempt, at the start, in `./executors/shared.ts`.
 *
 * Never throws: a failed read must not fail the phase that produced it.
 */
export function readVerifyScript(repoDir: string): string | null {
  const path = join(repoDir, VERIFY_SCRIPT_NAME);
  try {
    const body = readFileSync(path, "utf8");
    if (!body.trim()) return null;
    return body.length > MAX_VERIFY_SCRIPT_BYTES
      ? `${body.slice(0, MAX_VERIFY_SCRIPT_BYTES)}\n… truncated at ${MAX_VERIFY_SCRIPT_BYTES} bytes`
      : body;
  } catch {
    return null; // no gate written yet — the state every run starts in
  }
}

/**
 * Read the journal and DELETE it — a drain, not a read.
 *
 * The delete is what makes the file a per-phase outbox rather than an
 * accumulator: the harvest runs after every phase, and a file left in place
 * would re-contribute `diagnose`'s notes at the end of `fix`. (`boundNotes`
 * de-duplicates, so a failed delete degrades to "nothing new", never to a
 * duplicated journal.)
 *
 * Never throws: a failed drain must not fail the phase that produced it.
 */
export function drainPrNotes(repoDir: string, provenance: NoteProvenance): PrNote[] {
  const path = join(repoDir, PR_NOTES_FILE_NAME);
  const body = readTail(path);
  if (body === null) return [];
  try {
    rmSync(path, { force: true });
  } catch {
    /* de-duplication covers a file we could not remove */
  }
  return parseNoteFile(body, provenance);
}

/**
 * Harvest whatever markers `output` carries — and whatever notes the checkout's
 * journal carries — onto the run's scratch.
 *
 * Wired into `RunnerCallbacks.onPhaseEnd` at all THREE of its call sites —
 * `index.ts` (fresh dispatch) plus both of `resume.ts`'s (GitHub and Slack
 * resume). Harvesting only in the first would silently lose every marker on a
 * run that paused for an approval gate or was resumed after a restart, which
 * is precisely the population whose attempt counter matters most.
 *
 * Never throws: a failed harvest must not fail the phase that produced the
 * output it was reading.
 */
export function harvestFixMarkers(
  db: StateDb,
  runId: string,
  workflowName: string,
  phase: string,
  output: string,
  /** Test seam: the checkout to drain the journal from, bypassing the run row. */
  overrides: { repoDir?: string | null } = {},
): void {
  // Only the fix family carries the MARKERS, and only it reads them back. The
  // JOURNAL is wider — see the gate below — so this is no longer an early
  // return for the whole function.
  const wantsMarkers = PR_FIX_SHAPED_WORKFLOWS.has(workflowName);
  try {
    const run = db.runs.getRun(runId);
    // Which runs may write a note? Every PR-SCOPED one — `pr-review` reading
    // what `dependabot-ci-fix` learned is the point of keying on the PR
    // (10-pr-memory.md). Rather than import a second workflow-name set (which
    // would put this module and `./pr-state.ts` in an import cycle), the gate
    // reads the fact at its source: a run carries `context.prState` iff the
    // dispatcher resolved a snapshot for it, which is exactly the definition of
    // PR-scoped. It therefore tracks `prScopedWorkflows()` automatically as
    // that set changes — including a workflow an operator adds by declaring
    // `pr_scoped: true` in an overlay.
    const wantsNotes =
      !!(run?.context as Record<string, unknown> | undefined)?.prState;
    if (!wantsMarkers && !wantsNotes) return;

    const parsed: AttemptMarkers = wantsMarkers ? parseAttemptMarkers(output ?? "") : {};
    const current = readHarvestedMarkers(run);
    const base = phaseBase(phase);
    const phases = current?.phases ?? [];
    const at = new Date().toISOString();

    let notes = current?.notes ?? [];
    // The gate script is recorded for the FIX FAMILY only — it is the only
    // family that writes one. Its last non-null reading stands: the file is
    // reset once per attempt, not per phase, so a later phase that cannot see
    // the workspace must not blank the gate an earlier one recorded.
    let verifyScript = current?.verifyScript ?? null;
    if (wantsNotes || wantsMarkers) {
      const repoDir = overrides.repoDir !== undefined ? overrides.repoDir : prNotesRepoDir(run);
      if (repoDir) {
        if (wantsNotes) {
          const fresh = drainPrNotes(repoDir, { at, runId, workflow: workflowName, phase });
          if (fresh.length > 0) notes = boundNotes([...notes, ...fresh]);
        }
        if (wantsMarkers) verifyScript = readVerifyScript(repoDir) ?? verifyScript;
      }
    }

    // A PR-scoped run that is not fix-shaped and wrote no note has nothing to
    // record — leave its scratch untouched rather than stamping an empty
    // namespace on every `pr-review` phase.
    if (!wantsMarkers && notes.length === 0) return;

    const next: HarvestedFixMarkers = {
      // Last marker of each kind wins. A `generic_loop` iteration 2 supersedes
      // iteration 1; a phase that emitted nothing leaves the earlier value
      // standing rather than blanking it.
      diagnosis: parsed.diagnosis ?? current?.diagnosis ?? null,
      fix: parsed.fix ?? current?.fix ?? null,
      phases: phases.includes(base) ? phases : [...phases, base],
      at,
      notes,
      verifyScript,
    };
    db.runs.mergeScratch(runId, { [FIX_HARVEST_SCRATCH_KEY]: next });
  } catch (err: unknown) {
    log.warn("Harvest failed", { workflowName, phase, runId, err });
  }
}
