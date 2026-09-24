#!/usr/bin/env -S npx tsx
/**
 * What did the `falsify` phase actually DELETE — and could any of it have been
 * a real defect?
 *
 * ## Why this exists
 *
 * Until probes shipped, the pipeline could not lose a hypothesis. The
 * conservation floor (`lastlight-facts findings --repair`) restored every
 * dropped row at `internal`, so "the adjudicator binned it" and "nobody
 * hypothesised it" were the same state and `say-gap.ts` could say so in its
 * header. That is no longer true. The floor deliberately does **not** restore a
 * drop whose `refutedBy` names a probe transcript that exists on disk: a backed
 * drop is a legitimate drop. It is correct by design, and it is the one path by
 * which this pipeline can now lose a real finding permanently.
 *
 * The standing risk is not hypothetical. A verification layer bolted onto a
 * generator raises precision and costs recall — measured twice externally
 * (precision 54.5 → 67.1 against recall 45.5 → 39.8). The first legitimate
 * deletions in the project's history have just been measured (one case: 5
 * refutations, 5 deletions, every one citing a real transcript, none of them
 * gold) and nothing in the harness could answer the only question a go/no-go
 * needs: **did any deletion cost us a gold finding?** This is that instrument.
 *
 * ## What it reports, per arm and per case
 *
 *   1. How many hypotheses were deleted, and whether every `refutedBy` resolves
 *      on disk. A drop citing a MISSING transcript should have been restored by
 *      the floor — that is a floor bug, and it is printed as an alarm rather
 *      than counted quietly.
 *   2. The deleted hypotheses' own claim text and anchors. **This is the
 *      primary output.** The counts are secondary: a human reading five claims
 *      learns more than any tally of them.
 *   3. A file-level (optionally ±N-line) coincidence check against gold.
 *
 * ## What point 3 is NOT — read this before quoting any number from it
 *
 * **The coincidence count is a CEILING**, exactly as in `facts-obligations.ts`.
 * A deleted hypothesis naming `users.ts` is not the finding that would have
 * matched the gold about `users.ts`; it has named the same file. Naming is
 * necessary, never sufficient, and the script repeats this beside every count
 * it prints because a coincidence count read as a recall loss is the most
 * plausible way to misuse this output.
 *
 * The inverse misreading is just as wrong: **zero coincidences is not proof of
 * safety.** A deletion can only be *proven* harmless by a paired comparison
 * against an arm that did not delete it. That is what `--vs` is for, and even
 * that is circumstantial — two arms differ in more than their deletions.
 *
 * ## Inputs — all already on disk, all free
 *
 * - **Run directories** (positional). `persistPipelineArtifacts` now writes the
 *   artifacts into the run dir itself, unconditionally, at
 *   `results[].pipelineArtifactRel`. The older hand-copied archive layout
 *   (`~/lastlight-run-artifacts/<run>/<instance>/pr-review/`) is read too, via
 *   `--archive`; it carries no arm label, so those case-runs report `(archive)`.
 * - **Gold** from a `pr-review` `instances.json` (`--instances`), the same
 *   loader `say-gap.ts` uses.
 * - **Hypothesis identity is POSITIONAL** — `<family>-NNN` from the filename
 *   plus append order, with a model-declared `id` honoured only as an
 *   unambiguous alias. That is `code-facts`' own rule, mirrored in
 *   `review-pipeline-stats.ts` and `finding-calibration.ts`; get it wrong and
 *   the join is silently off by one row rather than loudly broken.
 *
 * **`refutedBy` is written in two vocabularies.** Runs measured on 2026-09-21
 * carry both `probes/enforcement-012.txt` (relative to the artifact directory)
 * and `.lastlight/pr-review/probes/state-003.txt` (relative to the repo
 * checkout) — same pipeline, same day. Both are resolved, and the form each
 * citation needed is recorded, because a reader that knew only the first
 * reported three legitimately-backed drops as a floor bug. The script says so
 * when it sees both forms in one measurement: if the FLOOR reads only one of
 * them, it is restoring inconsistently, and nothing here can see which form it
 * read.
 *
 * No model call, no network, nothing written. A case with no artifacts or no
 * gold is reported BY NAME as unmeasured and excluded — never scored as zero.
 *
 * ## Usage
 *
 *   npx tsx scripts/deletion-risk.ts <run dir> [more ...] \
 *       --instances <path to pr-review instances.json> \
 *       [--archive <dir>] [--window N] [--full] \
 *       [--vs <run dir> [more ...]]
 *
 * `--window N` adds the tighter line-window bar beside the file-level one.
 * `--full` prints whole claims instead of the first 3 wrapped lines.
 * `--vs` names a comparator arm over the same cases and turns on the paired
 * read — the closest thing to a causal claim available without re-running.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { goldHits, internalGoldHits } from "../src/review-metrics.js";
import type { Scorecard } from "../src/report.js";
import type { InstanceResult } from "../src/schema.js";

// ── CLI plumbing (same shape as say-gap.ts / facts-obligations.ts) ───────────

function die(msg: string): never {
  console.error(`deletion-risk: ${msg}`);
  process.exit(1);
}

const VALUE_FLAGS = new Set(["--instances", "--archive", "--window"]);

export interface Args {
  /** Run dirs (or `scorecard.json` paths) for the arm under test. */
  runs: string[];
  /** Run dirs after `--vs` — the comparator arm. */
  vs: string[];
  instances?: string;
  archive?: string;
  window: number | null;
  full: boolean;
}

