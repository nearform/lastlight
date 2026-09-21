/**
 * Why does an `off-diff` demotion happen?
 *
 * `say-gap.ts` established the shape of the found→said gap and turned up one
 * number nobody had costed: of the 24 gold findings the pipeline SAID, 6 lost
 * their inline slot to an `off-diff` demotion — more than any cause but the
 * adjudicator's own `tier: body`. That is pure attention cost at zero recall
 * cost. A finding in the review body is said quietly; a finding on the diff is
 * said where the author is looking.
 *
 * `off-diff` is step 5 of `tierFindings()`
 * (`apps/server/src/engine/github/review-poster.ts`): a finding with no `path`,
 * no `line`, or one `isAnchored()` says is not in the `commentable` set goes to
 * the body. Before it, `anchorFindings` runs the WP6a cascade — (1) match the
 * verbatim `existingCode` against the finding's OWN file's hunks, RIGHT then
 * LEFT; (2) search the whole head-side file; (3) relocate across files on a
 * UNIQUE hit; (4) model regeneration, deliberately never built; (5) give up.
 *
 * The cascade has four distinct ways to fail and they have completely
 * different fixes, so "improve anchoring" is not a work item until you know
 * which one you are in:
 *
 *   a/no-excerpt   the finding carries no `existingCode` — step 1 has nothing
 *                  to match. Fixable in the adjudicator's output contract.
 *   b/not-verbatim `existingCode` is present but appears nowhere in the head
 *                  file. The quote was paraphrased, reformatted, or invented.
 *                  Fixable deterministically IF the miss is a near miss.
 *   c/outside-hunk the quote resolves to a real head-file line that is in no
 *                  hunk — the finding is about code the PR did not change.
 *                  Arguably CORRECT: GitHub cannot hang a comment there.
 *   d/path-off     the finding's `path` is not in the diff at all. Also
 *                  probably correct.
 *
 * A fix aimed at the wrong one buys nothing, and this project's history is
 * mostly that mistake. Hence a ledger before a patch.
 *
 * ── What this can and cannot see (read this before quoting a number) ───────
 *
 * **The archive has no diff.** `~/lastlight-run-artifacts/` predates the
 * staged-diff work (lever f1, 2026-08-25), so there is no
 * `.lastlight/pr-review/diff/`; this script checks and says so. What the
 * archive DOES carry is `facts.json`, with `repo`, `baseSha`, `headSha`, and
 * per-file `hunks`/`changedLines`. So the diff is RECONSTRUCTED —
 * `git diff -U3 <base>...<head>` against a local mirror of the real repo
 * (`nearform/skillspro`, private; the eval cache at
 * `<workspace>/.eval-cache/repos/` already holds a bare clone). That is a
 * faithful replica of what `post-review.ts`'s `gitDiffFiles` computed, not the
 * run's own bytes, and the two could in principle differ. As a guard the script
 * cross-checks the reconstructed changed-file set against `facts.json`'s and
 * reports any disagreement instead of quietly scoring through it.
 *
 * `facts.json`'s own `hunks` are NOT used for the commentable set: they are
 * changed-line spans, while `commentableOf` also admits the ±3 CONTEXT lines,
 * so scoring (c) off facts would over-report "outside the hunk" by up to three
 * lines each side. Reconstruct or abstain; never degrade the classification
 * silently — that failure mode is the reason this whole campaign exists.
 *
 * **The cascade here is a REPLICA.** `resolveAnchor` / `commentableOf` /
 * `needleOf` / `findRuns` live in `review-poster.ts`, which is not on the
 * `lastlight/evals` barrel, and reaching into `lastlight-core/dist/...` is
 * forbidden (see `apps/evals/CLAUDE.md`, "the barrel is the stable contract").
 * So the matching rules below are re-implemented from
 * `review-poster.ts` (`norm`/`needleOf`/`findRuns`/`newSide`/`oldSide`/
 * `commentableOf`/`resolveAnchor`) and WILL drift from it. The `?/hunk-hit`
 * bucket is the drift alarm: a finding whose quote this script finds inside a
 * hunk should have been anchored and posted inline, so any count above zero
 * there means the replica no longer matches the shipped cascade and every other
 * row is suspect.
 *
 * ── The repair probes ──────────────────────────────────────────────────────
 *
 * For every (b) row the script asks what a candidate relaxation WOULD have
 * bought, and — the part that matters — whether the rescued line is actually
 * COMMENTABLE. A relaxation that finds the quote somewhere unanchorable has
 * bought nothing.
 *
 *   R1  collapse internal whitespace, still line-by-line.
 *       (Note `norm()` already trims each line's LEADING and TRAILING
 *       whitespace, so plain indentation drift is ALREADY handled upstream —
 *       "normalise indentation" is not an available lever, it shipped.)
 *   R2  match on the longest single line of the quote, unique hit only.
 *   R3  relocate across files on a NON-unique hit when every hit is in one hunk.
 *   R4  flow-match: join needle and hay into one whitespace-collapsed string,
 *       so a multi-line construct the model rewrapped onto one line still
 *       matches.
 *
 * ── What this costs ────────────────────────────────────────────────────────
 *
 * Nothing. No model, no network. Reads the archive, a local git mirror, and
 * (for the gold subset) the `finding-calibration` label cache — the judge pass
 * already bought. An unlabelled case is reported and excluded from the gold
 * subset, never scored as zero.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   tsx scripts/anchor-forensics.ts --archive ~/lastlight-run-artifacts \
 *       --repo ~/work/nearform-evals/.eval-cache/repos/nearform__skillspro.git \
 *       [--instances <pr-review instances.json>] [--quotes N] [--by-case]
 *
 * `--instances` adds the gold-matching subset (the 6 that `say-gap` counted),
 * called out separately because n is small there and the whole-population
 * number is the one with power.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readPipelineArtifacts, type PipelineFinding } from "../src/review-pipeline-stats.js";
import type { GoldComment } from "../src/schema.js";

// ── CLI plumbing (same shape as scripts/say-gap.ts) ─────────────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--"))
    return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}
function die(msg: string): never {
  console.error(`anchor-forensics: ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * The replica — review-poster.ts's matching rules, re-implemented.
 * Every function here mirrors one there; keep the names identical so a
 * drift is a diff and not an archaeology exercise.
 * ------------------------------------------------------------------ */

