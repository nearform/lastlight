/**
 * Stage the diff ONCE — the f1 lever.
 *
 * ── Why this exists, measured ────────────────────────────────────────────────
 *
 * The five survey fan-out branches make ~93 bash calls per case, and ~30 of
 * them re-derive ONE fixed merge-base range that `facts.json` already holds:
 * `git diff origin/<base>...HEAD`, `git diff --stat`, `git show <sha>:<path>`,
 * once per branch and often several times per branch. Surveys are ~75% of a
 * case's spend, so a fixed range re-derived thirty times is thirty turns, thirty
 * round trips and thirty diffs' worth of tokens bought at the price of one.
 *
 * Worse than the money: **every re-derivation is a fresh chance to get the range
 * wrong.** WP1b's bug 3 was a two-dot diff, and the corpus number is the reason
 * this package exists — `sentry-greptile-1` reads 6,125 changed files two-dot
 * against 3 from the merge base. A branch that runs its own `git diff` is one
 * missing dot away from reviewing somebody else's commits, and nothing
 * downstream can tell that it did.
 *
 * So the deterministic layer — which has already resolved the range, exactly
 * once, in `run.ts`'s `prepare()` — writes the patch down. One index, one patch
 * per changed file, under `.lastlight/pr-review/diff/`. The briefs then point at
 * it by CHECKOUT-RELATIVE path (measured: relative reads from a survey branch
 * succeeded 98/98, workspace-root-absolute failed 27/27, because the only
 * absolute path a branch is ever handed is its skill bundle, one level above the
 * checkout).
 *
 * ── The range is NOT re-derived here either ──────────────────────────────────
 *
 * This module never computes a merge base. It calls `git.unifiedDiff`, which
 * goes through the same private `diffRange` that `changedPaths` and `diffHunks`
 * use, and it is handed the `changed`/`hunks` the run already computed. There is
 * exactly one range in a run and this writes THAT one down.
 *
 * ── Fail-loud, and the exit code it must not touch (LD6 / §D12) ──────────────
 *
 * Staging is an AFFORDANCE. It is not an analysis, and it cannot make the facts
 * wrong. So a staging failure:
 *
 *   - never throws out of {@link stageDiff} — everything is caught here, because
 *     a throw would reach `runWrapped` and turn a complete analysis into a
 *     `coverage: "none"` envelope that says nothing was analysed;
 *   - records a `degraded[]` entry, so the envelope says what is missing rather
 *     than the brief silently omitting a section (the omission would read to a
 *     survey as "there is no staged diff on this deployment", which is exactly
 *     the shape locked decision 6 forbids);
 *   - still writes an `index.md` that says LOUDLY what happened, because the
 *     brief points at that path and a 404 there is the least informative
 *     possible answer;
 *   - leaves the exit-code contract alone. `degraded[]` non-empty means exit 3.
 *     Staging alone can never reach exit 2.
 *
 * `null` ≠ `[]` applies at the top: `stagedDiff.files` is `null` when staging
 * could not run and `[]` only when the range genuinely changed nothing. The
 * field being ABSENT from the envelope is the third fact — nobody asked.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { reasonOf } from "./errors.js";
import { unifiedDiff, type ChangedPath, type FileHunks } from "./git.js";
import { noopLogger, type LoggerPort } from "./log.js";
import type { DegradedEntry, StagedDiff, StagedDiffFile } from "./schema.js";

/** Where the pipeline puts it. A sibling of `facts.json`, not a child. */
export const DEFAULT_DIFF_STAGE_DIR = ".lastlight/pr-review/diff";

/** The index every brief points at. Always written, on every path. */
export const DIFF_INDEX_NAME = "index.md";

/**
 * How many patch BODIES one run will write.
 *
 * The index stays complete whatever this is — every changed file gets a row,
 * over-ceiling rows carry `patch: null` and say so — because a truncated
 * inventory is the omission this whole package is engineered against. What the
 * ceiling bounds is bytes on disk in the pathological case (a 6,125-file
 * two-dot-shaped diff is not hypothetical; it is `sentry-greptile-1`).
 */