/**
 * `--vs` is a SEPARATOR, not a one-value flag (band.ts's rule): a comparator
 * arm is as often a repeat band as a single run, and a one-value flag would
 * silently measure against one of its repeats.
 */
export function parseArgs(argv: string[]): Args {
  const out: Args = { runs: [], vs: [], window: null, full: false };
  let target = out.runs;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vs") {
      target = out.vs;
      continue;
    }
    if (a === "--full") {
      out.full = true;
      continue;
    }
    if (a.includes("=") && a.startsWith("--")) {
      const [k, v] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
      if (!VALUE_FLAGS.has(k)) die(`unknown flag ${k}`);
      if (k === "--instances") out.instances = v;
      else if (k === "--archive") out.archive = v;
      else out.window = Number(v);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      if (a === "--instances") out.instances = v;
      else if (a === "--archive") out.archive = v;
      else out.window = Number(v);
      continue;
    }
    if (a.startsWith("--")) die(`unknown flag ${a}`);
    target.push(a);
  }
  return out;
}

// ── The shapes the join works over ──────────────────────────────────────────

/** A gold finding, in the shape `pr-review` `instances.json` stores it. */
export interface GoldFinding {
  file?: string;
  line?: number;
  severity?: string;
  description: string;
}

/** A place in the tree a hypothesis pointed at. */
export interface Anchor {
  path: string;
  /** 0 when the row named a file with no line. */
  line: number;
  /** `introduced` / `enforced` / `quote` — where in the row it came from. */
  end: string;
}

/** One survey hypothesis, under its CANONICAL positional id. */
export interface HypothesisRow {
  id: string;
  family: string;
  /** The row's own `id` field when the model wrote one that is not canonical. */
  declaredId?: string;
  claim: string;
  anchors: Anchor[];
}

/** A `findings.json` `dropped[]` entry. */
export interface DroppedEntry {
  hypothesis?: string;
  refutedBy?: string;
}

export interface DeletionJoinInput {
  run: string;
  arm: string;
  instanceId: string;
  dropped: DroppedEntry[];
  /** Canonical id → row. */
  hypotheses: Map<string, HypothesisRow>;
  /** Model-declared id → the canonical id it unambiguously names. */
  aliases: Map<string, string>;
  /** Does this `refutedBy` path resolve on disk? Injected so the join is pure. */
  transcriptExists: (rel: string) => boolean;
  gold: GoldFinding[];
  /** Line window for the tighter coincidence bar; `null` = file level only. */
  window: number | null;
}

/** One deleted hypothesis, joined to its row and to the case's gold. */
export interface DeletionRow {
  run: string;
  arm: string;
  instanceId: string;
  /** The id exactly as `dropped[]` wrote it. */
  citedId: string;
  /** The canonical id it resolved to — `null` when the join FAILED. */
  canonicalId: string | null;
  family: string | null;
  claim: string | null;
  anchors: Anchor[];
  refutedBy: string | null;
  /**
   * False when `refutedBy` is absent or names a path that is not on disk under
   * EITHER citation form. The floor should have restored such a drop; a `false`
   * here is a FLOOR BUG, not a statistic.
   */
  transcriptResolves: boolean;
  /**
   * Which form the citation had to be read as to resolve.
   *
   * `artifact` — `probes/x.txt`, relative to the artifact directory.
   * `repo` — `.lastlight/pr-review/probes/x.txt`, relative to the repo
   * checkout. Both forms occur in runs measured on 2026-09-21, from the same
   * pipeline on the same day, and a reader that understood only one of them
   * reported three legitimately-backed drops as a floor bug.
   * `null` when nothing resolved.
   */
  citationForm: "artifact" | "repo" | null;
  /** Gold indices whose FILE one of this row's anchors named. A ceiling. */
  goldFileHits: number[];
  /** Subset of the above also within `window` lines. Strictly smaller. */
  goldWindowHits: number[];
}

// ── Positional identity (mirror of code-facts' readJsonlRows ingest) ────────

