/**
 * `--never-fail` does NOT cover a dead process — and the decision about what is
 * still provable, recorded rather than quietly dropped.
 *
 * `CLAUDE.md` states it in a table, and a table is not a guard. The wrapper is
 * an in-process `try`/`catch` (`runWrapped`), so it covers every failure that
 * RAISES — a missing binary, an unparseable tsconfig, a directory that is not a
 * git repo — and it cannot cover a process that dies:
 *
 *   not a git repo, --never-fail  → exit 0,   coverage:"none" envelope   ✓
 *   the process dies,        "    → non-zero, NO envelope                ✗
 *
 * The first line is `tests/fail-loud.test.ts`. This file is the second, and its
 * whole purpose is to stop someone "fixing" the hole into a false guarantee: a
 * `process.on("uncaughtException")` in this package would make the table read as
 * if the envelope were always written, and the workflow phase would drop the
 * shell-level catch that is the ACTUAL guarantee
 * (`lastlight-facts all … || <write a fallback envelope>`). Without that catch a
 * dead process fails the run, the run records nothing, and `cron-review.yaml`
 * re-dispatches it every thirty minutes forever — the 1260-execution /
 * $1.30-an-hour shape.
 *
 * ══ THE DECISION, RECORDED 2026-08-22 (`docs/plans/fact-engine/`) ═══════════
 *
 * **1. The old reproduction is dead, and that is a real improvement.**
 * This file used to force the hole with `--max-old-space-size=32`: the heap
 * could not hold a ts-morph program, node aborted, and no envelope was written
 * (20/20 SIGABRT, measured). The compiler is a Go CHILD PROCESS now and its
 * ~600 MB lives entirely outside V8, so the SAME command under a 32 MB heap
 * completes and writes a valid envelope — measured here, and asserted below so
 * that nobody re-derives the old table from the old test.
 *
 * **2. The hole itself is NOT dead.** Re-measured rather than assumed.
 * `typescript@7.0.2`'s `dist/api/syncChannel.js` calls `spawn()` at `:99` and
 * `:126` and attaches **no `'error'` listener**. An executable that passes the
 * pre-flight and then cannot be exec'd produces, in this order:
 *
 *     1. a CATCHABLE `EPIPE: broken pipe, write` out of `updateSnapshot` —
 *        which the wrapper duly catches and starts turning into an envelope;
 *     2. an UNHANDLED `'error'` (`spawn … ENOENT` / `EACCES`) on the next tick,
 *        which kills the process before that envelope is written.
 *
 * That ordering is what makes it worse than a plain crash: the in-process catch
 * sees something and believes it handled it. Reachable in production through
 * `$LASTLIGHT_TSGO_BIN` pointed at a wrapper script whose interpreter is not in
 * the image, or a wrong-architecture binary — and separately through any
 * segfault in the `@ast-grep/napi` native binary, which kills V8 before any
 * `catch` whatever the compiler is doing.
 *
 * **3. It is NOT executable as a test, and that is the recorded decision.**
 * Driving it end to end (spawn `dist/cli.js` with `$LASTLIGHT_TSGO_BIN` set to
 * a `#!/nonexistent/interpreter` script) was built and measured: the child does
 * not die cleanly, it **WEDGES** — `spawnSync` had not returned after 50 s with
 * a 60 s timeout set, with the trace stopping after the EPIPE. A test that
 * hangs the suite for a minute is not a guard; a test that hangs it and then
 * asserts nothing is worse than the prose it replaced. So the shape is written
 * down here with its measurement, the CATCHABLE half is pinned below, and the
 * uncatchable half stays a documented hole.
 *
 * **A hang is worse than a crash for a workflow phase** — it burns the phase's
 * wall-clock budget and then fails anyway — so this is reported as a live
 * defect rather than a curiosity.
 *
 * **4. What DID get narrowed.** `resolveTsgoBinary` refuses a path that does
 * not exist, is not a regular FILE, or has no execute bit, with a named
 * `TsgoError` (a directory passes a bare `X_OK` — that bit means "traversable"
 * — which is why the `isFile()` half exists); and `openSnapshot` wraps
 * `new API()` so that the SYNCHRONOUS `spawn ENOEXEC` a malformed binary
 * produces is catchable too. Both are pinned below. Neither closes the hole.
 * **The §D12 shell-level catch stays mandatory.**
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMonorepoFixture, type Fixture } from "./helpers.js";
import { resolveTsgoBinary, TsgoError } from "../src/tsgo.js";

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

describe("the memory shape changed — the old reproduction is gone", () => {
  /**
   * The assertion that replaces *"an OOM exits non-zero and writes NO
   * envelope"*. It is the same command, the same fixture and the same heap cap;
   * only the answer moved, because the compiler moved out of V8.
   */
  it.skipIf(!BUILT)("a 32 MB heap is no longer fatal — the compiler is not in V8 any more", () => {
    const out = join(outDir, "small-heap.json");
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=32",
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
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  /**
   * The contrast, and it is not decoration: without it the case above would
   * pass on a `dist/cli.js` that was broken for any reason whatsoever.
   */
  it.skipIf(!BUILT)("…and so is the ordinary run, which is what makes that meaningful", () => {
    const out = join(outDir, "ok.json");
    const result = spawnSync(
      process.execPath,
      [
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
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});

/**
 * THE PRE-FLIGHT — the half of the hole that IS catchable, and therefore the
 * half that can be a guard.
 *
 * Every case here would otherwise reach `spawn()` inside `syncChannel.js`,
 * where there is no `'error'` listener. Refusing them here converts a process
 * death (or a wedge) into a named `TsgoError` that `--never-fail` turns into an
 * envelope. It is a narrowing of the hole described in this file's header, not
 * a closing of it.
 */
describe("resolveTsgoBinary refuses what it can, LOUDLY", () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "ll-facts-bin-"));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("refuses a path that does not exist", () => {
    expect(() => resolveTsgoBinary(join(scratch, "nope"))).toThrowError(TsgoError);
    expect(() => resolveTsgoBinary(join(scratch, "nope"))).toThrowError(/does not exist/);
  });

  it("refuses a DIRECTORY — `access(dir, X_OK)` says yes and `spawn` says EACCES", () => {
    // The trap `isFile()` exists for: the execute bit on a directory means
    // "traversable", so a bare `X_OK` pre-flight waves this through and the
    // failure lands on the next tick as an unhandled `'error'`.
    const dir = join(scratch, "dirbin");
    mkdirSync(dir, { recursive: true });
    expect(() => resolveTsgoBinary(dir)).toThrowError(/not executable/);
  });

  it("refuses a file with no execute bit", () => {
    const plain = join(scratch, "plain");
    writeFileSync(plain, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(plain, 0o644);
    expect(() => resolveTsgoBinary(plain)).toThrowError(/not executable/);
  });

  /**
   * And the boundary, so the three refusals above are not just "it always
   * throws": a real regular file with the execute bit is ACCEPTED and handed
   * straight back as `tsserverPath`, so the path this module checked is the
   * path that gets spawned.
   *
   * This is also exactly where the hole begins. Nothing cheap distinguishes
   * this file from one whose interpreter is missing or whose architecture is
   * wrong, and those are the cases the header describes.
   */
  it("accepts a regular executable file — which is where the checks run out", () => {
    const ok = join(scratch, "tsgo");
    writeFileSync(ok, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(ok, 0o755);
    expect(resolveTsgoBinary(ok)).toBe(ok);
  });

  it("falls back to the BUNDLED platform binary rather than to PATH", () => {
    // No `PATH` step, deliberately: a `tsgo` on `PATH` is an arbitrary version,
    // and the point of resolving from here is that the compiler is the one this
    // package's lockfile pinned.
    const resolved = resolveTsgoBinary();
    expect(resolved).toMatch(new RegExp(`typescript-${process.platform}-${process.arch}`));
  });
});