interface HayLine {
  text: string;
  line: number;
}
interface Hunk {
  /** Every line, with its old-side and new-side number (null when absent). */
  lines: { text: string; left: number | null; right: number | null }[];
}
interface DiffFile {
  path: string;
  hunks: Hunk[];
}

/** `review-poster.ts` `norm` — leading/trailing whitespace is not evidence. */
const norm = (s: string): string => s.trim();

/** `review-poster.ts` `needleOf`. */
function needleOf(excerpt: string | undefined): string[] {
  if (!excerpt) return [];
  const lines = excerpt.split("\n").map(norm);
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `review-poster.ts` `findRuns` — contiguous, so one haystack per HUNK. */
function findRuns(hay: HayLine[], needle: string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (needle.length === 0 || hay.length < needle.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (norm(hay[i + j]!.text) !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ start: hay[i]!.line, end: hay[i + needle.length - 1]!.line });
  }
  return out;
}

const newSide = (h: Hunk): HayLine[] =>
  h.lines.filter((l) => l.right !== null).map((l) => ({ text: l.text, line: l.right! }));
const oldSide = (h: Hunk): HayLine[] =>
  h.lines.filter((l) => l.left !== null).map((l) => ({ text: l.text, line: l.left! }));

/** `review-poster.ts` `commentableOf` — added/context RIGHT, removed/context LEFT. */
function commentableOf(files: DiffFile[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const file of files) {
    const set = map.get(file.path) ?? new Set<string>();
    map.set(file.path, set);
    for (const hunk of file.hunks)
      for (const l of hunk.lines) {
        if (l.right !== null) set.add("RIGHT:" + l.right);
        if (l.left !== null) set.add("LEFT:" + l.left);
      }
  }
  return map;
}

/**
 * `review-poster.ts` `parseDiffFiles`, re-implemented line for line — including
 * the two behaviours that would otherwise read as bugs here:
 *   · a `+++ /dev/null` (a DELETION) yields no file, because there is no
 *     new-side path to anchor against. Five deleted files in the 1641 PR are
 *     absent from this parse for exactly that reason, and the facts.json
 *     cross-check below has to exclude them or it reports the shipped
 *     behaviour as reconstruction drift.
 *   · files are deduped by new path, so a rename pair collapses onto one entry.
 */
