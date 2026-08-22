import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapPool } from "./pool.js";
import { bucketSessionsByPhase, listSessionFiles } from "./metrics.js";

/**
 * `mapPool` is what makes `--concurrency N` safe to default to 1: the whole
 * "byte-identical when the flag is absent" claim rests on limit<=1 being an
 * ordinary serial loop, and on results index-aligning with their inputs.
 */
describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    // Later items finish FIRST, so any implementation that pushes on completion
    // rather than assigning by index comes back reversed.
    const items = [40, 30, 20, 10];
    const out = await mapPool(items, 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([40, 30, 20, 10]);
  });

  it("never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(peak).toBe(3);
  });

  it("limit 1 is a serial loop — the default's no-op property", async () => {
    const order: number[] = [];
    let peak = 0;
    let inFlight = 0;
    await mapPool([1, 2, 3, 4], 1, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      order.push(i);
      inFlight--;
      return i;
    });
    expect(peak).toBe(1);
    // Started AND finished strictly in order — no interleaving at all.
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("handles an empty list without spawning a worker", async () => {
    expect(await mapPool([], 8, async () => 1)).toEqual([]);
  });

  it("propagates a rejection rather than swallowing it", async () => {
    await expect(
      mapPool([1, 2], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});

/**
 * Phase attribution is the other half of the instrument: a session file belongs
 * to the last phase that started at or before its first line.
 */
describe("bucketSessionsByPhase", () => {
  const starts = [
    { phase: "facts", start: 1_000 },
    { phase: "seed", start: 2_000 },
    { phase: "survey", start: 3_000 },
  ];

  it("attributes each session to the phase whose window it falls in", () => {
    const { buckets, order } = bucketSessionsByPhase(
      [
        { file: "a.jsonl", firstTs: 1_100 },
        { file: "b.jsonl", firstTs: 2_500 },
        { file: "c.jsonl", firstTs: 3_200 },
      ],
      starts,
    );
    expect(order).toEqual(["facts", "seed", "survey"]);
    expect(buckets.get("facts")).toEqual(["a.jsonl"]);
    expect(buckets.get("seed")).toEqual(["b.jsonl"]);
    expect(buckets.get("survey")).toEqual(["c.jsonl"]);
  });

  it("collapses an UNSTAMPED fan-out onto one phase — the limit the stamp exists to fix", () => {
    // Six concurrent branches, no stamps: the window rule can only answer with
    // the last phase started before each file, so all six land on the parent.
    // That is exactly the misattribution that hid $1.23 of a $2.01 case, and it
    // is why this is the FALLBACK. The stamped case below is the real rule.
    const files = [3_050, 3_060, 3_070, 3_080, 3_090, 3_100].map((t, i) => ({
      file: `s${i}.jsonl`,
      firstTs: t,
    }));
    const { buckets, order } = bucketSessionsByPhase(files, starts);
    expect(order).toEqual(["survey"]);
    expect(buckets.get("survey")).toHaveLength(6);
  });

  it("gives a session 50ms of slack against its phase's start", () => {
    // The write lands fractionally before the callback records the start.
    const { buckets } = bucketSessionsByPhase([{ file: "x.jsonl", firstTs: 1_970 }], starts);
    expect(buckets.get("seed")).toEqual(["x.jsonl"]);
  });

  it("falls back to the first phase for a session that predates every start", () => {
    const { buckets } = bucketSessionsByPhase([{ file: "early.jsonl", firstTs: 5 }], starts);
    expect(buckets.get("facts")).toEqual(["early.jsonl"]);
  });

  it("is total on an empty phase list", () => {
    const { buckets } = bucketSessionsByPhase([{ file: "o.jsonl", firstTs: 9 }], []);
    expect(buckets.get("session")).toEqual(["o.jsonl"]);
  });

  it("prefers the stamp over the window when they disagree", () => {
    // `writeCommandSession` writes a command's session AFTER it finishes, so
    // `facts`' jsonl can land at `seed`'s start. The window rule bills it to
    // `seed` — a model-free bash phase reporting agent time. The stamp does not.
    const { buckets } = bucketSessionsByPhase([{ file: "facts.jsonl", firstTs: 2_400, phase: "facts" }], starts);
    expect(buckets.get("facts")).toEqual(["facts.jsonl"]);
    expect(buckets.has("seed")).toBe(false);
  });

  it("gives every stamped fan-out branch its own bucket", () => {
    const families = ["contract", "enforcement", "security", "state", "tests", "spec"];
    // Launched within 35ms of each other — indistinguishable to a start-time
    // lookup, exact under the stamp.
    const files = families.map((f, i) => ({
      file: `${f}.jsonl`,
      firstTs: 3_050 + i * 7,
      phase: `survey_branch_${f}`,
    }));
    const { buckets, order } = bucketSessionsByPhase(files, starts);
    expect(order).toEqual(families.map((f) => `survey_branch_${f}`));
    for (const f of families) expect(buckets.get(`survey_branch_${f}`)).toEqual([`${f}.jsonl`]);
  });

  it("mixes stamped and unstamped sessions in one run", () => {
    // What a re-scored historical run looks like mid-migration.
    const { buckets } = bucketSessionsByPhase(
      [
        { file: "old.jsonl", firstTs: 1_100 },
        { file: "new.jsonl", firstTs: 1_200, phase: "survey_branch_spec" },
      ],
      starts,
    );
    expect(buckets.get("facts")).toEqual(["old.jsonl"]);
    expect(buckets.get("survey_branch_spec")).toEqual(["new.jsonl"]);
  });

  it("ignores an empty stamp rather than bucketing under the empty string", () => {
    const { buckets } = bucketSessionsByPhase([{ file: "e.jsonl", firstTs: 1_100, phase: "" }], starts);
    expect(buckets.get("facts")).toEqual(["e.jsonl"]);
  });
});

describe("listSessionFiles", () => {
  const write = (dir: string, name: string, lines: unknown[]): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };

  it("reads the phase stamp off the opening envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "ll-sessions-"));
    const proj = join(root, "projects", "-w");
    write(proj, "a.jsonl", [
      { type: "user", timestamp: "2026-08-22T14:40:10.500Z", phase: "survey_branch_contract" },
      { type: "result", timestamp: "2026-08-22T14:40:26.000Z", phase: "survey_branch_contract" },
    ]);
    const [f] = listSessionFiles(root);
    expect(f.phase).toBe("survey_branch_contract");
    expect(f.firstTs).toBe(Date.parse("2026-08-22T14:40:10.500Z"));
  });

  it("finds a stamp that only appears on the closing envelope", () => {
    // A session bootstrapped from a stub `session` record carries no stamp on
    // line 1, so the scan must not stop at the first timestamp.
    const root = mkdtempSync(join(tmpdir(), "ll-sessions-"));
    write(join(root, "projects", "-w"), "b.jsonl", [
      { type: "session", timestamp: "2026-08-22T14:40:10.500Z" },
      { type: "result", timestamp: "2026-08-22T14:40:26.000Z", phase: "review" },
    ]);
    expect(listSessionFiles(root)[0].phase).toBe("review");
  });

  it("leaves phase undefined for a pre-stamp session", () => {
    const root = mkdtempSync(join(tmpdir(), "ll-sessions-"));
    write(join(root, "projects", "-w"), "c.jsonl", [
      { type: "user", timestamp: "2026-08-20T10:00:00.000Z" },
      { type: "result", timestamp: "2026-08-20T10:01:00.000Z" },
    ]);
    expect(listSessionFiles(root)[0].phase).toBeUndefined();
  });
});
