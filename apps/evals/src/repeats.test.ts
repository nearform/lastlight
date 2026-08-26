/**
 * `--repeats N` — the arm-level band.
 *
 * Three identical runs of one arm scored micro-recall 0.320 / 0.080 / 0.200, and
 * `diff-runs` returned KEEP on one and REVERT on the other two FROM ONE
 * CONFIGURATION. `--repeats` runs the whole arm N times so a result can be read
 * as a band; these are the mechanical facts that band rests on.
 *
 * `run.ts` cannot be imported — `main()` self-invokes at module scope, so the
 * module exports nothing and importing it would run an eval. The CLI-surface
 * facts are therefore pinned against its SOURCE, and everything with real logic
 * in it lives in `report.ts`/`paths.ts` where it can be called directly (the
 * split `apps/evals/CLAUDE.md` describes).
 */
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { groupRepeats, repeatGroupOf, writeScorecard, summarize, type RunMeta, type Scorecard } from "./report.js";
import { BAKED_FACTS_BIN, assignRunIds, makeRunId, resolveFactsBin } from "./paths.js";
import { configArm, releaseOverlayGuard } from "./arm.js";

const here = dirname(fileURLToPath(import.meta.url));
const runSource = readFileSync(join(here, "run.ts"), "utf8");

const tmp = (): string => mkdtempSync(join(tmpdir(), "evals-repeats-"));

describe("--repeats — the CLI surface (pinned against run.ts's source)", () => {
  it("is in VALUE_FLAGS, so `--repeats 3 pr-review` does not read 3 as a tier name", () => {
    // The positional-tier scan skips a VALUE_FLAG *and the token after it*.
    // Omit `--repeats` there and `3` becomes a requested tier, the run warns
    // `Unknown tier "3"` and measures whatever tier was left — a wasted arm.
    const valueFlags = /const VALUE_FLAGS = new Set\((\[[^\]]*\])\)/.exec(runSource);
    expect(valueFlags, "VALUE_FLAGS declaration not found in run.ts").toBeTruthy();
    expect(JSON.parse(valueFlags![1]) as string[]).toContain("--repeats");
  });

  it("implies --keep-workspace and --no-open", () => {
    // Both are load-bearing, not conveniences: a repeat was already lost for want
    // of the workspace, and `run` holds its dashboard server open forever, so a
    // repeat loop that started one per repeat would leak N of them.
    expect(runSource).toMatch(/const keepWorkspace = process\.argv\.includes\("--keep-workspace"\) \|\| repeats > 1;/);
    expect(runSource).toMatch(/const noOpen = .*\|\| repeats > 1;/);
  });

  it("releases the overlay guard at the end of every repeat, not only on an arm change", () => {
    // The serial branch declares `currentArm` inside itself and releases only
    // when the arm CHANGES — never after the last arm. Repeat 2 would then call
    // `arm.activate()` with repeat 1's overlay still marked active, and
    // `activateOverlay` throws (ADR 0001). The release must sit in a `finally`
    // wrapping the whole per-repeat execution.
    const loopBody = runSource.slice(runSource.indexOf("for (repeatIndex = 1;"));
    expect(loopBody.slice(0, loopBody.indexOf("totalHarnessErrors += harnessErrors"))).toContain("releaseOverlayGuard();");
  });

  it("gives each repeat a fresh sibling runId rather than nesting under the first", () => {
    // `indexTier`/`buildIndex` and `clean.ts` all walk exactly two levels
    // (`<tierKey>/<runId>/scorecard.json`), so `<runId>/rep-2/` would be
    // invisible to the dashboard index AND uncleanable.
    expect(runSource).toMatch(/runId = makeRunId\(new Date\(\), gitSha, tierResultsDir\(tierKeyFor\(tiers\[0\]\)\)\)/);
    expect(runSource).not.toMatch(/rep-\$\{repeat/);
  });
});

