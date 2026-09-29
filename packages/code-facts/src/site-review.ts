/**
 * The `sites` review engine's deterministic layer — `lastlight-facts sites`
 * (docs/plans/pr-review-units-sites.md, "Act 6 — The sites engine, end to
 * end"). Four verbs, one per pipeline step that needs no model:
 *
 *   --plan       `site-plan`: {@link clusterSites} over the hypothesis rows
 *                (distinct-unit votes, span 60, test-file sites ranked last), the top
 *                `--top` sites written to `sites/plan.json`, and one brief
 *                per SLOT (`sites/site-001.md` …) — an empty slot's brief says
 *                there is no site, and its `empty` line is written up front,
 *                so a static fan-out fits every PR. `--pair` puts a SECOND
 *                investigator on each site, in slot {@link PAIR_SLOT_OFFSET}
 *                + rank (see {@link planSiteSlots}).
 *   --check <id> the `site-review` branch gate ({@link checkSiteFindings}):
 *                1–3 grounded findings, a `none` backed by executed probes, or
 *                an `empty` line for a slot the plan left empty.
 *   --merge      `merge`: pool every slot's findings, number them `F1…Fn`,
 *                attach an excerpt, and PROPOSE duplicate groups (same file,
 *                lines within ±{@link DUPLICATE_LINE_WINDOW}, different sites).
 *                It does not decide: "same defect" versus "two defects on
 *                neighbouring lines" needs the prose, and no rule here reads it.
 *   --finalize   after `select`: turn `sites/selected.json` into the
 *                `findings.json` `post-review` reads, file every hypothesis row
 *                at `internal` (the rows are the volume record), and fall back
 *                to one item per pooled finding when the selection is missing
 *                or invalid — so a failed `select` still posts.
 *
 * `--check-select` is `select`'s loop gate: every pooled finding appears in
 * exactly one item. Conservation, the same rule `findings` enforces on
 * hypotheses — a selection may merge and demote, never silently drop.
 *
 * The gate moved here from the evals harness (`apps/evals/src/site-review.ts`,
 * which now re-exports it), so the replay and the pipeline run the same code.
 * No check reads prose.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readHypothesisSet, type HypothesisSet } from "./hypotheses.js";
import { isReadOnlyCommand, transcriptRecordsCommand, type ProbeAnswer } from "./probes.js";
import { isTestPath } from "./project.js";
import { clusterSites, renderSiteBrief, type Site, type SiteVoters, type VoterUnit } from "./site-cluster.js";

// ── layout ──────────────────────────────────────────────────────────────────

/** The default number of sites investigated: `site-001` … `site-005`. */
export const SITE_SLOTS = 5;
/**
 * The most sites a plan may select. Also where the pair slots start: rank `r`'s
 * second investigator is slot `PAIR_SLOT_OFFSET + r`, whatever `top` is, so a
 * workflow's static branch list can give slots 9–16 their own model once.
 */
export const MAX_SITE_TOP = 8;
export const PAIR_SLOT_OFFSET = MAX_SITE_TOP;
export const SITE_REVIEW_VERSION = 1;
export const MAX_SITE_FINDINGS = 3;

/** Where a site's files live, relative to the checkout (the agent's cwd). */
export const sitesRelDir = ".lastlight/pr-review/sites";
export const siteBriefRel = (siteId: string): string => `${sitesRelDir}/${siteId}.md`;
export const siteFindingsRel = (siteId: string): string => `${sitesRelDir}/${siteId}.findings.jsonl`;
export const siteScratchRel = (siteId: string): string => `${sitesRelDir}/${siteId}/`;
/** Slot `n` (1-based) is the site of rank `n` — `clusterSites` ids sites by rank. */
export const siteIdForSlot = (n: number): string => `site-${String(n).padStart(3, "0")}`;

export const IMPORTANCES = ["must-fix", "worth-mentioning", "nit"] as const;
export type Importance = (typeof IMPORTANCES)[number];

export const SITE_STRENGTHS = ["reproduced", "corroborated", "read"] as const;
export type SiteStrength = (typeof SITE_STRENGTHS)[number];

/**
 * How many checked suspicions a `none` line must carry. A `none` is earned,
 * not asserted: arms A/C closed 60–68% of sites `none` on READING alone, and 7
 * of the 10 gold rows inside the selected sites never surfaced (at the
 * `JSON.parse(pendingRaw)` gold the investigator wrote "fail safely if pending
 * is empty" without running the four-line probe that shows it throws).
 *
 * The rule is by site size, the brief's row count: a site of ≤ 3 rows is a
 * thin echo — usually one suspicion said a few times — so demanding two there
 * would make the investigator invent a second one; anything bigger has had
 * several independent passes point at it and must answer at least two.
 */
export const noneChecksRequired = (siteRows: number): number => (siteRows <= 3 ? 1 : 2);

/**
 * Does this command EXECUTE something, rather than only read code? The
 * classifier is falsify's `isReadOnlyCommand` (`probes.ts`), so the two gates
 * agree on what a read is: grep / cat / `sed -n` / `ls` / `find` / `git grep`
 * and a `lastlight-facts` (or `lastlight facts`) query are READS; `node …`, a
 * checked-in runner and a differential `git show` / `git diff` (the falsify
 * ladder's tier 1, measured as honest evidence) are executions.
 *
 * One tightening, and the only reason this is not a bare `!isReadOnlyCommand`:
 * that function answers `false` for a command with NO read segment at all, so
 * `echo ok` alone would pass as an execution. Appending a known read segment
 * makes the reads count positive, so the answer is `true` exactly when every
 * segment is a read or neutral (`cd`, `echo`, `export`, …).
 */
export function isExecutionCommand(command: string): boolean {
  return !isReadOnlyCommand(`${command}\ncat /dev/null`);
}

// ── plan ────────────────────────────────────────────────────────────────────