export const MAX_STAGED_FILES = 400;

/**
 * Per-patch ceiling. A 40 MB generated-lockfile patch is not something a model
 * will read and not something a workspace should carry; the row says the size
 * and points at nothing, which is honest and cheap.
 */
export const MAX_PATCH_BYTES = 512 * 1024;

/** How many characters of a filename we will spend before hashing. */
const MAX_NAME_CHARS = 180;

/** The only characters that survive sanitisation unescaped. `_` is NOT one. */
const SAFE_CHAR = /[A-Za-z0-9.-]/;

/**
 * A repo path → a flat, collision-free patch filename.
 *
 * `src/auth/index.ts` → `src__auth__index.ts.patch`, which is the readable shape
 * a model can eyeball against the index. The escaping underneath it is what
 * makes that readability safe:
 *
 *   - `/` becomes `__`;
 *   - every other character outside `[A-Za-z0-9.-]` — **including `_` itself** —
 *     becomes `_<hex>_`.
 *
 * Escaping `_` is the whole trick. Without it `src__auth/index.ts` and
 * `src/auth/index.ts` collide on one filename, one patch overwrites the other,
 * and the index points two rows at the same bytes — a wrong answer wearing a
 * right answer's clothes. With it the mapping is INJECTIVE: a `_` in the output
 * is always followed by either another `_` (a slash) or a hex run terminated by
 * `_` (one code point), so no two inputs can produce one output.
 *
 * A path long enough to overrun a filesystem's 255-byte name limit is truncated
 * and given a hash tail — `~` cannot appear from the escaping, so it is an
 * unambiguous marker that this row's name is not reversible by eye.
 */