/** `<family>-NNN` — the identity `code-facts` assigns at ingest. */
export const hypothesisId = (family: string, ordinal: number): string =>
  `${family}-${String(ordinal).padStart(3, "0")}`;

/** `src/a.ts:115` → `{path, line}`; a bare path yields line 0. */
export function splitSite(site: string): { path: string; line: number } {
  const bare = site.replace(/\s+\(test\)$/, "").trim();
  const m = /^(.*):(\d+)(?:-\d+)?$/.exec(bare);
  return m ? { path: m[1], line: Number(m[2]) } : { path: bare, line: 0 };
}

/** Where the pipeline writes, relative to the seeded repo checkout. */
const REPO_PREFIX = ".lastlight/pr-review/";

/**
 * The forms a `refutedBy` citation is written in, in the order they are tried.
 *
 * The adjudicator writes the path it had in hand, and which path that is has
 * changed: `probes/enforcement-012.txt` on one run and
 * `.lastlight/pr-review/probes/state-003.txt` on another — same pipeline, same
 * day. Both name the same file. Resolving only the first turns every drop from
 * the second run into a floor-bug alarm, which is the loudest possible way to
 * be wrong here.
 */
export function transcriptCandidates(rel: string): { form: "artifact" | "repo"; path: string }[] {
  const out: { form: "artifact" | "repo"; path: string }[] = [{ form: "artifact", path: rel }];
  if (rel.startsWith(REPO_PREFIX)) out.push({ form: "repo", path: rel.slice(REPO_PREFIX.length) });
  return out;
}

const asRecord = (row: unknown): Record<string, unknown> =>
  row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};

function anchorsOf(row: Record<string, unknown>): Anchor[] {
  const out: Anchor[] = [];
  const ends = asRecord(row.bothEnds);
  for (const [key, end] of [
    ["introduced", ends.introducedAt],
    ["enforced", ends.enforcedAt],
  ] as const) {
    if (typeof end === "string" && end.trim()) out.push({ ...splitSite(end), end: key });
  }
  // Some rows carry a flat `path`/`line` instead of (or beside) `bothEnds`.
  if (typeof row.path === "string" && row.path.trim())
    out.push({ path: row.path, line: typeof row.line === "number" ? row.line : 0, end: "introduced" });
  for (const q of Array.isArray(row.quotes) ? row.quotes : []) {
    const qq = asRecord(q);
    if (typeof qq.path === "string" && qq.path.trim())
      out.push({ path: qq.path, line: typeof qq.line === "number" ? qq.line : 0, end: "quote" });
  }
  return out;
}

/**
 * Index one case's `hypotheses/<family>.jsonl` files into canonical rows.
 *
 * **The ordinal a row lands on IS its identity**, so the parse rules are
 * copied, not approximated: blank lines are skipped, an unparseable line is
 * skipped *without consuming an ordinal* (a torn final line on a killed run is
 * normal), and anything that parses consumes one even if it is not an object.
 * A reader that dropped a scalar line would shift every later row's id and
 * mis-resolve every citation after it — silently, and in the direction of
 * reporting a deletion as unjoinable.
 *
 * A model-declared `id` becomes an ALIAS only when it does not shadow a
 * canonical id and exactly one row claims it — `code-facts`' own rule, so a row
 * declaring `contract-001` from third position cannot capture citations meant
 * for the real first row.
 */
export function indexHypotheses(files: Map<string, string>): {
  hypotheses: Map<string, HypothesisRow>;
  aliases: Map<string, string>;
} {
  const hypotheses = new Map<string, HypothesisRow>();
  const claims = new Map<string, string[]>();

  for (const [family, text] of [...files].sort()) {
    let ordinal = 0;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t) as unknown;
      } catch {
        continue; // consumes no ordinal, exactly as code-facts does
      }
      ordinal += 1;
      const row = asRecord(parsed);
      const id = hypothesisId(family, ordinal);
      const declared = typeof row.id === "string" && row.id !== id ? row.id : undefined;
      hypotheses.set(id, {
        id,
        family,
        ...(declared ? { declaredId: declared } : {}),
        claim: typeof row.claim === "string" ? row.claim : typeof row.title === "string" ? row.title : "",
        anchors: anchorsOf(row),
      });
      if (declared) claims.set(declared, [...(claims.get(declared) ?? []), id]);
    }
  }

  const aliases = new Map<string, string>();
  for (const [declared, claimedBy] of claims) {
    if (hypotheses.has(declared) || claimedBy.length !== 1) continue;
    aliases.set(declared, claimedBy[0]);
  }
  return { hypotheses, aliases };
}

// ── The join ────────────────────────────────────────────────────────────────

