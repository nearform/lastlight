import { describe, expect, it } from "vitest";

import type { IndexRun, ModelSummary } from "../types";
import { modelDisplay, modelKey } from "./format";
import { armOf, groupRuns } from "./runGroups";

/** The real registry labels a run carries (`meta.labels`), trimmed. Note what it
 * does NOT contain: the PINNED snapshot id every measured pr-review run was
 * launched against. That gap is what gave one model two columns. */
const labels = {
  "openai/gpt-5.4-mini": "GPT-5.4 mini",
  "anthropic/claude-haiku-4-5": "Claude Haiku 4.5",
  "anthropic/claude-sonnet-4-6": "Claude Sonnet 4.6",
  "fireworks/accounts/fireworks/models/glm-5p2": "GLM-5.2",
};

const summary = (model: string, over: Partial<ModelSummary> = {}): ModelSummary => ({
  model,
  total: 8,
  codeFixResolved: 0,
  codeFixTotal: 0,
  behavioralOk: 0,
  behavioralTotal: 0,
  reviewTotal: 8,
  avgPrecision: 0,
  avgRecall: 0,
  avgFbeta: 0,
  micro: { cases: 8, posted: 40, gold: 25, matched: 8, microRecall: 0.32, microPrecision: 0.2, microF1: 0.25, snr: 0.25, emptyGoldCases: [], commentsPerPr: 5 },
  avgInputTokens: 0,
  avgCachedTokens: 0,
  avgOutputTokens: 0,
  totalCostUsd: 1,
  p50DurationMs: 0,
  errors: 0,
  ...over,
});

const run = (over: Partial<IndexRun> & { id: string; generatedAt: string }): IndexRun => ({
  scorecard: `/data/pr-review/${over.id}/scorecard.json`,
  runId: over.id,
  gitSha: "00cc469",
  tiers: ["pr-review"],
  labels,
  byTier: [{ tier: "pr-review", models: [summary("anthropic/claude-haiku-4-5-20251001")] }],
  runs: 1,
  live: false,
  interrupted: false,
  ...over,
});

describe("one model, one name", () => {
  it("collapses a pinned snapshot id onto its registry label", () => {
    // The screenshot bug: `Claude Haiku 4.5` and
    // `ANTHROPIC/CLAUDE-HAIKU-4-5-20251001` were two columns of the same model.
    expect(modelDisplay(labels, "anthropic/claude-haiku-4-5-20251001")).toEqual({
      label: "Claude Haiku 4.5",
      title: "anthropic/claude-haiku-4-5-20251001",
    });
    expect(modelKey("anthropic/claude-haiku-4-5-20251001")).toBe(modelKey("Claude Haiku 4.5"));
  });

  it("matches a label that was already resolved by the harness", () => {
    // `meta.models` sometimes holds the LABEL, not the id (older runs).
    expect(modelDisplay(labels, "GPT-5.4 mini").label).toBe("GPT-5.4 mini");
  });

  it("keeps a version like 4-5 — only a 6+ digit snapshot date is a suffix", () => {
    expect(modelKey("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("falls back to the bare model name, never a blank, for an unregistered id", () => {
    expect(modelDisplay(labels, "openrouter/some-new-model-20260101")).toEqual({
      label: "some-new-model",
      title: "openrouter/some-new-model-20260101",
    });
  });
});

describe("a repeat band is one row", () => {
  const banded = (id: string, index: number, of: number, microRecall: number) =>
    run({
      id,
      generatedAt: `2026-08-25T0${index}:00:00.000Z`,
      overlay: "overlays/wp3-minimal-d2ab",
      repeat: { group: "2026-08-25_030141-33afc93", index, of },
      byTier: [
        {
          tier: "pr-review",
          models: [
            summary("anthropic/claude-haiku-4-5-20251001", {
              micro: { ...summary("x").micro!, microRecall, matched: Math.round(microRecall * 25) },
            }),
          ],
        },
      ],
    });

  it("folds N sibling runs into a single group keyed on meta.repeat.group", () => {
    const groups = groupRuns([banded("b", 2, 2, 0.08), banded("a", 1, 2, 0.32)], "pr-review", labels);
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a", "b"]); // repeat index order
    expect(groups[0].points.map((p) => p.label)).toEqual(["#1", "#2"]);
    expect(groups[0].points.map((p) => p.text)).toEqual(["32% · 8/25", "8% · 2/25"]);
    expect(groups[0].cost).toBe(2); // summed across the band
    expect(groups[0].cases).toBe(8); // the arm's case count, not the sum
  });

  it("reports the band only once every launched repeat has landed", () => {
    const partial = groupRuns([banded("a", 1, 3, 0.32)], "pr-review", labels)[0];
    expect(partial.outstanding).toBe(2);
    expect(partial.mean).toBeNull(); // the first repeats to finish are not the band
    expect(partial.points).toHaveLength(1); // …but the landed one is still shown

    const complete = groupRuns([banded("a", 1, 2, 0.32), banded("b", 2, 2, 0.08)], "pr-review", labels)[0];
    expect(complete.outstanding).toBe(0);
    expect(complete.mean).toBeCloseTo(0.2, 6);
    expect(complete.band).toBeCloseTo(0.24, 6); // max − min, the harness's definition
  });

  it("withholds the mean while any repeat is still LIVE — pre-assigned dirs land before runs finish", () => {
    const a = banded("a", 1, 2, 0.32);
    const b = { ...banded("b", 2, 2, 0.08), live: true };
    const g = groupRuns([a, b], "pr-review", labels)[0];
    expect(g.outstanding).toBe(0); // both dirs discovered…
    expect(g.mean).toBeNull(); // …but a μ over a partial scorecard is a moving number
    expect(g.band).toBeNull();
    expect(g.points).toHaveLength(2); // the partial chips still show
  });

  it("keeps every git sha in the band — a commit can land mid-band", () => {
    const a = { ...banded("a", 1, 2, 0.32), gitSha: "00cc469" };
    const b = { ...banded("b", 2, 2, 0.08), gitSha: "64862d5" };
    expect(groupRuns([a, b], "pr-review", labels)[0].gitShas).toEqual(["00cc469", "64862d5"]);
  });
});

describe("runs with no repeat/overlay meta at all", () => {
  // The four preserved 2026-08-22 keeper runs carry none of it. They must render
  // as ordinary single rows — never grouped by a heuristic, which would fold a
  // baseline in with the candidates it is the control for.
  const keepers = ["2026-08-22_184650-00cc469", "2026-08-22_194234-00cc469"].map((id, i) =>
    run({ id, generatedAt: `2026-08-22T${19 + i}:00:00.000Z` }),
  );

  it("stays one row per run", () => {
    const groups = groupRuns(keepers, "pr-review", labels);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.banded)).toEqual([false, false]);
    expect(groups[0].latest.id).toBe("2026-08-22_194234-00cc469"); // newest first
  });

  it("renders an unlabelled arm rather than inventing one", () => {
    const arm = armOf(keepers[0], "pr-review", labels);
    expect(arm.overlay).toBeUndefined(); // "not recorded", not "none"
    expect(arm.models).toEqual([
      { label: "Claude Haiku 4.5", title: "anthropic/claude-haiku-4-5-20251001" },
    ]);
  });

  it("drops the repeat prefix when a row is a single run", () => {
    expect(groupRuns(keepers, "pr-review", labels)[0].points.map((p) => p.label)).toEqual([""]);
  });
});

