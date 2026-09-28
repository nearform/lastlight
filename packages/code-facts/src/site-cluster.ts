/**
 * `clusterSites` — group hypothesis rows into SITES by where they point, and
 * rank the sites by how many rows point there.
 *
 * The unit survey writes 39–234 rows per case (1,794 over 16 case-arms, 14
 * gold-matched), and every row-level cut tried after it failed: `top:40`
 * (`adjudicate-admit.ts`) filed 7 of the 14 gold, and one `adjudicate` call
 * over the whole set does not finish. Several units and several families
 * routinely flag the same few lines, and that agreement is the signal: in the
 * 2026-09-27 screen (`apps/evals/scripts/cluster-screen.ts`), ±20 lines across
 * families put 10 of the 14 gold in their case's top-5 sites, where 5 sites at
 * random find about 2. See `docs/plans/adjudicate-falsify-replay.md`.
 *
 * A site is a run of rows in one file whose anchor lines sit within `window`
 * lines of their neighbour (single linkage). The anchor is the row's first
 * quote with a path and a line, else `bothEnds.introducedAt` — never claim
 * text, so no rule here reads prose. A row with no anchor is a site of its own.
 *
 * Two measured choices, both defaults for a reason:
 *
 * - **Across families.** Keyed on (family, path), the screen found half as
 *   many gold in the top sites: cross-family agreement IS the vote.
 *   `byFamily` exists as the ablation, not as an option to ship.
 * - **Support before severity.** Severity is nearly flat on unit-survey rows
 *   (91–119 `Important` per 1587/1667 case), so ranking on it first buries
 *   agreed sites under lone Criticals.
 *
 * The known cost is the one every voting scheme pays: a real defect that only
 * one row found ranks low (both gold outside the screen's top 20 are lone
 * rows). A low rank must therefore mean "not weighed first", never "deleted".
 *
 * Three options came out of the first paid site pilot, all off by default so
 * the screen's numbers above still describe the default plan:
 *
 * - **`voters: "unit"`.** Votes echo: one unit wrote 12 rows into one site, and
 *   a unit split by family re-reads the same lines up to six times. Ranking on
 *   distinct voters (a row's `unitId`, split siblings collapsed to `splitOf`)
 *   put 8.7 of 14 gold in the top 5 against 9 for rows — about as good, and
 *   not inflatable by one chatty unit. `Site.voters` is always reported.
 * - **`maxSpan`.** Single linkage chains: the pilot's `site-001` ran from line
 *   1 to 125 of one file on 38 rows, too wide for one investigator to hold.
 *   A run whose span would pass `maxSpan` starts a new site instead.
 * - **`skipPath`** (e.g. `isTestPath` from `project.ts`, the per-language
 *   test-file heuristic `facts` already uses). 3 of the pilot's top 10 sites
 *   were `*.test.ts` files, crowding out the code under review. Skipped
 *   rows form no site; their ids go to `SitePlan.skipped`, so every row is
 *   still accounted for exactly once.
 *
 * Sites decide WHERE to look; {@link siteLeads} and {@link renderSiteBrief}
 * hand a per-site investigator what the rows said there, from the typed
 * `evidence.subject` only.
 */
import { pathOfRow } from "./adjudicate-render.js";
import type { HypothesisSet } from "./hypotheses.js";
import { plannedProbe, planProbes, PROBE_PLAN_VERSION, type ProbePlan } from "./probe-plan.js";
import { severityOf, type SurveyEvidence } from "./survey-verdict.js";

export const SITE_PLAN_VERSION = 1;

/** The screen's choice: 0 gold collisions up to ±20, one at ±25. */
export const DEFAULT_SITE_WINDOW = 20;

