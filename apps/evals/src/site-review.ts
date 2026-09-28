/**
 * The site-review investigator's output contract and its deterministic gate —
 * `scripts/micro-site-review.ts` (docs/plans/adjudicate-falsify-replay.md,
 * "Site review: rows as volume, leads not items").
 *
 * A per-site investigator writes `.lastlight/pr-review/sites/<site-id>.findings.jsonl`:
 * one JSON object per finding (at most {@link MAX_SITE_FINDINGS}), or a single
 * `{"site", "none": true, "reason", "checked": [{suspicion, command, transcript, outcome}]}` line. {@link checkSiteFindings} is the gate
 * the replay runs between rounds — mechanical checks only, in the spirit of
 * `lastlight-facts probes`: every finding points at a real file and line, and a
 * `reproduced`/`corroborated` finding names a transcript whose first line
 * echoes its `command` (code-facts' own `transcriptRecordsCommand`, so the rule
 * is falsify's, not a second copy), and a `none` line carries `checked`
 * suspicions with transcripts, at least one of them an execution
 * ({@link noneChecksRequired}, {@link isExecutionCommand}). No check reads prose.
 *
 * This lives in the evals harness, not in code-facts: site review is an
 * experiment, not a phase, and nothing in core runs it.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isReadOnlyCommand, transcriptRecordsCommand, type ProbeAnswer } from "lastlight-code-facts";

export const MAX_SITE_FINDINGS = 3;

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
 * classifier is falsify's `isReadOnlyCommand` (code-facts `probes.ts`), so the
 * two gates agree on what a read is: grep / cat / `sed -n` / `ls` / `find` /
 * `git grep` and a `lastlight-facts` (or `lastlight facts`) query are READS;
 * `node …`, a checked-in runner and a differential `git show` / `git diff`
 * (the falsify ladder's tier 1, measured as honest evidence) are executions.
 *
 * One tightening, and the only reason this is not a bare `!isReadOnlyCommand`:
 * that function answers `false` for a command with NO read segment at all, so
 * `echo ok` alone would pass as an execution. Appending a known read segment
 * makes the reads count positive, so the answer is `true` exactly when every
 * segment is a read or neutral (`cd`, `echo`, `export`, …) — without
 * replicating code-facts' segment parser here.
 */
export function isExecutionCommand(command: string): boolean {
  return !isReadOnlyCommand(`${command}\ncat /dev/null`);
}
export const SITE_STRENGTHS = ["reproduced", "corroborated", "read"] as const;
export type SiteStrength = (typeof SITE_STRENGTHS)[number];

/** Where a site's files live, relative to the checkout (the agent's cwd). */
export const sitesRelDir = ".lastlight/pr-review/sites";
export const siteBriefRel = (siteId: string): string => `${sitesRelDir}/${siteId}.md`;
export const siteFindingsRel = (siteId: string): string => `${sitesRelDir}/${siteId}.findings.jsonl`;