/** The plan's selection options — the replay's defaults, which the graded arms ran. */
export interface SitePlanOptions {
  /** Sites investigated, 1…{@link MAX_SITE_TOP}. */
  top?: number;
  /**
   * A second investigator on every selected site, in slot
   * {@link PAIR_SLOT_OFFSET} + rank. Measured (docs/plans/pr-review-units-sites.md,
   * H5): runs of one investigator overlap little, and two models' blind spots
   * are disjoint — the union of a luna and a deepseek draw stated 8/7/9 gold on
   * the 10 recall sites where two luna draws stated 4/6/6.
   */
  pair?: boolean;
  /**
   * The static branch count the workflow's fan-out declares. Every slot up to
   * it is planned (empty past the last site), so each branch has a brief.
   * Defaults to the highest slot the plan uses.
   */
  slots?: number;
  window?: number;
  maxSpan?: number | null;
  voters?: SiteVoters;
}

export const DEFAULT_SITE_PLAN: Required<Omit<SitePlanOptions, "slots">> = {
  top: SITE_SLOTS,
  pair: false,
  window: 20,
  maxSpan: 60,
  voters: "unit",
};

export interface SiteSlot {
  slot: number;
  siteId: string;
  /** `null` — the PR has fewer sites than slots, or the slot is a pair slot with pairing off. */
  site: Site | null;
  /** A pair slot: the primary slot investigating the same site. */
  pairOf?: string;
  /** {@link noneChecksRequired} for the site; 0 on an empty slot. */
  noneChecks: number;
}

export interface SiteReviewPlan {
  version: typeof SITE_REVIEW_VERSION;
  options: Required<SitePlanOptions>;
  /** Hypothesis rows read. */
  rows: number;
  /** Sites `clusterSites` formed, before the cut. */
  sitesFormed: number;
  /**
   * Sites in test files. They rank after every other site, so they fill only
   * the slots the others leave free: at a fixed cap, ranking tests WITH the
   * rest displaced better sites (the H3 audit, docs/plans/pr-review-units-sites.md:
   * top 5 + tests put 15 gold-mapped rows in a site, tests skipped 16), while
   * skipping them outright left slots empty on a PR with few sites and lost
   * the gold Martian files against test code.
   */
  testSites: number;
  slots: SiteSlot[];
}

/** `units.json`'s voter keys; empty (each `unitId` its own voter) under the agent survey. */
export function readVoterUnits(dir: string): VoterUnit[] {
  const file = join(dir, "units.json");
  if (!existsSync(file)) return [];
  try {
    const units = (JSON.parse(readFileSync(file, "utf8")) as { units?: VoterUnit[] }).units ?? [];
    return units.map((u) => ({ id: u.id, ...(u.splitOf ? { splitOf: u.splitOf } : {}) }));
  } catch {
    return [];
  }
}

/**
 * Pure: the slots for a hypothesis set. Slot `r` (1…`top`) investigates the
 * site of rank `r`; with `pair`, slot {@link PAIR_SLOT_OFFSET} + `r` investigates
 * it too. Every other slot up to `slots` is empty.
 */
export function planSiteSlots(set: HypothesisSet, units: readonly VoterUnit[], options: SitePlanOptions = {}): SiteReviewPlan {
  const o = { ...DEFAULT_SITE_PLAN, ...options };
  if (!Number.isInteger(o.top) || o.top < 1 || o.top > MAX_SITE_TOP) throw new Error(`top must be 1…${MAX_SITE_TOP}, got ${o.top}`);
  const used = o.pair ? PAIR_SLOT_OFFSET + o.top : o.top;
  const slotCount = options.slots ?? used;
  if (!Number.isInteger(slotCount) || slotCount < used) throw new Error(`${slotCount} slot(s) cannot hold top ${o.top}${o.pair ? " paired" : ""} (needs ${used})`);
  const plan = clusterSites(set, {
    window: o.window,
    voters: o.voters,
    units,
    maxSpan: o.maxSpan,
    demotePath: isTestPath,
  });
  const slots: SiteSlot[] = Array.from({ length: slotCount }, (_, i) => {
    const n = i + 1;
    const pairSlot = o.pair && n > PAIR_SLOT_OFFSET && n <= PAIR_SLOT_OFFSET + o.top;
    const rank = n <= o.top ? n : pairSlot ? n - PAIR_SLOT_OFFSET : null;
    const site = rank !== null ? (plan.sites[rank - 1] ?? null) : null;
    return {
      slot: n,
      siteId: siteIdForSlot(n),
      site,
      ...(pairSlot && site ? { pairOf: siteIdForSlot(rank!) } : {}),
      noneChecks: site ? noneChecksRequired(site.rows.length) : 0,
    };
  });
  return {
    version: SITE_REVIEW_VERSION,
    options: { ...o, slots: slotCount },
    rows: set.records.length,
    sitesFormed: plan.sites.length,
    testSites: plan.sites.filter((s) => s.path !== null && isTestPath(s.path)).length,
    slots,
  };
}

/**
 * The "your assignment" section every brief ends with: the site id, the one
 * file to write, the scratch directory and the `none` bar. The prompt is
 * generic across slots (a fan-out branch has no per-branch variables), so
 * these are the brief's to say.
 */
export function renderSiteAssignment(siteId: string, noneChecks: number): string {
  return [
    "### Your assignment",
    "",
    `- Site id: \`${siteId}\` — put it in every line's \`"site"\` field.`,
    `- Write your output to \`${siteFindingsRel(siteId)}\`.`,
    `- Scratch files (probe scripts, transcripts) go under \`${siteScratchRel(siteId)}\`.`,
    `- A \`none\` on this site needs at least **${noneChecks}** checked suspicion${noneChecks === 1 ? "" : "s"}, at least one of them executed.`,
    "",
  ].join("\n");
}

