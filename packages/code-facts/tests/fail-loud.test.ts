/**
 * The fail-loud contract, and §D12's correction to it.
 *
 * TWO PROPERTIES, and they pull in opposite directions:
 *
 *  1. **An empty result and an unavailable analyser must never be
 *     indistinguishable** (locked decision 6). This is the dependency-cruiser
 *     failure with money on it.
 *  2. **No analysis phase may fail the run** (§D12). `cron-review.yaml`
 *     re-dispatches every thirty minutes and `assessedHeadShaByWorkflow` is
 *     populated from SUCCEEDED runs only, so a phase that exits non-zero fails
 *     the run, records nothing, and is retried forever — at 2–3x the cost of
 *     the 1260-execution / $1.30-an-hour incident `pr-decisions.ts` documents.
 *
 * The resolution is that the ENVELOPE carries the loudness and the EXIT CODE
 * does not. These tests are the gate on both halves; without them the wrapper
 * is a one-line change away from silently reintroducing the spend loop.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrokenTsConfigFixture, makeConstantFixture, makeNonTsFixture } from "./helpers.js";
import { runExtractor, runWrapped } from "../src/run.js";
import { runCli } from "../src/cli.js";
import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE, FactsError } from "../src/errors.js";
import type { AllDocument, FactsDocument } from "../src/schema.js";

describe("exit codes — the contract a human or a test reads", () => {
  it("exits 2 with a NAMED reason when the analysis cannot run at all", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ll-facts-notrepo-"));
    try {
      expect(() =>
        runExtractor({ extractor: "facts", repo: notARepo, base: "HEAD~1", head: "HEAD" }),
      ).toThrow(FactsError);
      try {
        runExtractor({ extractor: "facts", repo: notARepo, base: "HEAD~1", head: "HEAD" });
      } catch (err) {
        expect((err as FactsError).exitCode).toBe(EXIT_UNAVAILABLE);
        expect((err as FactsError).message).toMatch(/not a git repository/);
      }
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("exits 3, not 0, on a repo whose project will not load", () => {
    const broken = makeBrokenTsConfigFixture();
    try {
      const result = runExtractor({
        extractor: "facts",
        repo: broken.dir,
        base: broken.base,
        head: broken.head,
      });
      const document = result.document as unknown as FactsDocument;
      expect(result.exitCode).toBe(EXIT_DEGRADED);
      expect(document.coverage).toBe("degraded");
      expect(document.tier).toBe(2);
      // AC2: it never exits 0 with an empty symbol list. Tier 2 now PRODUCES a
      // symbol list — the syntactic engine matches names without a compiler —
      // so the assertion that carries AC2 is no longer "the list is empty". It
      // is that the list says what it is: every symbol here is a hypothesis,
      // and a consumer must be able to tell that from the document alone.
      expect(document.symbols.length).toBeGreaterThan(0);
      expect(document.symbols.every((s) => s.resolution === "name-match")).toBe(true);
      expect(document.symbols.every((s) => s.nameAmbiguity !== null)).toBe(true);
      // …and an implementations query is a TYPE query, so it stays `null` here
      // rather than becoming an "this interface has no implementers" claim.
      expect(document.symbols.every((s) => s.implementations === null)).toBe(true);
      expect(document.degraded.length).toBeGreaterThan(0);
      expect(document.degraded.some((d) => /NAME MATCHING/.test(d.reason))).toBe(true);
    } finally {
      broken.cleanup();
    }
  });

  it("exits 3 with a tier-3 reason on a repo with no TypeScript at all", () => {
    const nonTs = makeNonTsFixture();
    try {
      const result = runExtractor({
        extractor: "facts",
        repo: nonTs.dir,
        base: nonTs.base,
        head: nonTs.head,
      });
      const document = result.document as unknown as FactsDocument;
      expect(result.exitCode).toBe(EXIT_DEGRADED);
      expect(document.tier).toBe(3);
      expect(document.degraded.some((d) => /tier 3/.test(d.reason))).toBe(true);
    } finally {
      nonTs.cleanup();
    }
  });

  it("exits 0 only when the result is genuinely trustworthy", () => {
    const fixture = makeConstantFixture();
    try {
      const result = runExtractor({
        extractor: "facts",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      });
      expect(result.exitCode).toBe(EXIT_OK);
      expect((result.document as unknown as FactsDocument).coverage).toBe("full");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("§D12 — the phase wrapper never fails the run", () => {
  it("turns an unanalysable repo into a well-formed `coverage: \"none\"` envelope", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ll-facts-notrepo-"));
    try {
      const result = runWrapped({
        extractor: "facts",
        repo: notARepo,
        base: "HEAD~1",
        head: "HEAD",
      });
      const document = result.document as unknown as FactsDocument;

      expect(document.coverage).toBe("none");
      expect(document.degraded).toHaveLength(1);
      expect(document.degraded[0].reason).toMatch(/analysis could not run/);
      expect(document.degraded[0].reason).toMatch(/it is not a clean result/);
      // Still a valid document — a consumer needs no second code path.
      expect(document.version).toBe(2);
      expect(document.symbols).toEqual([]);
      // `2` since `source` became per-platform `sources` — the manifest schema
      // version, pinned as a literal on purpose so a change to the shape has to
      // be a deliberate edit here rather than something the stamp follows
      // silently. It is also what the eval preflight compares against.
      expect(document.toolchain.manifest).toBe(2);
      // The envelope now says which parser ran, and on a repo that is not a git
      // repo at all the only honest answer is "none, and no languages seen".
      expect(document.engine).toBe("none");
      expect(document.languages).toEqual([]);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("writes `coverage: \"none\"` for EVERY extractor, `all` included", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ll-facts-notrepo-"));
    try {
      for (const extractor of ["facts", "contracts", "constants", "deps", "patterns", "coverage"] as const) {
        const document = runWrapped({
          extractor,
          repo: notARepo,
          base: "HEAD~1",
          head: "HEAD",
        }).document as unknown as { coverage: string; degraded: unknown[] };
        expect(document.coverage, extractor).toBe("none");
        expect(document.degraded.length, extractor).toBe(1);
      }
      const all = runWrapped({ extractor: "all", repo: notARepo, base: "HEAD~1", head: "HEAD" })
        .document as unknown as AllDocument;
      expect(all.coverage).toBe("none");
      expect(all.extractors).toEqual({});
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  /**
   * THE ONE THAT KEEPS THE 30-MINUTE LOOP SHUT. `--never-fail` must return 0
   * even when nothing could be analysed, because a non-zero exit fails the
   * phase, which fails the run, which records no assessed SHA, which
   * re-dispatches the PR in thirty minutes — forever.
   */
  it("`--never-fail` returns exit 0 on a repo that cannot be analysed", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ll-facts-notrepo-"));
    const out: string[] = [];
    try {
      const code = runCli(
        ["facts", "--repo", notARepo, "--base", "HEAD~1", "--head", "HEAD", "--never-fail"],
        { out: (s) => out.push(s), err: (s) => out.push(s) },
      );
      expect(code).toBe(0);
      const document = JSON.parse(out.join("\n")) as FactsDocument;
      expect(document.coverage).toBe("none");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("WITHOUT `--never-fail` the same invocation exits 2 — the human-facing signal", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ll-facts-notrepo-"));
    try {
      expect(() =>
        runCli(["facts", "--repo", notARepo, "--base", "HEAD~1", "--head", "HEAD"], {
          out: () => {},
          err: () => {},
        }),
      ).toThrow(FactsError);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("`--never-fail` still returns 0 on a merely DEGRADED run, and keeps the reasons", () => {
    const nonTs = makeNonTsFixture();
    const out: string[] = [];
    try {
      const code = runCli(
        ["facts", "--repo", nonTs.dir, "--base", nonTs.base, "--head", nonTs.head, "--never-fail"],
        { out: (s) => out.push(s), err: (s) => out.push(s) },
      );
      expect(code).toBe(0);
      const document = JSON.parse(out.join("\n")) as FactsDocument;
      expect(document.coverage).toBe("degraded");
      expect(document.degraded.length).toBeGreaterThan(0);
    } finally {
      nonTs.cleanup();
    }
  });
});