function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffFile>();
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let left = 0;
  let right = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      if (p === "/dev/null") file = null;
      else {
        file = byPath.get(p) ?? { path: p, hunks: [] };
        if (!byPath.has(p)) {
          byPath.set(p, file);
          files.push(file);
        }
      }
      hunk = null;
    } else if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        left = parseInt(m[1]!, 10);
        right = parseInt(m[2]!, 10);
        hunk = { lines: [] };
        if (file) file.hunks.push(hunk);
      }
    } else if (hunk && file) {
      if (line.startsWith("+")) hunk.lines.push({ text: line.slice(1), left: null, right: right++ });
      else if (line.startsWith("-")) hunk.lines.push({ text: line.slice(1), left: left++, right: null });
      else if (line.startsWith(" "))
        hunk.lines.push({ text: line.slice(1), left: left++, right: right++ });
      else if (!line.startsWith("\\")) hunk = null;
    }
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * The git mirror
 * ------------------------------------------------------------------ */

const DEFAULT_MIRRORS = [
  join(homedir(), "work", "nearform-evals", ".eval-cache", "repos"),
  resolve(".eval-cache", "repos"),
];

function findMirror(explicit: string | undefined): string {
  if (explicit) {
    if (!existsSync(explicit)) die(`--repo ${explicit} does not exist`);
    return explicit;
  }
  for (const dir of DEFAULT_MIRRORS) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((d) => d.includes("skillspro"));
    if (hit) return join(dir, hit);
  }
  die(
    `no git mirror found. Pass --repo <dir>; looked in ${DEFAULT_MIRRORS.join(", ")}.\n` +
      `  Without a mirror modes (b)/(c)/(d) cannot be told apart and this script refuses\n` +
      `  to report a degraded two-way split as if it were the four-way one.`,
  );
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