/**
 * Join `dropped[]` → the hypothesis rows → the case's gold.
 *
 * Pure: every filesystem question is asked through `transcriptExists`, so this
 * is the part with a test.
 *
 * The gold coincidence is FILE level (plus an optional line window) and is a
 * ceiling in both directions — see the header. It is computed over every anchor
 * the row carried, including quotes, because a hypothesis that quoted the gold's
 * file is exactly as interesting here as one whose `bothEnds` named it.
 */
export function joinDeletions(input: DeletionJoinInput): DeletionRow[] {
  const resolveId = (cited: string): string | null =>
    input.hypotheses.has(cited) ? cited : (input.aliases.get(cited) ?? null);

  return input.dropped.map((d) => {
    const cited = typeof d.hypothesis === "string" ? d.hypothesis : "";
    const canonicalId = cited ? resolveId(cited) : null;
    const row = canonicalId ? input.hypotheses.get(canonicalId) : undefined;
    const anchors = row?.anchors ?? [];
    const refutedBy = typeof d.refutedBy === "string" && d.refutedBy.trim() ? d.refutedBy : null;
    const resolved = refutedBy
      ? (transcriptCandidates(refutedBy).find((c) => input.transcriptExists(c.path)) ?? null)
      : null;

    const goldFileHits: number[] = [];
    const goldWindowHits: number[] = [];
    input.gold.forEach((g, j) => {
      if (!g.file) return;
      const naming = anchors.filter((a) => a.path === g.file);
      if (!naming.length) return;
      goldFileHits.push(j);
      if (
        input.window !== null &&
        g.line !== undefined &&
        naming.some((a) => a.line > 0 && Math.abs(a.line - g.line!) <= input.window!)
      )
        goldWindowHits.push(j);
    });

    return {
      run: input.run,
      arm: input.arm,
      instanceId: input.instanceId,
      citedId: cited,
      canonicalId,
      family: row?.family ?? null,
      claim: row?.claim ?? null,
      anchors,
      refutedBy,
      transcriptResolves: resolved !== null,
      citationForm: resolved?.form ?? null,
      goldFileHits,
      goldWindowHits,
    };
  });
}

// ── Loading (the impure half) ───────────────────────────────────────────────

/** One case-run's artifact directory, with whatever label the layout gives it. */
interface CaseDir {
  run: string;
  arm: string;
  instanceId: string;
  dir: string;
  /** The scorecard row, when the layout has one (`--vs` needs it). */
  result?: InstanceResult;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function loadGold(path: string): Map<string, GoldFinding[]> {
  const raw = readJson<unknown>(path);
  if (raw === undefined) die(`cannot read ${path}`);
  const list = (Array.isArray(raw) ? raw : (raw as { instances?: unknown[] }).instances) as
    | { instance_id: string; review_gold?: GoldFinding[] }[]
    | undefined;
  if (!list) die(`${path} is neither an array nor { instances: [...] }`);
  const out = new Map<string, GoldFinding[]>();
  for (const inst of list) out.set(inst.instance_id, inst.review_gold ?? []);
  return out;
}

/** Accept a run dir or the `scorecard.json` inside it (band.ts's rule). */
function scorecardPath(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, "scorecard.json");
  return abs;
}

/**
 * Case-runs from a RUN DIRECTORY — the layout `persistPipelineArtifacts` writes
 * today. `pipelineArtifactRel` is relative to the run dir, deliberately, so the
 * directory stays portable.
 *
 * A result with no `pipelineArtifactRel` ran no pipeline (a baseline arm);
 * that is absent, not empty, and it is reported as unmeasured by name.
 */
function loadRunDir(p: string, unmeasured: string[]): CaseDir[] {
  const card = scorecardPath(p);
  const root = dirname(card);
  const sc = readJson<Scorecard>(card);
  if (!sc) die(`no readable scorecard at ${card}`);
  const run = sc.meta?.runId ?? root;
  const out: CaseDir[] = [];
  for (const r of sc.results ?? []) {
    if (!r.pipelineArtifactRel) {
      unmeasured.push(`${run}/${r.instance_id} [${r.model}] — no pipeline artifacts (baseline arm, or an older run)`);
      continue;
    }
    const dir = join(root, r.pipelineArtifactRel);
    if (!existsSync(dir)) {
      unmeasured.push(`${run}/${r.instance_id} [${r.model}] — ${r.pipelineArtifactRel} is recorded but missing`);
      continue;
    }
    out.push({ run, arm: r.model, instanceId: r.instance_id, dir, result: r });
  }
  return out;
}

/**
 * Case-runs from the older hand-copied archive
 * (`<archive>/<run>/<instance>/pr-review/`). It predates the run-dir copy and
 * carries no arm label at all, so those rows report `(archive)` rather than
 * inventing one — and no `--vs` read is possible over them.
 */
