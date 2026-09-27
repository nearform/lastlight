import type { IndexRun, IndexTier, UnitSurveyEntry } from "../types";

/**
 * The home page's "Recent runs" list: every eval run across every tier, plus
 * every unit-survey replay report, as ONE time-ordered list, newest first.
 *
 * The two come from separate indexes (`/api/index` and `/api/unit-survey`) —
 * a replay is not a run (no tier, no scorecard) — so the merge is a
 * discriminated union and the row renderer switches on `kind`. Micro-survey
 * reports are deliberately NOT merged here; they stay on their own page.
 */
export type RecentItem =
  | { kind: "run"; key: string; at: string; tierKey: string; run: IndexRun }
  | { kind: "unit-survey"; key: string; at: string; entry: UnitSurveyEntry };

export function mergeRecent(tiers: IndexTier[], unitReports: UnitSurveyEntry[]): RecentItem[] {
  const items: RecentItem[] = [
    ...tiers.flatMap((t) =>
      t.runs.map((run): RecentItem => ({ kind: "run", key: `${t.key}/${run.id}`, at: run.generatedAt, tierKey: t.key, run })),
    ),
    ...unitReports.map((entry): RecentItem => ({
      kind: "unit-survey",
      key: `unit-survey/${entry.id}`,
      at: entry.generatedAt,
      entry,
    })),
  ];
  // Stable on ties, so equal timestamps keep their index order.
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