/** An empty slot's brief: nothing to investigate, one line to write. */
export function renderEmptySlotBrief(siteId: string): string {
  return [
    `## Slot \`${siteId}\` — no site`,
    "",
    "This pull request has fewer review sites than the review has slots, so there is",
    "nothing for you to investigate. Do not read any code. Write exactly this one line",
    `to \`${siteFindingsRel(siteId)}\` and stop:`,
    "",
    "```",
    JSON.stringify({ site: siteId, empty: true }),
    "```",
    "",
  ].join("\n");
}

/**
 * Write `sites/plan.json` and one brief per slot. Clears the directory first: a
 * reused workspace holds the last head's sites. An empty slot's `empty` line is
 * written here too, so its gate is closed before any investigator runs — a
 * fan-out with `skip_satisfied_branches` then starts no session for it.
 */
export function writeSitePlan(dir: string, options: SitePlanOptions = {}): SiteReviewPlan {
  const sitesDir = join(dir, "sites");
  rmSync(sitesDir, { recursive: true, force: true });
  mkdirSync(sitesDir, { recursive: true });
  const set = readHypothesisSet(dir);
  const plan = planSiteSlots(set, readVoterUnits(dir), options);
  for (const slot of plan.slots) {
    const brief = slot.site
      ? `${renderSiteBrief({ ...slot.site, id: slot.siteId }, set, { leads: false })}\n${renderSiteAssignment(slot.siteId, slot.noneChecks)}`
      : renderEmptySlotBrief(slot.siteId);
    writeFileSync(join(sitesDir, `${slot.siteId}.md`), brief);
    mkdirSync(join(sitesDir, slot.siteId), { recursive: true });
    if (!slot.site) writeFileSync(join(sitesDir, `${slot.siteId}.findings.jsonl`), `${JSON.stringify({ site: slot.siteId, empty: true })}\n`);
  }
  writeFileSync(join(sitesDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export function readSitePlan(dir: string): SiteReviewPlan | null {
  const file = join(dir, "sites", "plan.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SiteReviewPlan;
  } catch {
    return null;
  }
}

export function renderSitePlanSummary(plan: SiteReviewPlan): string {
  const lines = [
    `site-plan: ${plan.rows} row(s) → ${plan.sitesFormed} site(s) (${plan.testSites} in test files, ranked last); top ${plan.options.top}${plan.options.pair ? ", paired" : ""}:`,
  ];
  for (const s of plan.slots) {
    lines.push(
      s.site
        ? `  ${s.siteId}  ${s.site.path ?? "unanchored"}:${s.site.startLine ?? "?"}–${s.site.endLine ?? "?"}  rows ${s.site.rows.length}  voters ${s.site.voters}  none-checks ${s.noneChecks}${s.pairOf ? `  (pair of ${s.pairOf})` : ""}`
        : `  ${s.siteId}  (empty slot)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ── the investigator gate ───────────────────────────────────────────────────

export interface SiteFindingLine {
  site?: unknown;
  path?: unknown;
  line?: unknown;
  title?: unknown;
  mechanism?: unknown;
  consequence?: unknown;
  importance?: unknown;
  strength?: unknown;
  command?: unknown;
  transcript?: unknown;
  leads?: unknown;
  none?: unknown;
  empty?: unknown;
  reason?: unknown;
  checked?: unknown;
}

/** One entry of a `none` line's `checked` list: a suspicion answered by a probe. */
export interface NoneCheck {
  suspicion?: unknown;
  command?: unknown;
  transcript?: unknown;
  outcome?: unknown;
}

/** A finding line that parsed and carries the fields the report, judge and merge read. */
export interface SiteFinding {
  site: string;
  path: string;
  line: number;
  title: string;
  mechanism: string;
  consequence: string;
  /** `null` when the investigator wrote none or an unknown value (the replay's pre-importance fixtures). */
  importance: Importance | null;
  strength: string;
  command: string | null;
  transcript: string | null;
  leads: number[];
}

export type SiteGapKind =
  | "missing-file"
  | "empty"
  | "empty-slot"
  | "malformed-line"
  | "none-mixed"
  | "none-no-reason"
  | "none-few-checks"
  | "none-no-execution"
  | "check-missing-field"
  | "too-many"
  | "wrong-site"
  | "missing-field"
  | "bad-importance"
  | "bad-strength"
  | "bad-leads"
  | "path-missing"
  | "path-outside"
  | "line-out-of-range"
  | "no-transcript"
  | "transcript-command";

export interface SiteGap {
  kind: SiteGapKind;
  detail: string;
}

export interface SiteFindingsCheck {
  satisfied: boolean;
  gaps: SiteGap[];
  /** Every parsed finding line (`none`/`empty` excluded), valid or not — what the judge sees. */
  findings: SiteFinding[];
  /** The investigator wrote the `none` line. */
  none: boolean;
  /** The investigator wrote the `empty` line (an empty slot). */
  empty: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Parse the findings file; `null` when it does not exist. */
export function readSiteFindingLines(prDir: string, siteId: string): { lines: SiteFindingLine[]; malformed: number[] } | null {
  const file = join(prDir, "sites", `${siteId}.findings.jsonl`);
  if (!existsSync(file)) return null;
  const lines: SiteFindingLine[] = [];
  const malformed: number[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      try {
        const v = JSON.parse(raw) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) lines.push(v as SiteFindingLine);
        else malformed.push(i + 1);
      } catch {
        malformed.push(i + 1);
      }
    });
  return { lines, malformed };
}

const importanceOf = (v: unknown): Importance | null => {
  const s = (str(v) ?? "").toLowerCase();
  return (IMPORTANCES as readonly string[]).includes(s) ? (s as Importance) : null;
};

function asFinding(l: SiteFindingLine, siteId: string): SiteFinding | null {
  const path = str(l.path);
  const title = str(l.title);
  if (!path || !title || typeof l.line !== "number") return null;
  return {
    site: str(l.site) ?? siteId,
    path,
    line: l.line,
    title,
    mechanism: str(l.mechanism) ?? "",
    consequence: str(l.consequence) ?? "",
    importance: importanceOf(l.importance),
    strength: (str(l.strength) ?? "").toLowerCase(),
    command: str(l.command),
    transcript: str(l.transcript),
    leads: Array.isArray(l.leads) ? l.leads.filter((n): n is number => Number.isInteger(n)) : [],
  };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fileLines(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * A claimed transcript: the file must exist (resolved against the checkout,
 * then `prDir`) and its first line must echo `command` — falsify's own
 * `transcriptRecordsCommand`. Returns the gap, or `null` when it holds.
 */
function transcriptGap(opts: { repo: string; prDir: string; at: string; verdict: string; command: string | null; transcript: string | null; orElse: string }): SiteGap | null {
  const { repo, prDir, at, verdict, command, transcript } = opts;
  const transcriptPath = transcript
    ? ([repo, prDir].map((root) => resolve(root, transcript)).find((p) => existsSync(p) && statSync(p).isFile()) ?? null)
    : null;
  if (!transcript || !command || !transcriptPath)
    return {
      kind: "no-transcript",
      detail: `${at}: needs a \`command\` and a \`transcript\` file that exists${transcript && !transcriptPath ? ` (${transcript} does not)` : ""}${opts.orElse}`,
    };
  const answer: ProbeAnswer = { verdict, command, transcript, transcriptPath, borrowedFrom: null } as ProbeAnswer;
  const { ok, firstLine } = transcriptRecordsCommand(answer);
  if (ok) return null;
  return {
    kind: "transcript-command",
    detail: `${at}: ${transcript}'s first line ${firstLine === null ? "could not be read" : JSON.stringify(firstLine.trim().slice(0, 80))} does not echo \`command\``,
  };
}

/**
 * A `none` line's `checked` list: at least `required` entries, each a
 * suspicion + outcome backed by a transcript that echoes its command, and at
 * least one of them an EXECUTION ({@link isExecutionCommand}).
 */
function checkNoneLine(opts: { repo: string; prDir: string; line: SiteFindingLine; required: number; gaps: SiteGap[] }): void {
  const { line, required, gaps } = opts;
  const checked = Array.isArray(line.checked) ? (line.checked as unknown[]) : [];
  let valid = 0;
  let executed = 0;
  checked.forEach((raw, i) => {
    const at = `none check ${i + 1}`;
    const c = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as NoneCheck;
    const missing = (["suspicion", "command", "transcript", "outcome"] as const).filter((k) => !str(c[k]));
    if (missing.length) {
      gaps.push({ kind: "check-missing-field", detail: `${at}: missing ${missing.join(", ")}` });
      return;
    }
    const command = str(c.command)!;
    const gap = transcriptGap({ ...opts, at, verdict: "none", command, transcript: str(c.transcript), orElse: "" });
    if (gap) {
      gaps.push(gap);
      return;
    }
    valid += 1;
    if (isExecutionCommand(command)) executed += 1;
  });
  if (valid < required)
    gaps.push({
      kind: "none-few-checks",
      detail: `a \`none\` on this site needs at least ${required} checked suspicion${required === 1 ? "" : "s"} in \`checked\` (${valid} valid) — each {suspicion, command, transcript, outcome}; if you cannot close them, report the defect instead`,
    });
  if (valid > 0 && executed === 0)
    gaps.push({
      kind: "none-no-execution",
      detail: "every `checked` command only READS code (grep / cat / sed -n / ls / a facts query) — at least one must EXECUTE: run the copied code under `node`, or a differential `git show`/`git diff` probe",
    });
}

/**
 * The site-review gate. `repo` is the checkout (the agent's cwd, what a
 * finding's `path` is relative to); `prDir` is `<repo>/.lastlight/pr-review`.
 * `leadCount`, when given, bounds the lead numbers a finding may cite.
 * `emptySlot` says the plan left this slot empty: then (and only then) the
 * single `{"site", "empty": true}` line closes it.
 */
export function checkSiteFindings(opts: {
  prDir: string;
  repo: string;
  siteId: string;
  leadCount?: number;
  /** The site's row count; sets how many checks a `none` needs ({@link noneChecksRequired}). Unknown → the stricter 2. */
  siteRows?: number;
  emptySlot?: boolean;
  /** Require {@link SiteFinding.importance} on every finding. The pipeline does; the replay's older prompts did not ask. */
  requireImportance?: boolean;
}): SiteFindingsCheck {
  const { prDir, repo, siteId } = opts;
  const gaps: SiteGap[] = [];
  const out: SiteFindingsCheck = { satisfied: false, gaps, findings: [], none: false, empty: false };
  const parsed = readSiteFindingLines(prDir, siteId);
  if (!parsed) {
    gaps.push({ kind: "missing-file", detail: `${siteFindingsRel(siteId)} was not written` });
    return out;
  }
  for (const n of parsed.malformed) gaps.push({ kind: "malformed-line", detail: `line ${n} is not a JSON object` });
  const { lines } = parsed;
  if (!lines.length && !parsed.malformed.length) gaps.push({ kind: "empty", detail: "the file holds no lines — write findings, or one `none` line" });

  const emptyLines = lines.filter((l) => l.empty === true);
  if (emptyLines.length) {
    out.empty = true;
    if (!opts.emptySlot)
      gaps.push({ kind: "empty-slot", detail: "an `empty` line is only for a slot with no site — this slot has one: investigate it" });
    else if (lines.length > 1) gaps.push({ kind: "none-mixed", detail: `the \`empty\` line must be the only line (the file has ${lines.length})` });
  } else if (opts.emptySlot) {
    gaps.push({ kind: "empty-slot", detail: `this slot has no site — write exactly one line: ${JSON.stringify({ site: siteId, empty: true })}` });
  }

  const noneLines = lines.filter((l) => l.none === true);
  if (noneLines.length) {
    out.none = true;
    if (lines.length > 1) gaps.push({ kind: "none-mixed", detail: `a \`none\` line must be the only line (the file has ${lines.length})` });
    if (!str(noneLines[0].reason)) gaps.push({ kind: "none-no-reason", detail: "the `none` line needs a `reason`" });
    checkNoneLine({ repo, prDir, line: noneLines[0], required: noneChecksRequired(opts.siteRows ?? Number.POSITIVE_INFINITY), gaps });
  }
  const findingLines = lines.filter((l) => l.none !== true && l.empty !== true);
  if (findingLines.length > MAX_SITE_FINDINGS)
    gaps.push({ kind: "too-many", detail: `${findingLines.length} findings — at most ${MAX_SITE_FINDINGS} per site; keep the strongest` });

  const repoReal = realpathSync(repo);
  findingLines.forEach((l, i) => {
    const at = `finding ${i + 1}`;
    if (str(l.site) !== null && str(l.site) !== siteId) gaps.push({ kind: "wrong-site", detail: `${at}: \`site\` is ${JSON.stringify(l.site)}, expected ${siteId}` });
    const missing: string[] = (["path", "title", "mechanism", "consequence"] as const).filter((k) => !str(l[k]));
    if (typeof l.line !== "number" || !Number.isInteger(l.line)) missing.push("line");
    if (missing.length) gaps.push({ kind: "missing-field", detail: `${at}: missing ${missing.join(", ")}` });
    const f = asFinding(l, siteId);
    if (f) out.findings.push(f);

    if (opts.requireImportance && importanceOf(l.importance) === null)
      gaps.push({ kind: "bad-importance", detail: `${at}: \`importance\` must be one of ${IMPORTANCES.join(" | ")}, not ${JSON.stringify(l.importance ?? null)}` });

    const strength = (str(l.strength) ?? "").toLowerCase();
    if (!(SITE_STRENGTHS as readonly string[]).includes(strength))
      gaps.push({ kind: "bad-strength", detail: `${at}: \`strength\` must be one of ${SITE_STRENGTHS.join(" | ")}, not ${JSON.stringify(l.strength ?? null)}` });

    if (l.leads !== undefined && l.leads !== null) {
      const ok =
        Array.isArray(l.leads) &&
        l.leads.every((n) => Number.isInteger(n) && (n as number) >= 1 && (opts.leadCount === undefined || (n as number) <= opts.leadCount));
      if (!ok) gaps.push({ kind: "bad-leads", detail: `${at}: \`leads\` must be an array of the brief's lead numbers${opts.leadCount !== undefined ? ` (1–${opts.leadCount})` : ""}` });
    }

    const path = str(l.path);
    if (path) {
      const abs = resolve(repo, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) gaps.push({ kind: "path-missing", detail: `${at}: ${path} is not a file in the checkout` });
      else if (!inside(repoReal, realpathSync(abs))) gaps.push({ kind: "path-outside", detail: `${at}: ${path} is outside the checkout` });
      else if (typeof l.line === "number") {
        const n = fileLines(abs).length;
        if (!Number.isInteger(l.line) || l.line < 1 || l.line > n) gaps.push({ kind: "line-out-of-range", detail: `${at}: line ${l.line} is outside ${path} (1–${n})` });
      }
    }

    if (strength === "reproduced" || strength === "corroborated") {
      const gap = transcriptGap({ repo, prDir, at: `${at} (\`${strength}\`)`, verdict: strength, command: str(l.command), transcript: str(l.transcript), orElse: " — or say `read`" });
      if (gap) gaps.push(gap);
    }
  });

  out.satisfied =
    gaps.length === 0 && (out.empty || out.none || (findingLines.length >= 1 && findingLines.length <= MAX_SITE_FINDINGS));
  return out;
}

/** The gate against the plan on disk: the slot's row count and emptiness come from `sites/plan.json`. */
export function checkSiteSlot(opts: { dir: string; repo: string; siteId: string }): SiteFindingsCheck {
  const plan = readSitePlan(opts.dir);
  const slot = plan?.slots.find((s) => s.siteId === opts.siteId);
  return checkSiteFindings({
    prDir: opts.dir,
    repo: opts.repo,
    siteId: opts.siteId,
    siteRows: slot?.site?.rows.length,
    emptySlot: slot ? slot.site === null : false,
    requireImportance: true,
  });
}

/** The gate's output — what `on_branch_gate_failure` appends to the retry prompt. */
export function renderSiteCheck(siteId: string, check: SiteFindingsCheck): string {
  if (check.satisfied) {
    const what = check.empty ? "empty slot" : check.none ? "none (probe-backed)" : `${check.findings.length} finding(s)`;
    return `sites --check ${siteId}: ok — ${what}\n`;
  }
  const lines = [`sites --check ${siteId}: NOT satisfied. Fix exactly these and rewrite ${siteFindingsRel(siteId)}:`];
  for (const g of check.gaps.slice(0, 12)) lines.push(`- \`${g.kind}\` — ${g.detail}`);
  if (check.gaps.length > 12) lines.push(`- … and ${check.gaps.length - 12} more`);
  return `${lines.join("\n")}\n`;
}

// ── merge ───────────────────────────────────────────────────────────────────

/** Two findings from DIFFERENT sites this close in one file are proposed as one defect. */
export const DUPLICATE_LINE_WINDOW = 10;
const EXCERPT_RADIUS = 3;

export interface PooledFinding extends SiteFinding {
  /** `F1…Fn`, pool order — what `select` cites. */
  id: string;
  /** `<siteId>#<n>`, the finding's position in its site's file (1-based). */
  ref: string;
  /** A `reproduced`/`corroborated` claim whose transcript did not hold — read as `read`. */
  unbacked: boolean;
  /** Numbered lines around `line` from the checkout. */
  excerpt: string;
  /** The verbatim text of `line` — the anchor `post-review` resolves. */
  lineText: string;
  /** The line the investigator wrote, when it was blank and `line` moved off it. */
  citedLine?: number;
}

export interface SiteMerge {
  version: typeof SITE_REVIEW_VERSION;
  findings: PooledFinding[];
  /** Candidate duplicate groups, by `F` id — proposals, never decisions. */
  groups: string[][];
  /** Per slot: what the investigator wrote, and whether its gate closed. */
  slots: { siteId: string; outcome: "findings" | "none" | "empty" | "missing" | "invalid"; findings: number; gateSatisfied: boolean }[];
  /** Finding lines that could not be pooled (no real file/line), for the log. */
  unpooled: { ref: string; reason: string }[];
}

/** `line` if it holds code, else the nearest non-blank line within ±3 (below first), else `line`. */
export function nearestCodeLine(lines: string[], line: number): number {
  const code = (n: number): boolean => n >= 1 && n <= lines.length && lines[n - 1].trim().length > 0;
  if (code(line)) return line;
  for (let d = 1; d <= 3; d++) {
    if (code(line + d)) return line + d;
    if (code(line - d)) return line - d;
  }
  return line;
}

function excerptAt(lines: string[], line: number): string {
  const from = Math.max(1, line - EXCERPT_RADIUS);
  const to = Math.min(lines.length, line + EXCERPT_RADIUS);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${n === line ? ">" : " "} ${String(n).padStart(width)}  ${lines[n - 1]}`);
  return out.join("\n");
}

/** Pool every slot's findings. Reads the plan for the slot list; with no plan, the {@link SITE_SLOTS} default ids. */
export function mergeSiteFindings(opts: { dir: string; repo: string }): SiteMerge {
  const { dir, repo } = opts;
  const plan = readSitePlan(dir);
  const slotIds = plan ? plan.slots.map((s) => s.siteId) : Array.from({ length: SITE_SLOTS }, (_, i) => siteIdForSlot(i + 1));
  const repoReal = realpathSync(repo);
  const findings: PooledFinding[] = [];
  const unpooled: SiteMerge["unpooled"] = [];
  const slots: SiteMerge["slots"] = [];

  for (const siteId of slotIds) {
    const check = checkSiteSlot({ dir, repo, siteId });
    const parsed = readSiteFindingLines(dir, siteId);
    const outcome: SiteMerge["slots"][number]["outcome"] = !parsed
      ? "missing"
      : check.empty
        ? "empty"
        : check.none
          ? "none"
          : check.findings.length
            ? "findings"
            : "invalid";
    let pooled = 0;
    // The gate's own parse, capped at the per-site maximum in file order —
    // the investigator was told to put its strongest first.
    check.findings.slice(0, MAX_SITE_FINDINGS).forEach((f, i) => {
      const ref = `${siteId}#${i + 1}`;
      const abs = resolve(repo, f.path);
      if (!existsSync(abs) || !statSync(abs).isFile() || !inside(repoReal, realpathSync(abs))) {
        unpooled.push({ ref, reason: `${f.path} is not a file in the checkout` });
        return;
      }
      const lines = fileLines(abs);
      if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines.length) {
        unpooled.push({ ref, reason: `line ${f.line} is outside ${f.path}` });
        return;
      }
      // Investigators cite a blank line surprisingly often (off by one, next
      // to the statement they mean) — measured on the first end-to-end run,
      // 2 of 4. A blank line has no text to anchor on, so the finding moves to
      // the nearest non-blank line within ±3, below first. `citedLine` keeps
      // what was written.
      const line = nearestCodeLine(lines, f.line);
      const claimed = f.strength === "reproduced" || f.strength === "corroborated";
      const unbacked =
        claimed &&
        transcriptGap({ repo, prDir: dir, at: ref, verdict: f.strength, command: f.command, transcript: f.transcript, orElse: "" }) !== null;
      findings.push({
        ...f,
        line,
        ...(line !== f.line ? { citedLine: f.line } : {}),
        site: siteId,
        id: `F${findings.length + 1}`,
        ref,
        unbacked,
        excerpt: excerptAt(lines, line),
        lineText: lines[line - 1] ?? "",
      });
      pooled++;
    });
    slots.push({ siteId, outcome, findings: pooled, gateSatisfied: check.satisfied });
  }

  // Union-find over cross-site pairs in one file within the window.
  const parent = findings.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let a = 0; a < findings.length; a++)
    for (let b = a + 1; b < findings.length; b++) {
      const x = findings[a];
      const y = findings[b];
      if (x.site !== y.site && x.path === y.path && Math.abs(x.line - y.line) <= DUPLICATE_LINE_WINDOW) parent[root(b)] = root(a);
    }
  const byRoot = new Map<number, string[]>();
  findings.forEach((f, i) => {
    const r = root(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), f.id]);
  });
  const groups = [...byRoot.values()].filter((g) => g.length > 1);

  return { version: SITE_REVIEW_VERSION, findings, groups, slots, unpooled };
}