export interface SiteFindingLine {
  site?: unknown;
  path?: unknown;
  line?: unknown;
  title?: unknown;
  mechanism?: unknown;
  consequence?: unknown;
  strength?: unknown;
  command?: unknown;
  transcript?: unknown;
  leads?: unknown;
  none?: unknown;
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

/** A finding line that parsed and carries the fields the report and judge read. */
export interface SiteFinding {
  site: string;
  path: string;
  line: number;
  title: string;
  mechanism: string;
  consequence: string;
  strength: string;
  command: string | null;
  transcript: string | null;
  leads: number[];
}

export type SiteGapKind =
  | "missing-file"
  | "empty"
  | "malformed-line"
  | "none-mixed"
  | "none-no-reason"
  | "none-few-checks"
  | "none-no-execution"
  | "check-missing-field"
  | "too-many"
  | "wrong-site"
  | "missing-field"
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
  /** Every parsed finding line (`none` excluded), valid or not — what the judge sees. */
  findings: SiteFinding[];
  /** The investigator wrote the `none` line. */
  none: boolean;
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

function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
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
  const answer: ProbeAnswer = { verdict, command, transcript, transcriptPath, borrowedFrom: null };
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
 */
export function checkSiteFindings(opts: {
  prDir: string;
  repo: string;
  siteId: string;
  leadCount?: number;
  /** The site's row count; sets how many checks a `none` needs ({@link noneChecksRequired}). Unknown → the stricter 2. */
  siteRows?: number;
}): SiteFindingsCheck {
  const { prDir, repo, siteId } = opts;
  const gaps: SiteGap[] = [];
  const out: SiteFindingsCheck = { satisfied: false, gaps, findings: [], none: false };
  const parsed = readSiteFindingLines(prDir, siteId);
  if (!parsed) {
    gaps.push({ kind: "missing-file", detail: `${siteFindingsRel(siteId)} was not written` });
    return out;
  }
  for (const n of parsed.malformed) gaps.push({ kind: "malformed-line", detail: `line ${n} is not a JSON object` });
  const { lines } = parsed;
  if (!lines.length && !parsed.malformed.length) gaps.push({ kind: "empty", detail: "the file holds no lines — write findings, or one `none` line" });

  const noneLines = lines.filter((l) => l.none === true);
  if (noneLines.length) {
    out.none = true;
    if (lines.length > 1) gaps.push({ kind: "none-mixed", detail: `a \`none\` line must be the only line (the file has ${lines.length})` });
    if (!str(noneLines[0].reason)) gaps.push({ kind: "none-no-reason", detail: "the `none` line needs a `reason`" });
    checkNoneLine({ repo, prDir, line: noneLines[0], required: noneChecksRequired(opts.siteRows ?? Number.POSITIVE_INFINITY), gaps });
  }
  const findingLines = lines.filter((l) => l.none !== true);
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
        const n = lineCount(abs);
        if (!Number.isInteger(l.line) || l.line < 1 || l.line > n) gaps.push({ kind: "line-out-of-range", detail: `${at}: line ${l.line} is outside ${path} (1–${n})` });
      }
    }

    if (strength === "reproduced" || strength === "corroborated") {
      const gap = transcriptGap({ repo, prDir, at: `${at} (\`${strength}\`)`, verdict: strength, command: str(l.command), transcript: str(l.transcript), orElse: " — or say `read`" });
      if (gap) gaps.push(gap);
    }
  });

  out.satisfied = gaps.length === 0 && (out.none || (findingLines.length >= 1 && findingLines.length <= MAX_SITE_FINDINGS));
  return out;
}

/**
 * The section round 2's prompt ends with: what the gate rejected. A deliberate
 * departure from core's `generic_loop`, which re-renders the same prompt and
 * leaves the agent to guess (the falsify pilot's round 2 could not know what
 * to fix).
 */
export function renderGateFeedback(gaps: SiteGap[], findingsRel: string): string {
  const lines = gaps.slice(0, 12).map((g) => `- \`${g.kind}\` — ${g.detail}`);
  if (gaps.length > 12) lines.push(`- … and ${gaps.length - 12} more`);
  return [
    "",
    "## The gate rejected your previous output",
    "",
    `\`${findingsRel}\` is still on disk from your previous attempt. Fix exactly these and rewrite the file:`,
    "",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Findings projected into `gradeInternalRecall`'s finding shape — the claim is
 * title + mechanism + consequence, the way `rowsAsJudgeFindings` projects a
 * row's claim + consequence, with the location in the file field and text.
 */
export function findingsAsJudgeFindings(findings: Pick<SiteFinding, "path" | "line" | "title" | "mechanism" | "consequence">[]): { description: string; file: string | null }[] {
  return findings.map((f) => ({
    description: [`${f.title} (${f.path}:${f.line}).`, f.mechanism, f.consequence && `Consequence: ${f.consequence}`].filter(Boolean).join(" "),
    file: f.path,
  }));
}