describe("the overlay guard across a repeat boundary (the trap --repeats has to clear)", () => {
  const examples = join(here, "..", "examples");

  it("throws on repeat 2 if the last arm of repeat 1 was never released", () => {
    // This is the failure `--repeats` had to be built around, reproduced exactly:
    // the serial loop releases only on an arm CHANGE, so the final arm's overlay
    // is still marked active when the next repeat starts. Two arms is the
    // trigger — with one arm the re-activation is of the SAME overlay and the
    // guard's `overlayDir !== activeOverlay` test lets it through.
    const a = configArm("", join(examples, "overlay"));
    const b = configArm("", join(examples, "overlay-anthropic"));
    releaseOverlayGuard();
    a.activate();
    releaseOverlayGuard(); // the arm change inside repeat 1
    b.activate();
    // …and now repeat 2 starts, with no release after `b`:
    expect(() => a.activate()).toThrow(/Refusing to activate overlay/);
    releaseOverlayGuard();
  });

  it("is fine once the repeat releases at its own end", () => {
    const a = configArm("", join(examples, "overlay"));
    const b = configArm("", join(examples, "overlay-anthropic"));
    releaseOverlayGuard();
    a.activate();
    releaseOverlayGuard();
    b.activate();
    releaseOverlayGuard(); // ← what the repeat loop's `finally` adds
    expect(() => a.activate()).not.toThrow();
    releaseOverlayGuard();
  });

  it("a single-arm run would NOT have tripped it — re-activating the same overlay is allowed", () => {
    const a = configArm("", join(examples, "overlay"));
    releaseOverlayGuard();
    a.activate();
    expect(() => a.activate()).not.toThrow();
    releaseOverlayGuard();
  });
});

describe("--repeat-concurrency — the CLI surface (pinned against run.ts's source)", () => {
  it("is in VALUE_FLAGS, so `--repeat-concurrency 3 pr-review` does not read 3 as a tier", () => {
    const valueFlags = /const VALUE_FLAGS = new Set\((\[[^\]]*\])\)/.exec(runSource);
    expect(valueFlags, "VALUE_FLAGS declaration not found in run.ts").toBeTruthy();
    expect(JSON.parse(valueFlags![1]) as string[]).toContain("--repeat-concurrency");
  });

  it("defaults to sequential — the concurrent branch is gated on BOTH flags", () => {
    // `--repeat-concurrency 1` (or no `--repeats`) must take the exact repeat
    // loop that always existed; the overlap is opt-in twice over.
    expect(runSource).toMatch(/const repeatsConcurrent = repeats > 1 && repeatConcurrency > 1;/);
    // …and the sequential loop still assigns each sibling id lazily, unchanged.
    expect(runSource).toMatch(/runId = makeRunId\(new Date\(\), gitSha, tierResultsDir\(tierKeyFor\(tiers\[0\]\)\)\)/);
  });

  it("clamps to 1 on --sandbox gondolin and on multi-overlay config runs", () => {
    // gondolin: one QEMU micro-VM at a time — same policy as --concurrency.
    expect(runSource).toMatch(/sandbox === "gondolin" && repeatConcurrency > 1/);
    // Multi-overlay config: there is no single overlay for the batch-wide
    // asset-root window to hold (ADR 0001), so repeats must stay sequential.
    expect(runSource).toMatch(/runType === "config" && arms\.length > 1 && repeatConcurrency > 1/);
  });

  it("pre-assigns every sibling runId before launch, from assignRunIds", () => {
    // Lazy per-repeat assignment cannot work overlapped: N launches inside one
    // second would all resolve the same id (nothing is on disk yet to dedupe
    // against). The whole band's ids are assigned up front instead.
    expect(runSource).toMatch(/assignRunIds\(repeats, new Date\(\), gitSha, tierResultsDir\(tierKeyFor\(tiers\[0\]\)\)\)/);
  });

  it("holds the overlay guard across the whole batch and releases it exactly once", () => {
    const start = runSource.indexOf("if (repeatsConcurrent) {");
    expect(start, "concurrent-repeats branch not found in run.ts").toBeGreaterThan(-1);
    const branch = runSource.slice(start, runSource.indexOf("for (repeatIndex = 1;"));
    // Activated once, batch-wide, before any repeat launches…
    expect(branch).toContain("for (const arm of arms) arm.activate();");
    // …run through the shared pool at the repeat level…
    expect(branch).toContain("mapPool(states, repeatConcurrency");
    // …and released in a finally, whatever happened.
    expect(branch).toMatch(/finally \{[^}]*releaseOverlayGuard\(\);/s);
    // Console is silenced once for the batch (quiet() is not concurrency-safe).
    expect(branch).toContain("silenceConsole()");
  });

  it("stamps meta.repeat.concurrency only when the repeats actually overlapped", () => {
    // The latency caveat must be legible on every repeat of an overlapped band,
    // and ABSENT (not 1) on a sequential band — absent reads as "not overlapped".
    expect(runSource).toMatch(/\.\.\.\(repeatsConcurrent \? \{ concurrency: repeatConcurrency \} : \{\}\)/);
  });
});