export interface Site {
  /** `site-NNN`, by rank. */
  id: string;
  /** 1-based. */
  rank: number;
  /** `null` for an unanchored row's own site. */
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** Rows in the site — the vote under `voters: "row"`. */
  support: number;
  /**
   * Distinct voters among the rows — the vote under `voters: "unit"`. A voter
   * is the row's `unitId`, a family-split sibling collapsed to its `splitOf`;
   * a row with no `unitId` is a voter of its own.
   */
  voters: number;
  /** Distinct families among the rows, sorted. */
  families: string[];
  /** The strongest derived severity among the rows, `null` if none derives one. */
  severity: string | null;
  /** Canonical `<family>-NNN` ids, in declaration order. */
  rows: string[];
}

export interface SitePlan {
  version: typeof SITE_PLAN_VERSION;
  window: number;
  byFamily: boolean;
  voters: SiteVoters;
  maxSpan: number | null;
  /** Every hypothesis row read. */
  rows: number;
  sites: Site[];
  /** Row ids `skipPath` left out of ranking, declaration order. `sites` ∪ `skipped` = every row, once. */
  skipped: string[];
}

/** What a site's vote counts: every row, or distinct units. */
export type SiteVoters = "row" | "unit";

/** The two `Unit` fields the voter key needs (`units.json` carries them). */
export interface VoterUnit {
  id: string;
  splitOf?: string;
}

export interface ClusterOptions {
  /** Max line gap between neighbours in one site. Default {@link DEFAULT_SITE_WINDOW}. */
  window?: number;
  /** Ablation only: split sites by family as well as file. */
  byFamily?: boolean;
  /** The ranking vote. Default `"row"` (the screened plan). */
  voters?: SiteVoters;
  /**
   * `units.json`'s units, so a family-split sibling's rows count as its
   * `splitOf`'s vote. Rows carry only `unitId`; without this each unit id is
   * its own voter (the `<splitOf>-<family>` id format is not parsed).
   */
  units?: readonly VoterUnit[];
  /** Max `endLine − startLine` of one site; a run that would pass it starts a new site. Default `null` (unbounded). */
  maxSpan?: number | null;
  /** Rows whose anchor path matches are left out of ranking — e.g. `isTestPath` (`project.ts`). */
  skipPath?: (path: string) => boolean;
}

const SEVERITY_ORDER: Record<string, number> = { Critical: 0, Important: 1, Minor: 2 };
const severityRank = (s: string | null): number => SEVERITY_ORDER[s ?? ""] ?? 3;

interface Anchored {
  id: string;
  family: string;
  position: number;
  path: string | null;
  line: number | null;
  severity: string | null;
  voter: string;
}

function lineAt(row: Record<string, unknown>, path: string | null): number | null {
  const quotes = Array.isArray(row.quotes) ? row.quotes : [];
  for (const q of quotes) {
    const { path: p, line } = (q ?? {}) as { path?: unknown; line?: unknown };
    if (p === path && typeof line === "number" && Number.isFinite(line)) return line;
  }
  const at = (row.bothEnds as { introducedAt?: unknown } | undefined)?.introducedAt;
  if (typeof at !== "string") return null;
  const m = /^(.*):(\d+)$/.exec(at.trim());
  return m && (path === null || m[1] === path) ? Number(m[2]) : null;
}

function pathAt(row: Record<string, unknown>): string | null {
  const direct = pathOfRow(row);
  if (direct) return direct;
  const at = (row.bothEnds as { introducedAt?: unknown } | undefined)?.introducedAt;
  const m = typeof at === "string" ? /^(.*):\d+$/.exec(at.trim()) : null;
  return m ? m[1] : null;
}

/**
 * Pure: the same set and options always produce the same plan, so a replay of
 * a preserved workspace reproduces the live run's sites.
 */
