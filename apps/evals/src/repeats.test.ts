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
import { BAKED_FACTS_BIN, makeRunId, resolveFactsBin } from "./paths.js";
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

  it("falls back to PATH, then to the baked path, then to null", () => {
    const dir = tmp();
    try {
      const bin = join(dir, "lastlight-facts");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      expect(resolveFactsBin({ PATH: dir })).toBe(bin);
      // On a dev host the baked path does not exist and this is null; inside the
      // sandbox image it does. Both are correct — asserting a bare null would
      // make this test fail in exactly the environment the binary ships in.
      expect([null, BAKED_FACTS_BIN]).toContain(resolveFactsBin({ PATH: join(dir, "empty") }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