/** `select`'s input, as Markdown: the pooled findings with excerpts, and the proposed groups. */
export function renderSiteMerge(merge: SiteMerge): string {
  const out: string[] = ["# Site findings to select from", ""];
  const tally = (o: string) => merge.slots.filter((s) => s.outcome === o).length;
  out.push(
    `${merge.findings.length} finding(s) from ${tally("findings")} site(s); ${tally("none")} site(s) closed \`none\`, ${tally("empty")} empty slot(s), ${tally("missing") + tally("invalid")} site(s) wrote nothing usable.`,
    "",
  );
  if (!merge.findings.length) {
    out.push("There are no findings. Write `{\"items\": []}` and stop.", "");
    return `${out.join("\n")}\n`;
  }
  for (const f of merge.findings) {
    const strength = f.unbacked ? `${f.strength} (transcript did not hold — treat as read)` : f.strength;
    out.push(
      `## ${f.id} — \`${f.path}:${f.line}\` (${f.site})`,
      "",
      `- **Title:** ${f.title}`,
      `- **Investigator's importance:** ${f.importance ?? "not given"}`,
      `- **Evidence:** ${strength}`,
      `- **Mechanism:** ${f.mechanism}`,
      `- **Consequence:** ${f.consequence}`,
      "",
      "```",
      f.excerpt,
      "```",
      "",
    );
  }
  out.push("## Candidate duplicate groups", "");
  if (!merge.groups.length) out.push("None proposed: no two sites reported findings within the same few lines of one file.");
  else
    for (const g of merge.groups) {
      const members = g.map((id) => merge.findings.find((f) => f.id === id)!);
      out.push(`- ${g.join(", ")} — \`${members[0].path}\` lines ${members.map((f) => f.line).join(", ")}, from ${[...new Set(members.map((f) => f.site))].join(", ")}`);
    }
  out.push("");
  return `${out.join("\n")}\n`;
}