export function clusterSites(set: HypothesisSet, options: ClusterOptions = {}): SitePlan {
  const window = Math.max(0, Math.floor(options.window ?? DEFAULT_SITE_WINDOW));
  const byFamily = options.byFamily === true;
  const voters: SiteVoters = options.voters ?? "row";
  const maxSpan = options.maxSpan == null ? null : Math.max(0, Math.floor(options.maxSpan));
  const voterOf = new Map((options.units ?? []).map((u) => [u.id, u.splitOf ?? u.id]));

  const anchored: Anchored[] = set.records.map((record, position) => {
    const row = record.row as Record<string, unknown>;
    const path = pathAt(row);
    const line = path === null ? null : lineAt(row, path);
    const unitId = row.unitId;
    const voter = typeof unitId === "string" && unitId ? `unit:${voterOf.get(unitId) ?? unitId}` : `row:${record.id}`;
    return { id: record.id, family: record.family, position, path, line, severity: severityOf(row), voter };
  });

  const groups = new Map<string, Anchored[]>();
  const runs: Anchored[][] = [];
  const skipped: string[] = [];
  for (const a of anchored) {
    if (a.path !== null && options.skipPath?.(a.path)) {
      skipped.push(a.id);
      continue;
    }
    if (a.path === null || a.line === null) {
      runs.push([a]);
      continue;
    }
    const key = byFamily ? `${a.family}\0${a.path}` : a.path;
    const group = groups.get(key);
    if (group) group.push(a);
    else groups.set(key, [a]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.line as number) - (b.line as number) || a.position - b.position);
    let run: Anchored[] = [];
    for (const a of group) {
      const gap = run.length ? (a.line as number) - (run[run.length - 1].line as number) : 0;
      const span = run.length ? (a.line as number) - (run[0].line as number) : 0;
      if (run.length && (gap > window || (maxSpan !== null && span > maxSpan))) {
        runs.push(run);
        run = [];
      }
      run.push(a);
    }
    if (run.length) runs.push(run);
  }

  const drafts = runs.map((run) => {
    const rows = [...run].sort((a, b) => a.position - b.position);
    const lines = run.map((a) => a.line).filter((n): n is number => n !== null);
    const severity = run.reduce<string | null>(
      (best, a) => (severityRank(a.severity) < severityRank(best) ? a.severity : best),
      null,
    );
    return {
      path: run[0].path,
      startLine: lines.length ? Math.min(...lines) : null,
      endLine: lines.length ? Math.max(...lines) : null,
      support: run.length,
      voters: new Set(run.map((a) => a.voter)).size,
      families: [...new Set(run.map((a) => a.family))].sort(),
      severity,
      rows: rows.map((a) => a.id),
      first: rows[0].position,
    };
  });

  // `"row"` keeps the screened order exactly (rows, severity, declaration):
  // putting voters before severity there moved a gold from the top 10 to 11.
  // `"unit"` breaks voter ties by rows first — the screen's `--tiebreak rows`.
  drafts.sort((a, b) =>
    voters === "unit"
      ? b.voters - a.voters || b.support - a.support || severityRank(a.severity) - severityRank(b.severity) || a.first - b.first
      : b.support - a.support || severityRank(a.severity) - severityRank(b.severity) || a.first - b.first,
  );

  return {
    version: SITE_PLAN_VERSION,
    window,
    byFamily,
    voters,
    maxSpan,
    rows: set.records.length,
    skipped,
    sites: drafts.map(({ first: _first, ...d }, i) => ({
      id: `site-${String(i + 1).padStart(3, "0")}`,
      rank: i + 1,
      ...d,
    })),
  };
}

// ── sites as the falsify plan ───────────────────────────────────────────────

export interface ProbeSite extends Site {
  /**
   * `support` — one of the top sites by support; `owed` — a row
   * `planProbes` would have selected that no top site covers, as a site of its
   * own. The second keeps today's Critical / survey-asked probes, and is the
   * only way a lone row (support's blind spot) reaches the oracle.
   */
  origin: "support" | "owed";
  /** This site's own plan: every row in it, declaration order. */
  plan: ProbePlan;
}