function loadArchive(root: string): CaseDir[] {
  if (!existsSync(root)) die(`no archive at ${root}`);
  const out: CaseDir[] = [];
  for (const run of readdirSync(root)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, run));
    } catch {
      continue;
    }
    for (const instanceId of entries) {
      const dir = join(root, run, instanceId, "pr-review");
      if (existsSync(dir)) out.push({ run, arm: "(archive)", instanceId, dir });
    }
  }
  return out;
}

/** The `hypotheses/<family>.jsonl` texts of one artifact dir. */
function hypothesisFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[] = [];
  try {
    files = readdirSync(join(dir, "hypotheses")).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      out.set(f.replace(/\.jsonl$/, ""), readFileSync(join(dir, "hypotheses", f), "utf8"));
    } catch {
      /* unreadable is the same as absent for this measurement */
    }
  }
  return out;
}

// ── Report ──────────────────────────────────────────────────────────────────

const CEILING =
  "CEILING — naming a gold's file is not being the finding that would have matched it.\n" +
  "   Do not read a coincidence as a lost gold; do not read zero coincidences as safety.\n" +
  "   Only the --vs paired read is evidence either way, and even that is circumstantial.";

/** `†` marks a sample too small to carry a rate, exactly as the neighbours do. */
const mark = (n: number): string => (n < 10 ? "†" : " ");