describe("assignRunIds — pre-assigned sibling ids for concurrent repeats", () => {
  const at = new Date("2026-08-23T14:30:52.123Z");

  it("assigns unique, <timestamp>-<sha>-shaped ids from one instant", () => {
    const ids = assignRunIds(4, at, "abc1234");
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}-abc1234$/);
    // Batch-unique STAMPS, not just ids: backfill-pipeline's runStampOf treats
    // the YYYY-MM-DD_HHMMSS prefix as a per-run key when matching archives.
    const stamps = ids.map((id) => id.slice(0, 17));
    expect(new Set(stamps).size).toBe(4);
    // Launch order is preserved and sortable.
    expect([...ids].sort()).toEqual(ids);
  });

  it("index 0 is exactly what a plain run would have been named — the band's group", () => {
    // `meta.repeat.group` = the first repeat's runId; pre-assignment must not
    // change what that first id would have been.
    expect(assignRunIds(3, at, "abc1234")[0]).toBe(makeRunId(at, "abc1234"));
  });

  it("steps over ids already on disk, keeping the run-dir shape", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "2026-08-23_143052-abc1234"), { recursive: true });
      const ids = assignRunIds(2, at, "abc1234", dir);
      // The colliding first id takes makeRunId's usual on-disk suffix…
      expect(ids[0]).toBe("2026-08-23_143052-abc1234-2");
      // …and the second moves to the next second, exactly as with no collision.
      expect(ids[1]).toBe("2026-08-23_143053-abc1234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a band of one degenerates to makeRunId", () => {
    expect(assignRunIds(1, at, "abc1234")).toEqual([makeRunId(at, "abc1234")]);
  });
});