describe("arms that are not models", () => {
  it("shows a config run's overlay name verbatim", () => {
    const cfg = run({
      id: "c",
      generatedAt: "2026-08-24T08:25:40.000Z",
      runType: "config",
      overlay: "overlays/wp3-minimal",
      byTier: [{ tier: "pr-review-config", models: [summary("wp3-minimal")] }],
    });
    const arm = armOf(cfg, "pr-review-config", labels);
    expect(arm.runType).toBe("config");
    expect(arm.overlay).toBe("wp3-minimal");
    expect(arm.models).toEqual([{ label: "wp3-minimal", title: "wp3-minimal" }]);
  });

  it("gives a multi-arm compare run a chip per arm but NO band", () => {
    // The spread across twelve different models is not a band — a band is one
    // arm re-run. Averaging the arms would have printed "μ98% ±13%" for the
    // twelve-model triage-compare run.
    const compare = run({
      id: "cmp",
      generatedAt: "2026-07-18T07:26:00.000Z",
      byTier: [
        {
          tier: "triage",
          models: [
            summary("openai/gpt-5.4-mini", { behavioralTotal: 4, behavioralOk: 4, micro: undefined }),
            summary("anthropic/claude-haiku-4-5", { behavioralTotal: 4, behavioralOk: 1, micro: undefined }),
          ],
        },
      ],
    });
    const g = groupRuns([compare], "triage", labels)[0];
    expect(g.points.map((p) => p.label)).toEqual(["GPT-5.4 mini", "Claude Haiku 4.5"]);
    expect(g.points.map((p) => p.text)).toEqual(["4/4", "1/4"]);
    expect(g.mean).toBeNull();
  });

  it("names the arm from meta.models while a live run has nothing graded yet", () => {
    const live = run({
      id: "l",
      generatedAt: "2026-08-25T09:00:00.000Z",
      live: true,
      byTier: [],
      models: ["anthropic/claude-haiku-4-5-20251001"],
      overlay: "overlays/wp3-minimal-d2ab",
    });
    expect(armOf(live, "pr-review", labels).models[0].label).toBe("Claude Haiku 4.5");
  });
});