function wrap(text: string, width: number, indent: string, maxLines: number | null): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(indent + cur.trim());
      cur = w;
    } else cur = `${cur} ${w}`;
  }
  if (cur.trim()) lines.push(indent + cur.trim());
  if (maxLines !== null && lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1]} …`;
    return cut;
  }
  return lines;
}

/** `label:` on the first line, hanging-indented after it. */
function labelled(label: string, text: string, maxLines: number | null): string[] {
  const lines = wrap(text, 92, " ".repeat(label.length), maxLines);
  if (!lines.length) return [label];
  lines[0] = label + lines[0].trimStart();
  return lines;
}

interface CaseRun {
  dir: CaseDir;
  rows: DeletionRow[];
  gold: GoldFinding[];
}

function collect(dirs: CaseDir[], gold: Map<string, GoldFinding[]>, window: number | null, unmeasured: string[]): CaseRun[] {
  const out: CaseRun[] = [];
  for (const d of dirs) {
    const findings = readJson<{ dropped?: DroppedEntry[] }>(join(d.dir, "findings.json"));
    if (!findings) {
      unmeasured.push(`${d.run}/${d.instanceId} [${d.arm}] — no readable findings.json`);
      continue;
    }
    const g = gold.get(d.instanceId);
    if (g === undefined) {
      unmeasured.push(`${d.run}/${d.instanceId} [${d.arm}] — no gold for this instance in --instances`);
      continue;
    }
    const { hypotheses, aliases } = indexHypotheses(hypothesisFiles(d.dir));
    out.push({
      dir: d,
      gold: g,
      rows: joinDeletions({
        run: d.run,
        arm: d.arm,
        instanceId: d.instanceId,
        dropped: findings.dropped ?? [],
        hypotheses,
        aliases,
        transcriptExists: (rel) => existsSync(join(d.dir, rel)),
        gold: g,
        window,
      }),
    });
  }
  return out;
}

// ── The paired read (`--vs`) ────────────────────────────────────────────────

interface PairedLoss {
  run: string;
  arm: string;
  instanceId: string;
  goldIndex: number;
  gold: GoldFinding;
  surface: "posted" | "internal";
  /** A deletion in THIS arm whose anchors named the gold's file. */
  deletions: DeletionRow[];
}

/**
 * Per gold: found by the comparator, missed here — intersected with "this arm
 * deleted a hypothesis naming that file".
 *
 * Both surfaces are read because they answer different questions: the posted
 * vectors (`trace.gold[j].matchedFinding`) say what the user saw, the internal
 * vectors (`pipeline.internalGold`) say what the pipeline generated. A deletion
 * costing recall shows up on the INTERNAL surface first — the finding stopped
 * existing — so an internal loss with a matching deletion is the strongest
 * circumstantial evidence this script can produce. Both come from
 * `review-metrics.ts` (`goldHits` / `internalGoldHits`), never reimplemented.
 */
export function pairedLosses(
  here: CaseRun[],
  comparator: Map<string, InstanceResult[]>,
): { losses: PairedLoss[]; uncomparable: string[] } {
  const losses: PairedLoss[] = [];
  const uncomparable: string[] = [];
  for (const c of here) {
    const mine = c.dir.result;
    const theirs = comparator.get(c.dir.instanceId) ?? [];
    if (!mine || !theirs.length) {
      uncomparable.push(`${c.dir.instanceId} [${c.dir.arm}] — not present in the comparator`);
      continue;
    }
    for (const surface of ["posted", "internal"] as const) {
      const read = surface === "posted" ? goldHits : internalGoldHits;
      const ours = read(mine);
      // A gold is "found by the comparator" if ANY comparator run found it —
      // the union, so a flaky comparator cannot manufacture a loss here.
      const vectors = theirs.map(read).filter((v): v is boolean[] => v !== undefined);
      if (!ours || !vectors.length) {
        uncomparable.push(`${c.dir.instanceId} [${c.dir.arm}] — no ${surface} vector on one side (absent, not zero)`);
        continue;
      }
      c.gold.forEach((g, j) => {
        const theirHit = vectors.some((v) => v[j] === true);
        if (!theirHit || ours[j] === true) return;
        losses.push({
          run: c.dir.run,
          arm: c.dir.arm,
          instanceId: c.dir.instanceId,
          goldIndex: j,
          gold: g,
          surface,
          deletions: c.rows.filter((r) => r.goldFileHits.includes(j)),
        });
      });
    }
  }
  return { losses, uncomparable };
}

// ── main ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { runs, vs: vsRuns, full } = args;
  const instances = args.instances;
  if (!instances) die("--instances <path to pr-review instances.json> is required");
  const window = args.window;
  if (window !== null && !Number.isFinite(window)) die("--window needs a number of lines");
  const archive = args.archive ? resolve(args.archive) : null;
  if (!runs.length && !archive)
    die("pass at least one run directory, or --archive <dir> for the older hand-copied layout");

  const gold = loadGold(instances);
  const unmeasured: string[] = [];
  const dirs: CaseDir[] = [
    ...runs.flatMap((r) => loadRunDir(r, unmeasured)),
    ...(archive ? loadArchive(archive) : []),
  ];
  const cases = collect(dirs, gold, window, unmeasured);

  // LD6: an empty result is an error, not a pass. "No artifacts anywhere" and
  // "artifacts everywhere and nothing was deleted" are opposite findings and
  // must never print the same.
  if (!cases.length)
    die(
      `no case-run with readable artifacts AND gold.\n` +
        unmeasured.map((u) => `  · ${u}`).join("\n") +
        `\n  Nothing was measured — this is not "zero deletions".`,
    );

  const rows = cases.flatMap((c) => c.rows);
  const caseRuns = cases.length;
  const withGold = cases.filter((c) => c.gold.length).length;
  const unbacked = rows.filter((r) => !r.transcriptResolves);
  const unjoined = rows.filter((r) => r.canonicalId === null);
  const coincident = rows.filter((r) => r.goldFileHits.length);
  const windowed = rows.filter((r) => r.goldWindowHits.length);

  console.log(`\n── DELETION RISK ──`);
  console.log(`   case-runs   ${caseRuns} (${withGold} carrying gold) · gold instances ${new Set(cases.map((c) => c.dir.instanceId)).size}`);
  console.log(`   arms        ${[...new Set(cases.map((c) => c.dir.arm))].join(", ")}`);
  console.log(`   instances   ${resolve(instances)}`);
  console.log(`   window      ${window === null ? "(file level only — pass --window N for the tighter bar)" : `±${window} lines, beside the file-level bar`}`);
  if (unmeasured.length) {
    console.log(`   UNMEASURED  ${unmeasured.length} case-run(s), excluded rather than scored as zero:`);
    for (const u of unmeasured) console.log(`     · ${u}`);
  }

  // ── 1. counts, and the floor alarm ────────────────────────────────────────
  console.log(`\n── 1. WHAT WAS DELETED ──`);
  // The run id is a column, not a detail: two repeats of one arm over one case
  // are two independent case-runs, and collapsing them would read as one.
  console.log(`   ${"arm".padEnd(32)} ${"case".padEnd(28)} ${"run".padEnd(24)} ${"del".padStart(4)} ${"backed".padStart(7)} ${"gold-file".padStart(10)}`);
  for (const c of [...cases].sort((a, b) => `${a.dir.arm}${a.dir.instanceId}`.localeCompare(`${b.dir.arm}${b.dir.instanceId}`))) {
    const backed = c.rows.filter((r) => r.transcriptResolves).length;
    const hits = c.rows.filter((r) => r.goldFileHits.length).length;
    console.log(
      `   ${c.dir.arm.slice(0, 32).padEnd(32)} ${c.dir.instanceId.slice(0, 28).padEnd(28)} ${c.dir.run.slice(0, 24).padEnd(24)} ` +
        `${String(c.rows.length).padStart(4)}${mark(c.rows.length)}${String(backed).padStart(6)} ${String(hits).padStart(10)}`,
    );
  }
  console.log(`   ${"".padEnd(32)} ${"TOTAL".padEnd(28)} ${"".padEnd(24)} ${String(rows.length).padStart(4)}${mark(rows.length)}${String(rows.length - unbacked.length).padStart(6)} ${String(coincident.length).padStart(10)}`);
  console.log(`   († = fewer than 10; a rate over this many rows is not a rate.)`);

  if (unbacked.length) {
    console.log(`\n   ‼ FLOOR BUG — ${unbacked.length} drop(s) cite a transcript that is NOT on disk.`);
    console.log(`     The conservation floor restores a drop whose citation does not resolve, so`);
    console.log(`     these hypotheses should never have been deleted. This is a bug in`);
    console.log(`     \`lastlight-facts findings --repair\` or in what the probe phase wrote — not a`);
    console.log(`     statistic. Every one of them, by name:`);
    for (const r of unbacked)
      console.log(`       · ${r.instanceId} [${r.arm}] ${r.citedId} → ${r.refutedBy ?? "(no refutedBy at all)"}`);
  } else if (rows.length) {
    console.log(`\n   Every deletion cites a transcript that resolves on disk — the floor behaved.`);
  }
  const repoForm = rows.filter((r) => r.citationForm === "repo");
  if (repoForm.length && repoForm.length !== rows.filter((r) => r.transcriptResolves).length) {
    console.log(
      `\n   Note: ${repoForm.length} citation(s) are written repo-root-relative` +
        ` (\`${REPO_PREFIX}…\`) and the rest\n   artifact-relative. Both resolve here. Worth a look` +
        ` anyway: if the FLOOR reads only one\n   form, it is restoring inconsistently, and this script` +
        ` cannot see which form it read.`,
    );
  }
  if (unjoined.length) {
    console.log(`\n   ‼ ${unjoined.length} drop(s) name a hypothesis id that resolves to NO row.`);
    console.log(`     The positional \`<family>-NNN\` join failed; their text and anchors below are`);
    console.log(`     blank, so they cannot be checked against gold at all. Treat this as a broken`);
    console.log(`     join, never as "deleted nothing important":`);
    for (const r of unjoined) console.log(`       · ${r.instanceId} [${r.arm}] cited "${r.citedId}"`);
  }

  // ── 2. the claims themselves (the primary output) ─────────────────────────
  console.log(`\n── 2. THE DELETED HYPOTHESES, IN FULL — read these; the counts are secondary ──`);
  if (!rows.length) {
    console.log(`   Nothing was deleted in any measured case-run. The falsify phase refuted`);
    console.log(`   nothing, so no gold could have been lost this way.`);
  }
  for (const c of cases) {
    if (!c.rows.length) continue;
    console.log(`\n   ${c.dir.instanceId}  [${c.dir.arm}]  run ${c.dir.run}`);
    for (const r of c.rows) {
      const flagText = r.goldFileHits.length ? ` ⚑ names gold #${r.goldFileHits.join(",#")}'s file` : "";
      console.log(`     ${`${r.canonicalId ?? `${r.citedId} (UNJOINED)`}${flagText}`.trimEnd()}`);
      for (const line of wrap(r.claim || "(no claim text on the row)", 92, "       ", full ? null : 3))
        console.log(line);
      const anchors = [...new Set(r.anchors.map((a) => `${a.path}:${a.line || "?"}`))];
      console.log(`       anchors: ${anchors.length ? anchors.join("  ") : "(none)"}`);
      console.log(`       refutedBy: ${r.refutedBy ?? "(none)"}${r.transcriptResolves ? "" : "   ‼ DOES NOT RESOLVE"}`);
    }
  }

  // ── 3. the coincidence check ──────────────────────────────────────────────
  console.log(`\n── 3. COINCIDENCE WITH GOLD (file level${window === null ? "" : ` and ±${window} lines`}) ──`);
  const of = (n: number): string => `${String(n).padStart(4)}${mark(n)} of ${rows.length}`;
  console.log(`   ${"deletions naming a gold's file".padEnd(34)} ${of(coincident.length)}`);
  if (window !== null)
    console.log(`   ${`…and within ±${window} lines of it`.padEnd(34)} ${of(windowed.length)}`);
  const goldTouched = new Set(coincident.flatMap((r) => r.goldFileHits.map((j) => `${r.instanceId}#${j}`)));
  console.log(`   ${"distinct gold findings touched".padEnd(34)} ${String(goldTouched.size).padStart(4)}`);
  if (!coincident.length)
    console.log(`\n   NO deletion named any gold finding's file in any measured case-run.`);
  for (const r of coincident) {
    for (const j of r.goldFileHits) {
      const g = cases.find((c) => c.dir.instanceId === r.instanceId)!.gold[j];
      console.log(`\n   ${r.instanceId}#${j}  ${g.file}${g.line ? `:${g.line}` : ""}  [${r.arm}]`);
      for (const line of labelled("     gold: ", g.description, 2)) console.log(line);
      console.log(`     deleted: ${r.canonicalId ?? r.citedId}${r.goldWindowHits.includes(j) ? `  (within ±${window} lines)` : ""}`);
    }
  }
  console.log(`\n   ${CEILING}`);

  // ── 4. the paired read ────────────────────────────────────────────────────
  let pairedLossCount = 0;
  let pairedWithDeletion = 0;
  if (vsRuns.length) {
    // Read the comparator's scorecard rows DIRECTLY rather than through
    // `loadRunDir`: the most useful comparator is often the arm that runs no
    // probes at all, which writes no pipeline artifacts, and requiring them
    // would silently discard exactly the arm the paired read exists for.
    const comparator = new Map<string, InstanceResult[]>();
    const vsArms = new Set<string>();
    for (const p of vsRuns) {
      const sc = readJson<Scorecard>(scorecardPath(p));
      if (!sc) die(`no readable scorecard at ${scorecardPath(p)}`);
      for (const r of sc.results ?? []) {
        vsArms.add(r.model);
        comparator.set(r.instance_id, [...(comparator.get(r.instance_id) ?? []), r]);
      }
    }
    const { losses, uncomparable } = pairedLosses(cases, comparator);
    pairedLossCount = new Set(losses.map((l) => `${l.instanceId}#${l.goldIndex}`)).size;
    pairedWithDeletion = new Set(
      losses.filter((l) => l.deletions.length).map((l) => `${l.instanceId}#${l.goldIndex}`),
    ).size;

    console.log(`\n── 4. PAIRED AGAINST THE COMPARATOR (--vs) — the real measurement ──`);
    console.log(`   comparator  ${vsRuns.map((r) => resolve(r)).join(", ")}`);
    console.log(`   arms        ${[...vsArms].join(", ") || "(none)"}`);
    if (uncomparable.length) {
      console.log(`   UNCOMPARABLE, excluded rather than scored as a loss:`);
      for (const u of [...new Set(uncomparable)]) console.log(`     · ${u}`);
    }
    if (!losses.length) {
      console.log(`\n   The comparator found NO gold that this arm missed, on either surface.`);
      console.log(`   There is nothing for a deletion to have cost.`);
    }
    for (const l of losses) {
      console.log(
        `\n   ${l.instanceId}#${l.goldIndex}  [${l.surface}]  ${l.gold.file ?? "(no file)"}${l.gold.line ? `:${l.gold.line}` : ""}` +
          `\n     in ${l.arm} · run ${l.run}`,
      );
      for (const line of labelled("     gold: ", l.gold.description, 2)) console.log(line);
      if (!l.deletions.length) {
        console.log(`     no deletion here named that file — this loss is NOT attributable to a deletion.`);
        continue;
      }
      for (const d of l.deletions)
        console.log(`     ⚑ deleted here: ${d.canonicalId ?? d.citedId}  (refutedBy ${d.refutedBy ?? "none"})`);
    }
    console.log(
      `\n   Circumstantial, always. Two arms differ in more than their deletions, and a\n` +
        `   gold the comparator found and this arm did not may simply never have been\n` +
        `   hypothesised here. The ⚑ rows are the ones worth reading a transcript over.`,
    );
  } else {
    console.log(`\n── 4. PAIRED READ — NOT RUN ──`);
    console.log(`   No --vs comparator was given, so nothing above can prove a deletion was`);
    console.log(`   harmless. Section 3 is a ceiling on harm, not a measurement of it.`);
  }

  // ── The headline ──────────────────────────────────────────────────────────
  const nameLine =
    coincident.length === 0
      ? "none of them names a gold finding's file"
      : `${coincident.length} of them name a gold finding's file (a CEILING, not a loss)`;
  const pairedLine = !vsRuns.length
    ? "no comparator was run, so no gold loss has been attributed to a deletion"
    : pairedLossCount === 0
      ? "the comparator found no gold that this arm missed"
      : `${pairedLossCount} gold found by the comparator and missed here, ${pairedWithDeletion} of which coincide with a deletion`;
  console.log(`\n── HEADLINE (quotable) ──`);
  console.log(
    `   ${rows.length} hypothes${rows.length === 1 ? "is" : "es"} deleted across ${caseRuns} case-run${caseRuns === 1 ? "" : "s"}; ` +
      `${nameLine}; ${pairedLine}.` +
      (unbacked.length ? ` ${unbacked.length} deletion(s) cite a MISSING transcript — a floor bug.` : ""),
  );
  if (rows.length === 0)
    console.log(`   Plainly: nothing was deleted, so no gold can have been lost to a deletion here.`);
  console.log();
}

// Only when run as a script — so the pure helpers above stay importable from a
// test (`main()` at module scope is what makes `run.ts` untestable).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