export function writeSiteMerge(dir: string, repo: string): SiteMerge {
  const merge = mergeSiteFindings({ dir, repo });
  mkdirSync(join(dir, "sites"), { recursive: true });
  writeFileSync(join(dir, "sites", "merged.json"), `${JSON.stringify(merge, null, 2)}\n`);
  writeFileSync(join(dir, "sites", "merged.md"), renderSiteMerge(merge));
  return merge;
}

export function readSiteMerge(dir: string): SiteMerge | null {
  const file = join(dir, "sites", "merged.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SiteMerge;
  } catch {
    return null;
  }
}

// ── select: the selection document and its gate ─────────────────────────────

export const selectedRel = `${sitesRelDir}/selected.json`;

/** One posted (or recorded) review comment: one defect, possibly reported by several sites. */
export interface SelectionItem {
  /** The pooled `F` ids this item covers — one, or a true duplicate group. */
  findings: string[];
  /** Whose location and evidence the item takes. Defaults to `findings[0]`. */
  primary?: string;
  title: string;
  /** The comment text. Defaults to the primary's mechanism + consequence. */
  body?: string;
  /** What to change. */
  fix?: string;
  importance: Importance;
  /**
   * Where the PR's prior discussion already raised this defect — who and
   * where, in a few words (`@alice's inline thread on src/a.ts:12`). An item
   * that carries it is recorded at `internal`, never posted: repeating a point
   * already on the PR spends the author's attention on something they have.
   * Conservation still holds — it is a tier, not a drop.
   */
  alreadyRaised?: string;
}