const diffCache = new Map<string, DiffFile[]>();
function diffOf(repo: string, base: string, head: string): DiffFile[] | null {
  const key = `${base}...${head}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  let files: DiffFile[];
  try {
    files = parseDiffFiles(git(repo, "diff", "--no-color", "-U3", key));
  } catch {
    return null;
  }
  diffCache.set(key, files);
  return files;
}

const fileCache = new Map<string, string | null>();
function headFile(repo: string, head: string, path: string): string | null {
  const key = `${head}:${path}`;
  if (fileCache.has(key)) return fileCache.get(key)!;
  let out: string | null;
  try {
    out = git(repo, "show", key);
  } catch {
    out = null;
  }
  fileCache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * The archive
 * ------------------------------------------------------------------ */

interface DispositionRow {
  tier?: string;
  reason?: string;
  finding?: {
    title?: string;
    path?: string;
    line?: number;
    existingCode?: string;
    side?: string;
    severity?: string;
    family?: string;
  };
}

interface ArchivedCase {
  run: string;
  instanceId: string;
  dir: string;
  baseSha: string;
  headSha: string;
  /**
   * `facts.json`'s own changed-file set, DELETIONS EXCLUDED — the cross-check on
   * the reconstruction. A deleted file has no new-side path, so `parseDiffFiles`
   * drops it on purpose and its absence is not drift.
   */
  factsFiles: Set<string>;
  disposition: DispositionRow[];
  /** PRE-anchor findings, keyed title\0existingCode; disposition carries POST-anchor. */
  pre: Map<string, { path?: string; line?: number }>;
  findings: PipelineFinding[];
}

function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function loadArchive(root: string): { cases: ArchivedCase[]; skipped: string[]; stagedDiffs: number } {
  if (!existsSync(root)) die(`no archive at ${root}`);
  const cases: ArchivedCase[] = [];
  const skipped: string[] = [];
  let stagedDiffs = 0;
  for (const run of readdirSync(root).sort()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, run)).sort();
    } catch {
      continue;
    }
    for (const instanceId of entries) {
      const dir = join(root, run, instanceId, "pr-review");
      if (!existsSync(dir)) continue;
      // Lever f1's staged diff, if this archive ever gains one.
      if (existsSync(join(dir, "diff"))) stagedDiffs++;
      const facts = readJson<{
        baseSha?: string;
        headSha?: string;
        extractors?: { facts?: { files?: { path: string; status?: string }[] } };
      }>(join(dir, "facts.json"));
      const disp = readJson<{ findings?: DispositionRow[] }>(join(dir, "disposition.json"));
      if (!facts?.baseSha || !facts.headSha || !disp?.findings?.length) {
        skipped.push(`${run}/${instanceId}${disp?.findings?.length ? "" : " (no disposition.json)"}`);
        continue;
      }
      const rawFindings =
        readJson<{ findings?: { title?: string; path?: string; line?: number; existingCode?: string }[] }>(
          join(dir, "findings.json"),
        )?.findings ?? [];
      const pre = new Map<string, { path?: string; line?: number }>();
      for (const f of rawFindings) {
        const k = `${f.title ?? ""}\u0000${f.existingCode ?? ""}`;
        if (!pre.has(k)) pre.set(k, { path: f.path, line: f.line });
      }
      cases.push({
        run,
        instanceId,
        dir,
        baseSha: facts.baseSha,
        headSha: facts.headSha,
        factsFiles: new Set(
          (facts.extractors?.facts?.files ?? []).filter((f) => f.status !== "deleted").map((f) => f.path),
        ),
        disposition: disp.findings,
        pre,
        findings: readPipelineArtifacts(dir)?.findings ?? [],
      });
    }
  }
  return { cases, skipped, stagedDiffs };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

type Mode =
  | "a/no-path"
  | "a/no-excerpt"
  | "b/not-verbatim"
  | "c/outside-hunk"
  | "d/path-off-diff"
  | "?/hunk-hit";

const MODE_ORDER: Mode[] = [
  "a/no-path",
  "a/no-excerpt",
  "b/not-verbatim",
  "c/outside-hunk",
  "d/path-off-diff",
  "?/hunk-hit",
];

const MODE_GLOSS: Record<Mode, string> = {
  "a/no-path": "no `path` — nothing to anchor onto",
  "a/no-excerpt": "no `existingCode` — step 1 had nothing to match",
  "b/not-verbatim": "quote present, found nowhere in the head file",
  "c/outside-hunk": "quote resolves in the head file, outside every hunk",
  "d/path-off-diff": "`path` is not a file the PR touched",
  "?/hunk-hit": "REPLICA DRIFT — quote sits in a hunk yet was demoted",
};

interface Row {
  run: string;
  instanceId: string;
  title: string;
  path: string | undefined;
  /** The adjudicator's own line, from findings.json — not the post-anchor one. */
  line: number | undefined;
  excerpt: string | undefined;
  mode: Mode;
  detail: string;
  /** Orthogonal cross-cut: the finding never carried a `line` at all. */
  noLine: boolean;
  /** Which relaxations would have rescued it to a COMMENTABLE line. */
  repairs: string[];
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

function ownViews(file: DiffFile | undefined): { side: "RIGHT" | "LEFT"; hay: HayLine[] }[] {
  if (!file) return [];
  const out: { side: "RIGHT" | "LEFT"; hay: HayLine[] }[] = [];
  for (const h of file.hunks) {
    out.push({ side: "RIGHT", hay: newSide(h) });
    out.push({ side: "LEFT", hay: oldSide(h) });
  }
  return out;
}

/** Every cross-file hit for step 3, new side only, as `resolveAnchor` does it. */
function relocationHits(
  files: DiffFile[],
  ownPath: string | undefined,
  needle: string[],
): { path: string; hunk: number; start: number }[] {
  const hits: { path: string; hunk: number; start: number }[] = [];
  for (const file of files) {
    if (file.path === ownPath) continue;
    file.hunks.forEach((h, hi) => {
      for (const r of findRuns(newSide(h), needle)) hits.push({ path: file.path, hunk: hi, start: r.start });
    });
  }
  return hits;
}

/** What a relaxation WOULD have bought — and only if it lands somewhere commentable. */
function probeRepairs(
  needle: string[],
  file: DiffFile | undefined,
  files: DiffFile[],
  ownPath: string | undefined,
  commentable: Map<string, Set<string>>,
): string[] {
  const out: string[] = [];
  const views = ownViews(file);
  const anchorable = (path: string, side: "RIGHT" | "LEFT", line: number): boolean =>
    commentable.get(path)?.has(`${side}:${line}`) ?? false;

  // R1 — collapse internal whitespace, still line-by-line.
  const nc = needle.map(collapse);
  for (const { side, hay } of views) {
    const view = hay.map((l) => ({ text: collapse(l.text), line: l.line }));
    const run = findRuns(view, nc)[0];
    if (run && ownPath && anchorable(ownPath, side, run.start)) {
      out.push("R1-collapse-ws");
      break;
    }
  }

  // R2 — the longest single line of the quote, UNIQUE hit only.
  const longest = [...needle].filter((l) => l.length >= 16).sort((a, b) => b.length - a.length)[0];
  if (longest) {
    const hits: { side: "RIGHT" | "LEFT"; line: number }[] = [];
    for (const { side, hay } of views) for (const r of findRuns(hay, [longest])) hits.push({ side, line: r.start });
    const distinct = new Set(hits.map((h) => `${h.side}:${h.line}`));
    if (distinct.size === 1 && ownPath && anchorable(ownPath, hits[0]!.side, hits[0]!.line))
      out.push("R2-longest-line-unique");
    else if (distinct.size > 1) out.push("R2-longest-line-AMBIGUOUS");
  }

  // R3 — relocate on a NON-unique hit when every hit is in one hunk of one file.
  const hits = relocationHits(files, ownPath, needle);
  if (hits.length > 1) {
    const oneHunk = new Set(hits.map((h) => `${h.path}#${h.hunk}`)).size === 1;
    if (oneHunk && anchorable(hits[0]!.path, "RIGHT", hits[0]!.start)) out.push("R3-relocate-one-hunk");
  }

  // R4 — flow match: the whole quote as one whitespace-collapsed string.
  const flow = collapse(needle.join(" "));
  if (flow) {
    for (const { side, hay } of views) {
      const joined = hay.map((l) => collapse(l.text));
      for (let i = 0; i < joined.length; i++) {
        let acc = "";
        for (let j = i; j < joined.length && acc.length <= flow.length + 200; j++) {
          acc = acc ? `${acc} ${joined[j]}` : joined[j]!;
          if (acc === flow || acc.includes(flow)) {
            if (ownPath && anchorable(ownPath, side, hay[i]!.line)) out.push("R4-flow-match");
            i = joined.length;
            break;
          }
        }
      }
      if (out.includes("R4-flow-match")) break;
    }
  }
  return [...new Set(out)];
}