export function stagedPatchName(path: string): string {
  let out = "";
  for (const ch of path) {
    if (ch === "/") {
      out += "__";
      continue;
    }
    if (SAFE_CHAR.test(ch)) {
      out += ch;
      continue;
    }
    out += `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  if (out.length + ".patch".length > MAX_NAME_CHARS) {
    const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
    out = `${out.slice(0, MAX_NAME_CHARS - ".patch".length - digest.length - 1)}~${digest}`;
  }
  return `${out}.patch`;
}

/** One `diff --git …` chunk of a unified diff, with the head path it is about. */
interface PatchChunk {
  /** The path at HEAD — the one `changedPaths` reports. */
  path: string;
  /** The path at BASE when this chunk is a rename; `null` otherwise. */
  renamedFrom: string | null;
  text: string;
}

/** `--- a/x` / `+++ b/x`, minus git's optional trailing tab metadata. */
function sidePath(line: string): string | null {
  const raw = line.slice(4).replace(/\t.*$/, "").trim();
  if (raw === "/dev/null") return null;
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

/**
 * Split one unified diff into per-file chunks.
 *
 * Attribution order is deliberate and is about DELETIONS and BINARIES: `+++ b/`
 * is the head path and the right answer whenever it exists, `--- a/` is the only
 * path a pure deletion has, and the `diff --git a/… b/…` header is the last
 * resort — it is the only line a binary or mode-only change carries, and it is
 * the one line whose parse is ambiguous for a path containing " b/".
 */
export function splitPatches(raw: string): PatchChunk[] {
  const out: PatchChunk[] = [];
  const lines = raw.split("\n");
  let current: string[] | null = null;

  const flush = (): void => {
    if (!current || current.length === 0) return;
    const text = current.join("\n");
    let head: string | null = null;
    let from: string | null = null;
    let renamedFrom: string | null = null;
    for (const line of current) {
      if (line.startsWith("+++ ")) head = sidePath(line);
      else if (line.startsWith("--- ")) from = sidePath(line);
      else if (line.startsWith("rename from ")) renamedFrom = line.slice("rename from ".length);
      else if (line.startsWith("@@")) break;
    }
    let path = head ?? from;
    if (!path) {
      // No `---`/`+++` pair at all: a binary patch, or a pure mode change. The
      // header is all there is.
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(current[0] ?? "");
      path = header?.[2] ?? null;
      if (header && header[1] !== header[2]) renamedFrom = header[1];
    }
    if (path) out.push({ path, renamedFrom, text: `${text.replace(/\n+$/, "")}\n` });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return out;
}

export interface StageDiffOptions {
  /** Absolute, already normalised by `run.ts`. */
  repo: string;
  /** The MERGE BASE — `prepare()`'s, never re-derived here. */
  baseSha: string;
  headSha: string;
  /** The run's own changed set, so the index and `facts.files[]` cannot disagree. */
  changed: ChangedPath[];
  /** The run's own hunk ranges, in HEAD coordinates. */
  hunks: FileHunks[];
  /** Repo-relative (or absolute inside the repo). Defaults to {@link DEFAULT_DIFF_STAGE_DIR}. */
  dir?: string;
  log?: LoggerPort;
}

export interface StageDiffResult {
  payload: StagedDiff;
  degraded: DegradedEntry[];
}

/** `path:12-18` → `12-18`; the path is already the row's first column. */
function rangesOf(hunks: FileHunks | undefined): string[] {
  if (!hunks) return [];
  return hunks.hunks.map((h) => h.slice(h.lastIndexOf(":") + 1));
}

const STATUS_CODE: Record<ChangedPath["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  other: "?",
};

/**
 * Stage it. NEVER THROWS — see the module header; a caught failure becomes a
 * `degraded[]` entry, a `files: null` payload and a loud index.
 */
export function stageDiff(options: StageDiffOptions): StageDiffResult {
  const log = options.log ?? noopLogger;
  const requested = options.dir ?? DEFAULT_DIFF_STAGE_DIR;
  const absDir = isAbsolute(requested) ? requested : resolve(options.repo, requested);
  // Repo-relative in the DOCUMENT, always: `selfcheck.ts`'s `no-absolute-paths`
  // walks every string in the envelope, and a host path in there is a host path
  // in a model's prompt. It is also the only form a survey branch can read
  // (relative 98/98, workspace-root-absolute 0/27).
  const relDir = isAbsolute(requested) ? relative(options.repo, absDir) : requested;
  const indexRel = `${relDir}/${DIFF_INDEX_NAME}`;
  const degraded: DegradedEntry[] = [];

  try {
    const raw = unifiedDiff(options.repo, options.baseSha, options.headSha);
    const chunks = splitPatches(raw);
    const byPath = new Map(chunks.map((c) => [c.path, c]));
    const hunksByPath = new Map(options.hunks.map((h) => [h.path, h]));

    // A fresh directory per run. The workspace is REUSED across runs
    // (`workspace: per-target-reuse`) and the cross-run refresh is
    // `git clean -fdx -e node_modules`, so a stale patch from the previous head
    // sha would otherwise survive beside a current index that never names it —
    // and a model that opened it would review a commit that is no longer there.
    rmSync(absDir, { recursive: true, force: true });
    mkdirSync(absDir, { recursive: true });

    // CODE-POINT order, not `localeCompare`. Two runs of the same range must
    // produce byte-identical artifacts, and a locale-aware comparator is a
    // function of the machine's ICU data as well as of the strings — it sorts
    // `src__weird/…` before `src/added.ts` on one box and need not on another.
    const ordered = [...options.changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const files: StagedDiffFile[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let written = 0;
    let overCeiling = 0;
    let oversize = 0;
    let missing = 0;

    for (const change of ordered) {
      const chunk = byPath.get(change.path);
      byPath.delete(change.path);
      const row: StagedDiffFile = {
        path: change.path,
        status: change.status,
        renamedFrom: chunk?.renamedFrom ?? null,
        hunks: rangesOf(hunksByPath.get(change.path)),
        patch: null,
        bytes: 0,
      };
      if (!chunk) {
        // git named this path in `--name-status` and produced no patch for it.
        // A mode-only change can do it. Recorded, never dropped.
        missing += 1;
        files.push(row);
        continue;
      }
      const bytes = Buffer.byteLength(chunk.text, "utf8");
      if (written >= MAX_STAGED_FILES) {
        overCeiling += 1;
        files.push(row);
        continue;
      }
      if (bytes > MAX_PATCH_BYTES) {
        oversize += 1;
        files.push({ ...row, bytes });
        continue;
      }
      const name = stagedPatchName(change.path);
      writeFileSync(join(absDir, name), chunk.text, "utf8");
      written += 1;
      files.push({ ...row, patch: name, bytes });
    }

    // Anything git emitted that the changed set does not name. It should be
    // empty — both sides come from the same `-M` range — and if it is not, the
    // two disagree and that is worth saying out loud rather than dropping.
    for (const [path] of byPath) {
      skipped.push({
        path,
        reason: "git produced a patch for this path but the changed set does not name it",
      });
    }

    if (overCeiling > 0) {
      degraded.push({
        extractor: "stage-diff",
        reason: `${overCeiling} changed file(s) are listed in ${indexRel} with NO staged patch — the per-run ceiling of ${MAX_STAGED_FILES} patch bodies was reached. The index is still complete; those files must be read from the working tree at head, and their diff is NOT on disk`,
      });
    }
    if (oversize > 0) {
      degraded.push({
        extractor: "stage-diff",
        reason: `${oversize} changed file(s) have a patch larger than ${MAX_PATCH_BYTES} bytes and were listed but not written to ${relDir}`,
      });
    }
    if (missing > 0) {
      degraded.push({
        extractor: "stage-diff",
        reason: `${missing} changed file(s) are named by \`git diff --name-status\` but produced no patch body (a mode-only or otherwise contentless change). They are listed in ${indexRel} with no patch`,
      });
    }
    if (skipped.length > 0) {
      degraded.push({
        extractor: "stage-diff",
        reason: `${skipped.length} patch(es) could not be attributed to a changed path and were NOT staged (${skipped
          .slice(0, 5)
          .map((s) => s.path)
          .join(", ")}) — the patch and the changed set disagree about this range`,
      });
    }

    const payload: StagedDiff = { dir: relDir, index: indexRel, files, skipped };
    writeFileSync(join(absDir, DIFF_INDEX_NAME), renderIndex(payload, options), "utf8");
    log.info("code-facts staged the diff", {
      extractor: "stage-diff",
      dir: relDir,
      files: files.length,
      written,
    });
    return { payload, degraded };
  } catch (err) {
    const reason = reasonOf(err);
    log.error("code-facts could not stage the diff", { extractor: "stage-diff", err: reason });
    const payload: StagedDiff = { dir: relDir, index: indexRel, files: null, skipped: [] };
    // Best-effort, and deliberately not guarded any further: the brief points a
    // survey at this exact path, and an absent file there is the least
    // informative failure available. If even this cannot be written the
    // `degraded[]` entry below is still in the envelope.
    try {
      mkdirSync(absDir, { recursive: true });
      writeFileSync(join(absDir, DIFF_INDEX_NAME), renderFailedIndex(reason), "utf8");
    } catch {
      /* the envelope is the guarantee; the file is the convenience */
    }
    degraded.push({
      extractor: "stage-diff",
      reason: `the diff could not be staged under ${relDir}: ${reason}. The ANALYSIS in this document is unaffected — what is missing is the pre-written patch a survey reads instead of running \`git diff\`. A consumer must derive the range itself, THREE-DOT (\`git diff <baseBranch>...HEAD\`), and must not read the absence of staged patches as an empty diff`,
    });
    return { payload, degraded };
  }
}