export interface SelectionDocument {
  /** One to three sentences for the review body. */
  summary?: string;
  /** Posting order: most important first. */
  items: SelectionItem[];
}

export type SelectionGapKind = "missing-file" | "unparseable" | "bad-item" | "unknown-finding" | "duplicate-finding" | "uncovered-finding" | "bad-primary" | "bad-importance";

export interface SelectionCheck {
  satisfied: boolean;
  gaps: { kind: SelectionGapKind; detail: string }[];
  document: SelectionDocument | null;
}

/** Parse and check `sites/selected.json` against the merge: every pooled finding in exactly one item. */
export function checkSelection(opts: { dir: string; merge?: SiteMerge | null }): SelectionCheck {
  const merge = opts.merge ?? readSiteMerge(opts.dir);
  const gaps: SelectionCheck["gaps"] = [];
  const file = join(opts.dir, "sites", "selected.json");
  if (!existsSync(file)) return { satisfied: false, gaps: [{ kind: "missing-file", detail: `${selectedRel} was not written` }], document: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { satisfied: false, gaps: [{ kind: "unparseable", detail: `${selectedRel} is not JSON: ${(err as Error).message}` }], document: null };
  }
  const itemsRaw = (raw as { items?: unknown })?.items;
  if (!Array.isArray(itemsRaw))
    return { satisfied: false, gaps: [{ kind: "unparseable", detail: `${selectedRel} needs an \`items\` array` }], document: null };

  const known = new Set((merge?.findings ?? []).map((f) => f.id));
  const seen = new Map<string, number>();
  const items: SelectionItem[] = [];
  itemsRaw.forEach((r, i) => {
    const at = `item ${i + 1}`;
    const o = (r && typeof r === "object" && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
    const ids = Array.isArray(o.findings) ? o.findings.filter((x): x is string => typeof x === "string") : [];
    const title = str(o.title);
    const importance = importanceOf(o.importance);
    if (!ids.length || !title) {
      gaps.push({ kind: "bad-item", detail: `${at}: needs a non-empty \`findings\` list of F ids and a \`title\`` });
      return;
    }
    if (!importance) gaps.push({ kind: "bad-importance", detail: `${at}: \`importance\` must be one of ${IMPORTANCES.join(" | ")}` });
    for (const id of ids) {
      if (!known.has(id)) gaps.push({ kind: "unknown-finding", detail: `${at}: ${id} is not a finding in the list` });
      else if (seen.has(id)) gaps.push({ kind: "duplicate-finding", detail: `${at}: ${id} is already in item ${seen.get(id)! + 1} — each finding belongs to exactly one item` });
      else seen.set(id, i);
    }
    const primary = str(o.primary) ?? ids[0];
    if (!ids.includes(primary)) gaps.push({ kind: "bad-primary", detail: `${at}: \`primary\` ${primary} is not one of its \`findings\`` });
    items.push({
      findings: ids,
      primary,
      title,
      ...(str(o.body) ? { body: str(o.body)! } : {}),
      ...(str(o.fix) ? { fix: str(o.fix)! } : {}),
      importance: importance ?? "worth-mentioning",
      ...(str(o.alreadyRaised) ? { alreadyRaised: str(o.alreadyRaised)! } : {}),
    });
  });
  for (const id of known) if (!seen.has(id)) gaps.push({ kind: "uncovered-finding", detail: `${id} is in no item — every finding goes in exactly one (a weak one as \`nit\`)` });
  const summary = str((raw as { summary?: unknown }).summary);
  return { satisfied: gaps.length === 0, gaps, document: { ...(summary ? { summary } : {}), items } };
}

export function renderSelectionCheck(check: SelectionCheck): string {
  if (check.satisfied) return `sites --check-select: ok — ${check.document?.items.length ?? 0} item(s)\n`;
  const lines = [`sites --check-select: NOT satisfied. Fix exactly these and rewrite ${selectedRel}:`];
  for (const g of check.gaps.slice(0, 15)) lines.push(`- \`${g.kind}\` — ${g.detail}`);
  if (check.gaps.length > 15) lines.push(`- … and ${check.gaps.length - 15} more`);
  return `${lines.join("\n")}\n`;
}

// ── finalize: selection → findings.json ─────────────────────────────────────

/**
 * Importance → the poster's severity band. `post-review` ranks both budgets on
 * severity, so must-fix outranks worth-mentioning for the inline slots; a
 * `nit` is recorded at `internal`, never posted.
 */
const SEVERITY_FOR: Record<Importance, string> = { "must-fix": "Important", "worth-mentioning": "Minor", nit: "Minor" };

export interface FinalizeResult {
  /** `selection` — `selected.json` held; `fallback` — one item per pooled finding. */
  source: "selection" | "fallback";
  fallbackReason: string | null;
  posted: number;
  recorded: number;
  hypotheses: number;
  notes: string[];
}

/** The one-item-per-finding selection a failed `select` falls back to, in pool order. */
export function fallbackSelection(merge: SiteMerge): SelectionDocument {
  const rank = (f: PooledFinding): number => (f.importance === "must-fix" ? 0 : f.importance === "nit" ? 2 : 1);
  return {
    items: [...merge.findings]
      .sort((a, b) => rank(a) - rank(b))
      .map((f) => ({ findings: [f.id], primary: f.id, title: f.title, importance: f.importance ?? "worth-mentioning" })),
  };
}

function findingBody(f: PooledFinding, item: SelectionItem): string {
  if (item.body) return item.body;
  return [f.mechanism, f.consequence && `**Consequence:** ${f.consequence}`].filter(Boolean).join("\n\n");
}

/**
 * Write `findings.json` from the selection (or the fallback), with every
 * hypothesis row filed at `internal` by id — the rows are the volume record,
 * and `findings --repair` (reconcile) then sees conservation hold.
 */
export function finalizeSiteFindings(opts: { dir: string; repo: string }): FinalizeResult {
  const { dir } = opts;
  const merge = readSiteMerge(dir) ?? mergeSiteFindings({ dir, repo: opts.repo });
  const check = checkSelection({ dir, merge });
  const notes: string[] = [];
  let selection: SelectionDocument;
  let source: FinalizeResult["source"] = "selection";
  let fallbackReason: string | null = null;
  if (check.satisfied && check.document) selection = check.document;
  else {
    source = "fallback";
    fallbackReason = check.gaps.map((g) => g.kind).filter((k, i, a) => a.indexOf(k) === i).join(", ") || "no selection";
    selection = fallbackSelection(merge);
    // Keep the select phase's summary even when its items failed the gate.
    if (check.document?.summary) selection.summary = check.document.summary;
  }

  const byId = new Map(merge.findings.map((f) => [f.id, f]));
  const findings: Record<string, unknown>[] = [];
  let posted = 0;
  let recorded = 0;
  for (const item of selection.items) {
    const primary = byId.get(item.primary ?? item.findings[0]);
    if (!primary) continue;
    const members = item.findings.map((id) => byId.get(id)).filter((f): f is PooledFinding => !!f);
    // Recorded, never posted: trivia, and anything the PR's discussion already raised.
    const nit = item.importance === "nit" || !!item.alreadyRaised;
    const text = primary.lineText.trim();
    findings.push({
      path: primary.path,
      line: primary.line,
      ...(text.length >= 4 ? { existingCode: primary.lineText } : {}),
      severity: SEVERITY_FOR[item.importance],
      title: item.title,
      body: findingBody(primary, item),
      claim: item.title,
      category: "defect",
      ...(item.fix ? { fix: item.fix } : {}),
      ...(nit ? { tier: "internal" } : {}),
      importance: item.importance,
      ...(item.alreadyRaised ? { alreadyRaised: item.alreadyRaised } : {}),
      investigatorImportance: primary.importance,
      strength: primary.unbacked ? "read" : primary.strength,
      source: "site-review",
      siteFindings: members.map((f) => f.ref),
    });
    if (nit) recorded++;
    else posted++;
  }

  const set = readHypothesisSet(dir);
  // A pair slot re-investigates its primary's site: count areas, not investigators.
  const pairSlots = new Set((readSitePlan(dir)?.slots ?? []).filter((s) => s.pairOf).map((s) => s.siteId));
  const siteCount = merge.slots.filter((s) => s.outcome !== "empty" && !pairSlots.has(s.siteId)).length;
  const summary =
    selection.summary ??
    (posted
      ? `Investigated ${siteCount} area(s) of this change; ${posted} issue(s) worth raising below.`
      : `Investigated ${siteCount} area(s) of this change and found nothing worth raising.`);
  const doc = {
    summary,
    event: "COMMENT",
    findings,
    internal: set.records.map((r) => r.id),
    siteReview: { source, fallbackReason, pooled: merge.findings.length, items: selection.items.length },
  };
  const out = join(dir, "findings.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  if (merge.unpooled.length) notes.push(`${merge.unpooled.length} finding line(s) not pooled: ${merge.unpooled.map((u) => `${u.ref} (${u.reason})`).join("; ")}`);
  return { source, fallbackReason, posted, recorded, hypotheses: set.records.length, notes };
}

export function renderFinalize(r: FinalizeResult): string {
  const lines = [
    `sites --finalize: ${r.source === "selection" ? "selection" : `FALLBACK (${r.fallbackReason}) — one item per finding`} → ${r.posted} to post, ${r.recorded} recorded (nit), ${r.hypotheses} hypothesis row(s) filed internal`,
    ...r.notes,
  ];
  return `${lines.join("\n")}\n`;
}