function classify(c: ArchivedCase, repo: string, files: DiffFile[], d: DispositionRow): Row {
  const f = d.finding ?? {};
  const key = `${f.title ?? ""}\u0000${f.existingCode ?? ""}`;
  const original = c.pre.get(key);
  // The disposition row is POST-anchor. Prefer the adjudicator's own path/line
  // from findings.json: a cascade that rewrote them and STILL demoted would
  // otherwise be scored against its own output.
  const path = original?.path ?? f.path;
  const line = original?.line ?? f.line;
  const needle = needleOf(f.existingCode);
  const commentable = commentableOf(files);
  const own = files.find((x) => x.path === path);

  const base = {
    run: c.run,
    instanceId: c.instanceId,
    title: f.title ?? "(untitled)",
    path,
    line,
    excerpt: f.existingCode,
    noLine: line === undefined || line === null,
    repairs: [] as string[],
  };

  if (!path) return { ...base, mode: "a/no-path", detail: "" };
  if (!needle.length) return { ...base, mode: "a/no-excerpt", detail: "" };

  // Step 1 — did the shipped cascade actually have a hunk hit? If so this row
  // should be inline, and the replica has drifted from review-poster.ts.
  for (const { hay } of ownViews(own)) if (findRuns(hay, needle).length) return { ...base, mode: "?/hunk-hit", detail: "" };

  const content = headFile(repo, c.headSha, path);
  const inFile =
    content !== null &&
    findRuns(
      content.split("\n").map((text, i) => ({ text, line: i + 1 })),
      needle,
    ).length > 0;

  if (!own) {
    const detail = content === null ? "file absent at head" : inFile ? "quote found at head" : "quote absent at head";
    return { ...base, mode: "d/path-off-diff", detail };
  }
  if (inFile) return { ...base, mode: "c/outside-hunk", detail: "" };

  const hits = relocationHits(files, path, needle);
  const detail =
    hits.length === 1
      ? `relocatable (unique hit in ${hits[0]!.path}) — cascade should have taken it`
      : hits.length > 1
        ? `${hits.length} ambiguous cross-file hits`
        : content === null
          ? "file absent at head"
          : "nowhere in the head file";
  return {
    ...base,
    mode: "b/not-verbatim",
    detail,
    repairs: probeRepairs(needle, own, files, path, commentable),
  };
}

/* ------------------------------------------------------------------ *
 * The gold subset — same cache key as finding-calibration.ts / say-gap.ts
 * ------------------------------------------------------------------ */

type LabelCache = Record<string, { goldToFinding: (number | null)[]; matched: number; error?: string }>;

function cachePath(): string {
  return resolve(process.env.LASTLIGHT_EVALS_CACHE ?? ".eval-cache", "finding-calibration", "labels.json");
}

/** Must match `finding-calibration.ts`'s `caseDigest` byte for byte. */
function caseDigest(findings: PipelineFinding[], gold: GoldComment[]): string {
  const h = createHash("sha256");
  for (const f of findings) h.update(`${f.title}\u0000${f.path ?? ""}\u0000`);
  for (const g of gold) h.update(`${g.description}\u0000`);
  return h.digest("hex").slice(0, 16);
}