describe("sibling run ids — two repeats in the same second must not collide", () => {
  it("suffixes -2/-3 when the parent dir already holds the id", () => {
    const dir = tmp();
    try {
      const at = new Date("2026-08-23T14:30:52.123Z");
      const first = makeRunId(at, "abc1234", dir);
      mkdirSync(join(dir, first), { recursive: true });
      const second = makeRunId(at, "abc1234", dir);
      mkdirSync(join(dir, second), { recursive: true });
      const third = makeRunId(at, "abc1234", dir);

      expect(first).toBe("2026-08-23_143052-abc1234");
      expect(second).toBe("2026-08-23_143052-abc1234-2");
      expect(third).toBe("2026-08-23_143052-abc1234-3");
      expect(new Set([first, second, third]).size).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("meta.repeat — the band lives in meta, not the filesystem", () => {
  const meta = (over: Partial<RunMeta>): RunMeta => ({
    runId: "r1",
    generatedAt: "2026-08-23T00:00:00.000Z",
    tiers: ["pr-review"],
    models: ["wp3"],
    runs: 1,
    ...over,
  });

  it("round-trips through writeScorecard → JSON", () => {
    const dir = tmp();
    try {
      const card: Scorecard = summarize([]);
      card.meta = meta({ runId: "r2", repeat: { group: "r1", index: 2, of: 3 } });
      const path = writeScorecard(dir, card);
      const back = JSON.parse(readFileSync(path, "utf8")) as Scorecard;
      expect(back.meta?.repeat).toEqual({ group: "r1", index: 2, of: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the overlap stamp (repeat.concurrency) — the latency caveat must survive to disk", () => {
    const dir = tmp();
    try {
      const card: Scorecard = summarize([]);
      card.meta = meta({ runId: "r2", repeat: { group: "r1", index: 2, of: 3, concurrency: 3 } });
      const back = JSON.parse(readFileSync(writeScorecard(dir, card), "utf8")) as Scorecard;
      expect(back.meta?.repeat).toEqual({ group: "r1", index: 2, of: 3, concurrency: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still groups repeats that carry the overlap stamp", () => {
    const card = (runId: string, index: number): Scorecard => ({
      models: [],
      results: [],
      meta: meta({ runId, repeat: { group: "r1", index, of: 2, concurrency: 2 } }),
    });
    const [band] = groupRepeats([card("r2", 2), card("r1", 1)]);
    expect(band.group).toBe("r1");
    expect(band.cards.map((c) => c.meta!.runId)).toEqual(["r1", "r2"]);
  });

  it("is optional — an ordinary run carries none and still groups as a band of one", () => {
    const solo: Scorecard = { models: [], results: [], meta: meta({ runId: "solo" }) };
    expect(solo.meta?.repeat).toBeUndefined();
    expect(repeatGroupOf(solo)).toBe("solo");
  });

  it("groups siblings by their group id, ordered by index", () => {
    const card = (runId: string, index?: number): Scorecard => ({
      models: [],
      results: [],
      meta: meta({ runId, repeat: index === undefined ? undefined : { group: "r1", index, of: 3 } }),
    });
    // Deliberately out of order on the way in.
    const bands = groupRepeats([card("r3", 3), card("solo"), card("r1", 1), card("r2", 2)]);
    const band = bands.find((b) => b.group === "r1")!;
    expect(band.cards.map((c) => c.meta!.runId)).toEqual(["r1", "r2", "r3"]);
    expect(band.of).toBe(3);
    // An ungrouped run is its own band of one, never folded into someone else's.
    expect(bands.find((b) => b.group === "solo")!.cards).toHaveLength(1);
  });

  it("reports the DECLARED width, so a truncated band is visible as truncated", () => {
    // A band whose third repeat was killed must not read as a complete band of
    // two — that is exactly the misreading `--repeats` exists to prevent.
    const card = (runId: string, index: number): Scorecard => ({
      models: [],
      results: [],
      meta: meta({ runId, repeat: { group: "r1", index, of: 3 } }),
    });
    const [band] = groupRepeats([card("r1", 1), card("r2", 2)]);
    expect(band.of).toBe(3);
    expect(band.cards).toHaveLength(2);
  });

  it("drops a card with no meta at all rather than inventing a repeat", () => {
    expect(groupRepeats([{ models: [], results: [] }])).toEqual([]);
  });
});

describe("run provenance — resolveFactsBin (§D1's order)", () => {
  it("prefers LASTLIGHT_FACTS_BIN, and returns null when it points at nothing executable", () => {
    const dir = tmp();
    try {
      const bin = join(dir, "lastlight-facts");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      expect(resolveFactsBin({ LASTLIGHT_FACTS_BIN: bin, PATH: "" })).toBe(bin);

      // A pointer that is WRONG is a configuration error the operator wants to
      // see, not a reason to quietly fall through to a different binary.
      const notThere = join(dir, "nope");
      expect(resolveFactsBin({ LASTLIGHT_FACTS_BIN: notThere, PATH: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to PATH, then the baked path, then the workspace sibling, then null", () => {
    const dir = tmp();
    try {
      const bin = join(dir, "lastlight-facts");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      expect(resolveFactsBin({ PATH: dir })).toBe(bin);
      // With nothing on PATH the answer depends on the host: null on a bare dev
      // host, the baked path inside the sandbox image, and the monorepo's own
      // `packages/code-facts/dist/cli.js` when the harness runs from the
      // workspace (the fallback added after a shell without LASTLIGHT_FACTS_BIN
      // ran the whole pr-review ladder with the conservation gate dead). All
      // three are correct; a bare-null assertion would fail exactly where the
      // binary ships.
      const resolved = resolveFactsBin({ PATH: join(dir, "empty") });
      expect(resolved === null || resolved === BAKED_FACTS_BIN || /code-facts[/\\]dist[/\\]cli\.js$/.test(resolved)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
