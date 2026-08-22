/**
 * `--never-fail` does NOT cover a dead process — pinned as an executable fact.
 *
 * `CLAUDE.md` states it in a table, and a table is not a guard. The wrapper is
 * an in-process `try`/`catch` (`runWrapped`), so it covers every failure that
 * RAISES — a missing binary, an unparseable tsconfig, a directory that is not a
 * git repo — and it cannot cover a process that dies:
 *
 *   not a git repo, --never-fail  → exit 0,   coverage:"none" envelope   ✓
 *   OOM,                     "    → exit 134, NO envelope                ✗
 *
 * The first line is `tests/fail-loud.test.ts`. This file is the second, and its
 * whole purpose is to stop someone "fixing" the hole into a false guarantee: a
 * `process.on("uncaughtException")` or an `--max-old-space-size` bump inside
 * this package would make the table read as if the envelope were always
 * written, and the workflow phase would drop the shell-level catch that is the
 * ACTUAL guarantee (`lastlight-facts all … || <write a fallback envelope>`).
 * Without that catch a dead process fails the run, the run records nothing, and
 * `cron-review.yaml` re-dispatches it every thirty minutes forever — the
 * 1260-execution / $1.30-an-hour shape.
 *
 * Reachable in production two ways: raising `--max-files` past what the heap can
 * hold, and any segfault in the `@ast-grep/napi` native binary. Reproduced here
 * by capping the heap instead, which is the same event from the process's point
 * of view and does not depend on how much memory the CI box happens to have.
 *
 * FLAKE RATE: 20/20 SIGABRT with no envelope, measured on darwin-arm64,
 * node 22. Not skipped by default.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMonorepoFixture, type Fixture } from "./helpers.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
/** A fresh checkout has no `dist/`, and a red suite there teaches nobody anything. */
const BUILT = existsSync(CLI);

let fixture: Fixture;
let outDir: string;

beforeAll(() => {
  if (!BUILT) return;
  fixture = makeMonorepoFixture();
  outDir = mkdtempSync(join(tmpdir(), "ll-facts-oom-"));
});

afterAll(() => {
  fixture?.cleanup();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function runFacts(nodeArgs: string[], out: string) {
  return spawnSync(
    process.execPath,
    [
      ...nodeArgs,
      CLI,
      "all",
      "--repo",
      fixture.dir,
      "--base",
      fixture.base,
      "--head",
      fixture.head,
      "--out",
      out,
      "--never-fail",
    ],
    { encoding: "utf8" },
  );
}

describe("--never-fail covers thrown errors, NOT a dead process", () => {
  it.skipIf(!BUILT)("an OOM exits non-zero and writes NO envelope", () => {
    const out = join(outDir, "oom.json");
    const result = runFacts(["--max-old-space-size=32"], out);

    // `status` is null when the child died on a signal, which is itself
    // non-zero-ish; assert both halves rather than a magic 134, because the
    // number a shell reports (128 + SIGABRT) is platform arithmetic and the
    // CONTRACT is "the run did not succeed".
    expect(result.status === 0).toBe(false);
    expect(result.status !== null || result.signal !== null).toBe(true);

    // The load-bearing half. `--never-fail` promised an envelope and there is
    // no file at all — nothing downstream can distinguish this from a phase
    // that never ran, which is why the CALLER must own the fallback.
    expect(existsSync(out)).toBe(false);
  });

  /**
   * The contrast, and it is not decoration: without it this file would pass on
   * a `dist/cli.js` that was broken for any reason whatsoever.
   */
  it.skipIf(!BUILT)("…while the SAME command on a normal heap writes one and exits 0", () => {
    const out = join(outDir, "ok.json");
    const result = runFacts([], out);
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});