function loadGold(path: string): Map<string, GoldComment[]> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { instances?: unknown[] }).instances) as
    | { instance_id: string; review_gold?: GoldComment[] }[]
    | undefined;
  if (!list) die(`${path} is neither an array nor { instances: [...] }`);
  const out = new Map<string, GoldComment[]>();
  for (const inst of list) if (inst.review_gold?.length) out.set(inst.instance_id, inst.review_gold);
  return out;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1).padStart(5)}%` : "    —");
const bar = (n: number, d: number, w = 26): string =>
  "█".repeat(d ? Math.round((n / d) * w) : 0) + "·".repeat(w - (d ? Math.round((n / d) * w) : 0));

function main(): void {
  const archive = flag("archive") ?? join(homedir(), "lastlight-run-artifacts");
  const repo = findMirror(flag("repo"));
  const quotes = Number(flag("quotes") ?? 4);
  const instancesPath = flag("instances");

  const { cases, skipped, stagedDiffs } = loadArchive(archive);
  if (!cases.length) die(`no case-run with a disposition.json under ${archive}`);

  const rows: Row[] = [];
  const noDiff: string[] = [];
  const fileSetDrift: string[] = [];
  for (const c of cases) {
    const files = diffOf(repo, c.baseSha, c.headSha);
    if (!files) {
      noDiff.push(`${c.run}/${c.instanceId} (${c.baseSha.slice(0, 8)}...${c.headSha.slice(0, 8)} not in the mirror)`);
      continue;
    }
    // Cross-check the reconstruction against what the run's own facts saw.
    const got = new Set(files.map((f) => f.path));
    const missing = [...c.factsFiles].filter((p) => !got.has(p));
    if (missing.length) fileSetDrift.push(`${c.run}/${c.instanceId}: ${missing.length} facts file(s) absent from the reconstructed diff`);
    for (const d of c.disposition)
      if (d.tier === "body" && d.reason === "off-diff") rows.push(classify(c, repo, files, d));
  }

  console.log(`\n── ANCHOR FORENSICS · why an off-diff demotion happened ──`);
  console.log(`   archive    ${archive}`);
  console.log(`   mirror     ${repo}`);
  console.log(`   case-runs  ${cases.length} read · ${new Set(rows.map((r) => `${r.run}/${r.instanceId}`)).size} with an off-diff row`);
  console.log(
    `   diff       RECONSTRUCTED (git diff -U3 base...head). Staged diffs found in the archive: ${stagedDiffs}` +
      (stagedDiffs ? "" : " — the archive predates lever f1, as expected."),
  );
  if (skipped.length) console.log(`   skipped    ${skipped.length} case-run(s): ${skipped.join(", ")}`);
  if (noDiff.length) {
    console.log(`   NO DIFF    ${noDiff.length} case-run(s) EXCLUDED rather than guessed:`);
    for (const n of noDiff) console.log(`     · ${n}`);
  }
  if (fileSetDrift.length) {
    console.log(`   DRIFT      the reconstruction disagrees with facts.json on ${fileSetDrift.length} case-run(s):`);
    for (const d of fileSetDrift) console.log(`     · ${d}`);
    console.log(`              treat (c)/(d) below as suspect on those.`);
  } else {
    console.log(`   cross-check every non-deleted facts.json file is present in the reconstructed diff ✓`);
  }

  const n = rows.length;
  const count = (m: Mode) => rows.filter((r) => r.mode === m).length;
  console.log(`\n   ${"failure mode".padEnd(16)} ${"n".padStart(4)}  ${"share".padStart(6)}  distribution`);
  for (const m of MODE_ORDER) {
    const c = count(m);
    if (!c && m === "?/hunk-hit") continue;
    console.log(`   ${m.padEnd(16)} ${String(c).padStart(4)}  ${pct(c, n)}  ${bar(c, n)}  ${MODE_GLOSS[m]}`);
  }
  console.log(`   ${"TOTAL".padEnd(16)} ${String(n).padStart(4)}`);
  if (count("?/hunk-hit"))
    console.log(
      `\n   !! ${count("?/hunk-hit")} row(s) in ?/hunk-hit. The replica of the cascade in this\n` +
        `      script no longer matches review-poster.ts. Every other number above is\n` +
        `      suspect until that is reconciled.`,
    );

  // Sub-detail, so (d) and (b) don't hide two different stories under one head.
  console.log(`\n── SUB-DETAIL ──`);
  const detail = new Map<string, number>();
  for (const r of rows) if (r.detail) detail.set(`${r.mode} · ${r.detail}`, (detail.get(`${r.mode} · ${r.detail}`) ?? 0) + 1);
  for (const [k, c] of [...detail].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(4)}  ${k}`);

  // The cross-cut nobody asked for and the data insists on.
  const noLine = rows.filter((r) => r.noLine);
  console.log(`\n── CROSS-CUT: findings that carried no \`line\` at all ──`);
  console.log(`   ${noLine.length} / ${n}  ${pct(noLine.length, n)}`);
  if (noLine.length) {
    const byCase = new Map<string, number>();
    for (const r of noLine) byCase.set(`${r.run}/${r.instanceId}`, (byCase.get(`${r.run}/${r.instanceId}`) ?? 0) + 1);
    for (const [k, c] of [...byCase].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(4)}  ${k}`);
    console.log(
      `   This is orthogonal to the cascade: \`anchorFindings\` runs on a finding with\n` +
        `   no \`line\` (the advisory only breaks ties in \`nearest()\`), so a no-line\n` +
        `   finding with a matchable quote still anchors. What kills these is the quote.\n` +
        `   Read the concentration above before generalising — one bad adjudicator\n` +
        `   output can own the mode.`,
    );
  }

  // Repairs.
  console.log(`\n── REPAIR PROBES · would a relaxation have rescued the (b) rows? ──`);
  const brows = rows.filter((r) => r.mode === "b/not-verbatim");
  const repairTally = new Map<string, number>();
  let rescued = 0;
  for (const r of brows) {
    const real = r.repairs.filter((x) => !x.endsWith("AMBIGUOUS"));
    if (real.length) rescued++;
    for (const x of r.repairs) repairTally.set(x, (repairTally.get(x) ?? 0) + 1);
  }
  console.log(`   (b) population ${brows.length} of ${n} off-diff rows  ${pct(brows.length, n)}`);
  if (!repairTally.size) console.log(`   NOTHING rescues any of them.`);
  for (const [k, c] of [...repairTally].sort((a, b) => b[1] - a[1]))
    console.log(`   ${String(c).padStart(4)} / ${brows.length}  ${k}`);
  console.log(
    `   net rescued to a COMMENTABLE line: ${rescued} of ${brows.length} (b) rows = ${rescued} of ${n} demotions ${pct(rescued, n)}`,
  );
  console.log(
    `   (indentation is NOT on this list because \`norm()\` already trims every line\n` +
      `    on both sides — that relaxation shipped with WP6a.)`,
  );
  // Always listed, never gated on --quotes: a rescue count is not a result
  // until somebody has looked at WHAT got rescued. A relaxation that saves one
  // real finding and one prose line has bought nothing at 1:1.
  const rescuedRows = brows.filter((r) => r.repairs.some((x) => !x.endsWith("AMBIGUOUS")));
  if (rescuedRows.length) {
    console.log(`\n   every rescued row, in full — audit them before believing the count:`);
    for (const r of rescuedRows) {
      console.log(`     · ${r.repairs.join(", ")}  ${r.instanceId}  ${r.path ?? "—"}:${r.line ?? "—"}`);
      console.log(`       title  ${r.title.slice(0, 96)}`);
      console.log(`       quote  ${(r.excerpt ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }

  // Quotes, so a human can audit the classifier rather than trust it.
  if (quotes > 0) {
    console.log(`\n── SAMPLE QUOTES (audit the classifier, don't trust it) ──`);
    for (const m of MODE_ORDER) {
      const sample = rows.filter((r) => r.mode === m).slice(0, quotes);
      if (!sample.length) continue;
      console.log(`\n   ${m} — ${MODE_GLOSS[m]}`);
      for (const r of sample) {
        console.log(`     ${r.instanceId}  ${r.path ?? "(no path)"}:${r.line ?? "—"}  ${r.detail}`);
        console.log(`       title  ${r.title.slice(0, 96)}`);
        console.log(`       quote  ${(r.excerpt ?? "(none)").replace(/\s+/g, " ").slice(0, 110)}`);
        if (r.repairs.length) console.log(`       repair ${r.repairs.join(", ")}`);
      }
    }
  }

  if (has("by-case")) {
    console.log(`\n── BY CASE ──`);
    const byCase = new Map<string, Row[]>();
    for (const r of rows) (byCase.get(r.instanceId) ?? byCase.set(r.instanceId, []).get(r.instanceId)!).push(r);
    for (const [id, rs] of [...byCase].sort()) {
      console.log(`\n   ${id}  (${new Set(rs.map((r) => r.run)).size} run(s), ${rs.length} off-diff row(s))`);
      for (const m of MODE_ORDER) {
        const c = rs.filter((r) => r.mode === m).length;
        if (c) console.log(`     ${m.padEnd(16)} ${String(c).padStart(4)}`);
      }
    }
  }

  // ── The gold-matching subset ───────────────────────────────────────────
  if (instancesPath) {
    console.log(`\n── GOLD-MATCHING SUBSET (say-gap's 6) ──`);
    const gold = loadGold(instancesPath);
    const cache: LabelCache = readJson<LabelCache>(cachePath()) ?? {};
    const goldRows: Row[] = [];
    const unlabelled: string[] = [];
    for (const c of cases) {
      const g = gold.get(c.instanceId);
      if (!g?.length) continue;
      const label = cache[caseDigest(c.findings, g)];
      if (!label || label.error) {
        unlabelled.push(`${c.run}/${c.instanceId}`);
        continue;
      }
      const files = diffOf(repo, c.baseSha, c.headSha);
      if (!files) continue;
      for (const idx of label.goldToFinding) {
        if (idx === null || idx === undefined) continue;
        const f = c.findings[idx];
        if (!f || f.tier !== "body" || f.reason !== "off-diff") continue;
        const d = c.disposition.find((x) => x.finding?.title === f.title && x.reason === "off-diff");
        if (d) goldRows.push(classify(c, repo, files, d));
      }
    }
    if (unlabelled.length)
      console.log(`   UNLABELLED ${unlabelled.length} case-run(s), EXCLUDED rather than scored as zero:\n     · ${unlabelled.join("\n     · ")}`);
    console.log(`   ${goldRows.length} gold finding(s) lost their inline slot to off-diff.`);
    for (const m of MODE_ORDER) {
      const c = goldRows.filter((r) => r.mode === m).length;
      if (c) console.log(`   ${m.padEnd(16)} ${String(c).padStart(4)}  ${pct(c, goldRows.length)}  ${MODE_GLOSS[m]}`);
    }
    for (const r of goldRows) {
      console.log(`     · ${r.instanceId}  ${r.mode}  ${r.path ?? "—"}:${r.line ?? "—"}  ${r.detail}`);
      console.log(`       ${r.title.slice(0, 100)}`);
    }
    console.log(
      `   n is small here by construction. The whole-population table above is the\n` +
        `   one with power; this is the sanity check that the two agree in shape.`,
    );
  } else {
    console.log(`\n   (pass --instances <pr-review instances.json> for the gold-matching subset)`);
  }

  // ── The verdict ────────────────────────────────────────────────────────
  const correct = count("c/outside-hunk") + count("d/path-off-diff");
  const fixable = count("a/no-path") + count("a/no-excerpt") + count("b/not-verbatim");
  console.log(`\n── WHAT THE DATA SUPPORTS ──`);
  console.log(`   boundary behaving correctly (c+d)  ${String(correct).padStart(4)} / ${n}  ${pct(correct, n)}`);
  console.log(`   conceivably fixable       (a+b)    ${String(fixable).padStart(4)} / ${n}  ${pct(fixable, n)}`);
  console.log(`   actually rescued by any probe      ${String(rescued).padStart(4)} / ${n}  ${pct(rescued, n)}`);
  if (rescued * 10 < n) {
    console.log(
      `\n   VERDICT: no deterministic change to the cascade is supported. The rescued\n` +
        `   share is under 10% of demotions, so widening the matcher buys attention on\n` +
        `   a handful of rows while adding a new way to point a comment at the wrong\n` +
        `   code — the exact corruption step 4 was left unbuilt to avoid. (c)+(d) are\n` +
        `   the boundary doing its job: GitHub cannot hang an inline comment on a line\n` +
        `   the PR did not touch. THIS LEVER IS KILLED, and a killed lever gets the\n` +
        `   same write-up as a kept one.`,
    );
    if (fixable > correct / 2)
      console.log(
        `\n   The residue is NOT an anchoring problem: it is an OUTPUT-CONTRACT problem\n` +
          `   in the adjudicator — \`existingCode\` filled with prose or a summary instead\n` +
          `   of a verbatim excerpt. No matcher can fix that; a schema check and a\n` +
          `   countable warning can. That is a different work item, in a different file.`,
      );
  } else {
    console.log(
      `\n   VERDICT: the probes above rescue a material share. Take the single\n` +
        `   highest-scoring one, implement ONLY that, and re-measure — the ladder's\n` +
        `   rule is one lever per rung.`,
    );
  }
  console.log();
}

main();