/** The index a survey opens first. Complete — every changed file, always. */
function renderIndex(staged: StagedDiff, options: StageDiffOptions): string {
  const files = staged.files ?? [];
  const lines: string[] = [];
  lines.push(`# Staged diff — ${files.length} changed file(s)`);
  lines.push("");
  lines.push(
    `\`${options.baseSha}..${options.headSha}\` — the MERGE BASE of the base branch and this PR's head,`,
    "which is the range GitHub's own \"Files changed\" tab shows and the range every fact in",
    "`.lastlight/pr-review/facts.json` is about. It was resolved ONCE, by the deterministic layer.",
    "",
    "**Do not re-derive this range with `git diff` or `git show`** — read these patches instead.",
    "Re-deriving it is where a two-dot diff creeps back in: measured across 50 real pull requests, 9",
    "diverge, one of them reporting 6,125 changed files two-dot against 3 from the merge base.",
    "",
    "**These patches are a starting point, not a scope.** They sit inside the FULL CHECKOUT: open the",
    "changed files whole, read the code either side of a hunk, grep for the callers and references a",
    "patch cannot show you. The defects worth finding live in the code this range touches but does not",
    "display.",
    "",
    "Every path below is relative to the repository checkout — your working directory. Open them",
    "exactly as written.",
    "",
  );

  if (files.length === 0) {
    lines.push(
      "**This range changed no files at all.** That is what git reports for it — it is not a staging",
      "failure (a staging failure says so in these words, at the top of this file).",
      "",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push("| file | status | changed lines (head) | patch |");
  lines.push("|---|---|---|---|");
  for (const file of files) {
    const status =
      file.renamedFrom === null
        ? STATUS_CODE[file.status]
        : `${STATUS_CODE[file.status]} (from \`${file.renamedFrom}\`)`;
    const ranges = file.hunks.length > 0 ? file.hunks.join(", ") : "—";
    const patch =
      file.patch === null
        ? `**NOT STAGED**${file.bytes > 0 ? ` (patch is ${file.bytes} bytes)` : ""}`
        : `\`${staged.dir}/${file.patch}\``;
    lines.push(`| \`${file.path}\` | ${status} | ${ranges} | ${patch} |`);
  }
  lines.push("");

  const unstaged = files.filter((f) => f.patch === null);
  if (unstaged.length > 0) {
    lines.push(
      `**${unstaged.length} of these ${files.length} file(s) have NO staged patch** — see the envelope's`,
      "`degraded[]` in `.lastlight/pr-review/facts.json` for which bound was hit. They are still part of",
      "this PR. Read them at head and derive their diff yourself if this family's obligations touch them;",
      "do not read a missing patch as an unchanged file.",
      "",
    );
  }
  if (staged.skipped.length > 0) {
    lines.push(
      `**${staged.skipped.length} patch(es) could not be attributed to a changed path**, which means the`,
      "patch and the changed set disagree about this range:",
      "",
      ...staged.skipped.map((s) => `  - \`${s.path}\` — ${s.reason}`),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The loud index. It is written INSTEAD of the real one, at the same path, so
 * the brief's pointer always resolves to something that answers the question.
 */
function renderFailedIndex(reason: string): string {
  return [
    "# Staged diff — NOT AVAILABLE",
    "",
    "**The deterministic layer could not stage this PR's diff.** No per-file patches were written.",
    "",
    `Reason: ${reason}`,
    "",
    "This is a MISSING AFFORDANCE, not an empty diff. Nothing here says the pull request changed",
    "nothing, and an empty `diff/` directory must never be read that way.",
    "",
    "Derive the range yourself, and use **three dots**:",
    "",
    "```",
    "git diff <baseBranch>...HEAD",
    "```",
    "",
    "Two-dot (`git diff <baseBranch> HEAD`) additionally contains every commit that landed on the",
    "base branch since this PR forked, and the author wrote none of it — measured across 50 real",
    "pull requests, 9 diverge, one of them 6,125 files against 3.",
    "",
  ].join("\n");
}