export interface ProbeSitePlan {
  version: typeof SITE_PLAN_VERSION;
  topSites: number;
  window: number;
  voters: SiteVoters;
  maxSpan: number | null;
  /**
   * Rows `skipPath` kept out of site ranking. One `planProbes` owes still gets
   * an `owed` site — skipping is about ranking, not about dropping a Critical.
   */
  skipped: string[];
  maxProbes: number | null;
  rows: number;
  /** Top sites by support first, then the owed singletons in `planProbes` rank order. */
  sites: ProbeSite[];
  /**
   * The union the `probes` gate checks: every row of every site selected, and
   * `deferred` = rows `planProbes` owed past its cap that no site covers.
   */
  union: ProbePlan;
}

/**
 * `falsify`, one session per site: the top `topSites` sites by support, plus
 * every row `planProbes` (capped at `maxProbes`) selects that none of them
 * holds, as a single-row site. Every row lands in at most one site, so each
 * row has exactly one verdict writer when the sites run in parallel.
 */
export function planProbeSites(
  set: HypothesisSet,
  options: { topSites: number; maxProbes: number | null } & Omit<ClusterOptions, "byFamily">,
): ProbeSitePlan {
  const { topSites: _t, maxProbes: _m, ...clusterOptions } = options;
  const clustered = clusterSites(set, clusterOptions);
  const top = clustered.sites.slice(0, Math.max(0, Math.floor(options.topSites)));
  const covered = new Set(top.flatMap((s) => s.rows));
  const owed = planProbes(set, { maxProbes: options.maxProbes });
  const siteOf = new Map(clustered.sites.flatMap((s) => s.rows.map((id) => [id, s] as const)));

  const sitePlan = (rows: string[]): ProbePlan => {
    const selected = rows.map((id, i) => plannedProbe(set.byId.get(id)!, i + 1));
    return { version: PROBE_PLAN_VERSION, maxProbes: null, rows: set.records.length, owed: selected.length, selected, deferred: [] };
  };

  const sites: ProbeSite[] = top.map((s) => ({ ...s, origin: "support", plan: sitePlan(s.rows) }));
  for (const p of owed.selected) {
    if (covered.has(p.id)) continue;
    const home = siteOf.get(p.id);
    const line = home && home.rows.length === 1 ? home : null;
    // A skipped row has no home site; its own anchor still names the file.
    const row = set.byId.get(p.id)!.row as Record<string, unknown>;
    const ownPath = home ? home.path : pathAt(row);
    const ownLine = home ? null : ownPath === null ? null : lineAt(row, ownPath);
    sites.push({
      id: `owed-${p.id}`,
      rank: sites.length + 1,
      path: ownPath,
      startLine: line?.startLine ?? ownLine,
      endLine: line?.endLine ?? ownLine,
      support: 1,
      voters: 1,
      families: [p.family],
      severity: severityOf(set.byId.get(p.id)!.row as Record<string, unknown>),
      rows: [p.id],
      origin: "owed",
      plan: sitePlan([p.id]),
    });
    covered.add(p.id);
  }

  const selected = sites.flatMap((s) => s.plan.selected).map((p, i) => ({ ...p, rank: i + 1 }));
  const deferred = owed.deferred.filter((p) => !covered.has(p.id));
  return {
    version: SITE_PLAN_VERSION,
    topSites: top.length,
    window: clustered.window,
    voters: clustered.voters,
    maxSpan: clustered.maxSpan,
    skipped: clustered.skipped,
    maxProbes: options.maxProbes,
    rows: set.records.length,
    sites,
    union: {
      version: PROBE_PLAN_VERSION,
      maxProbes: options.maxProbes,
      rows: set.records.length,
      owed: selected.length + deferred.length,
      selected,
      deferred,
    },
  };
}

// ── a site for an investigator: leads + brief ───────────────────────────────

/**
 * One thing the rows at a site said to look at. `subject` is the first
 * contributing row's `evidence.subject`, trimmed; `family` is that row's.
 */
export interface SiteLead {
  subject: string;
  family: string;
  /** The smallest anchor line among the merged rows, `null` if none has one. */
  line: number | null;
  /** Every row that named this subject, declaration order. */
  rows: string[];
}

export interface SiteLeads {
  leads: SiteLead[];
  /** Site rows with no string `evidence.subject` — they contribute no lead. */
  withoutSubject: string[];
}

const normaliseSubject = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The site's rows as short, deduplicated LEADS. Rows decide which sites are
 * investigated; what they hand the investigator is only the typed
 * `evidence.subject` — never claim prose, which echoes (12 rows from one unit
 * in the pilot's top site) and would anchor the investigator on the survey's
 * framing. Rows naming the same subject (case and whitespace aside) merge into
 * one lead; the most-named lead comes first, then by line.
 */
export function siteLeads(site: Pick<Site, "rows">, set: HypothesisSet): SiteLeads {
  const byKey = new Map<string, SiteLead & { first: number }>();
  const withoutSubject: string[] = [];
  site.rows.forEach((id, position) => {
    const record = set.byId.get(id);
    const row = (record?.row ?? {}) as Record<string, unknown>;
    const evidence = row.evidence as SurveyEvidence | undefined;
    const raw = evidence && typeof evidence === "object" ? evidence.subject : undefined;
    const subject = typeof raw === "string" ? raw.trim() : "";
    if (!record || !subject) {
      withoutSubject.push(id);
      return;
    }
    const path = pathAt(row);
    const line = path === null ? null : lineAt(row, path);
    const key = normaliseSubject(subject);
    const lead = byKey.get(key);
    if (!lead) {
      byKey.set(key, { subject, family: record.family, line, rows: [id], first: position });
      return;
    }
    lead.rows.push(id);
    if (line !== null && (lead.line === null || line < lead.line)) lead.line = line;
  });
  const leads = [...byKey.values()]
    .sort(
      (a, b) =>
        b.rows.length - a.rows.length ||
        (a.line ?? Number.POSITIVE_INFINITY) - (b.line ?? Number.POSITIVE_INFINITY) ||
        a.first - b.first,
    )
    .map(({ first: _first, ...lead }) => lead);
  return { leads, withoutSubject };
}

/**
 * The markdown a per-site investigator reads: where the site is, how strong
 * its vote is, and (with `leads`) what the rows there named. Data only — the
 * investigator's prompt carries the instructions, so an arm with and without
 * leads differs in exactly the lead list.
 */
export function renderSiteBrief(
  site: Pick<Site, "id" | "path" | "startLine" | "endLine" | "support" | "voters" | "rows">,
  set: HypothesisSet,
  options: { leads: boolean },
): string {
  const where =
    site.path === null
      ? "no anchored location"
      : `\`${site.path}\`${site.startLine !== null ? ` lines ${site.startLine}–${site.endLine}` : ""}`;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const out = [
    `## Site \`${site.id}\` — ${where}`,
    "",
    "A stretch of code the survey's hypotheses point at.",
    "",
    `- Support: ${plural(site.support, "row")} from ${plural(site.voters, "distinct voter")}`,
    "",
  ];
  if (!options.leads) {
    out.push("No leads are given for this site.");
    return `${out.join("\n")}\n`;
  }
  const { leads } = siteLeads(site, set);
  if (leads.length === 0) {
    out.push("No hypothesis at this site named a subject, so there are no leads.");
    return `${out.join("\n")}\n`;
  }
  out.push("### Leads", "");
  leads.forEach((lead, i) => {
    const bits = [lead.family, ...(lead.line !== null ? [`L${lead.line}`] : []), plural(lead.rows.length, "row")];
    out.push(`${i + 1}. ${lead.subject.replace(/\s+/g, " ")} (${bits.join(", ")})`);
  });
  return `${out.join("\n")}\n`;
}
