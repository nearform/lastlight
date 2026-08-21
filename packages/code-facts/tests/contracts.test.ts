/**
 * `contracts` — the base-vs-head semantic delta.
 *
 * `getUser(): User | null` becoming `getUser(): User` plus a thrown
 * `NotFoundError` is the regression class this extractor exists for, and
 * `consumersOutsideDiff` is what turns it from a curiosity into an obligation:
 * those are the call sites the PR did not touch and the reviewer will not see.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeContractFixture, makeConstantFixture, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { canonicalType, extractContracts } from "../src/contracts.js";
import { Project } from "ts-morph";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContractsDocument } from "../src/schema.js";

describe("contracts — the semantic delta", () => {
  let fixture: Fixture;
  let document: ContractsDocument;

  beforeAll(() => {
    fixture = makeContractFixture();
    document = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ContractsDocument;
  });
  afterAll(() => fixture.cleanup());

  it("reports the nullability change and the newly thrown type", () => {
    const delta = document.contracts.find((c) => c.symbol === "getUser");
    expect(delta?.change).toBe("changed");
    expect(delta?.before?.returns).toBe("User | null");
    expect(delta?.before?.nullableReturn).toBe(true);
    expect(delta?.after?.returns).toBe("User");
    expect(delta?.after?.nullableReturn).toBe(false);
    expect(delta?.after?.throws).toEqual(["NotFoundError"]);
  });

  it("names the consumers OUTSIDE the diff — the ones that silently rot", () => {
    const delta = document.contracts.find((c) => c.symbol === "getUser");
    expect(delta?.consumersOutsideDiff).toContain("src/api/handler.ts:4");
    expect(delta?.consumersOutsideDiff.some((c) => c.includes("(test)"))).toBe(true);
  });

  it("reports an added export as `added` with no `before`", () => {
    const added = document.contracts.find((c) => c.symbol === "NotFoundError");
    expect(added?.change).toBe("added");
    expect(added?.before).toBeNull();
  });

  it("does not emit a delta for an unchanged export", () => {
    // `User` is declared in the changed file but its shape did not move.
    expect(document.contracts.map((c) => c.symbol)).not.toContain("User");
  });

  /**
   * WP1 is explicit: build the base tree with `git worktree add`, do NOT mutate
   * the agent's working tree. The review workspace is reused across runs and
   * the agent reads it concurrently, so a `git checkout` here would be a race
   * that presents as the reviewer quoting the wrong version of a file.
   */
  it("leaves the working tree and the worktree list clean", () => {
    const status = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    expect(status.exitCode).toBe(0);
    // No leftover linked worktrees, and HEAD is still where it was.
    const worktrees = join(fixture.dir, ".git", "worktrees");
    expect(!existsSync(worktrees) || readdirSync(worktrees).length === 0).toBe(true);
  });

  /**
   * The one-sided guard. Measured on this monorepo's own WP0 commit: with the
   * head project forced to one tsconfig and the base discovering another, the
   * extractor reported **227 contract deltas of which 4 were real** — 65 of them
   * "removed export" for a file the head program simply did not contain.
   *
   * A phantom removal is not noise, it is a HARMFUL seed: IRIS measured a
   * half-mechanism seed at −3, worse than no seed at all. So a modified file
   * present in only one of the two programs is skipped and RECORDED.
   */
  it("never invents added/removed for a modified file only one program contains", () => {
    const head = new Project({ useInMemoryFileSystem: true });
    head.createSourceFile("/repo/src/user.ts", "export function getUser(): string { return ''; }\n");
    // The base program simply does not contain the file — which is what a
    // tsconfig resolving differently on the two sides produces.
    const base = new Project({ useInMemoryFileSystem: true });

    const result = extractContracts({
      repo: "/repo",
      headProject: head,
      baseProject: base,
      baseDir: "/repo",
      changed: [{ path: "src/user.ts", status: "modified" }],
      hunkIndex: new Map(),
    });

    expect(result.payload.contracts).toEqual([]);
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0].reason).toMatch(/would be phantom/);
    expect(result.degraded[0].reason).toMatch(/base side not analysed/);
  });

  it("still reports a genuinely ADDED file, where one side is legitimately absent", () => {
    const head = new Project({ useInMemoryFileSystem: true });
    head.createSourceFile("/repo/src/new.ts", "export const FRESH = 1;\n");
    const base = new Project({ useInMemoryFileSystem: true });

    const result = extractContracts({
      repo: "/repo",
      headProject: head,
      baseProject: base,
      baseDir: "/repo",
      changed: [{ path: "src/new.ts", status: "added" }],
      hunkIndex: new Map(),
    });

    expect(result.degraded).toEqual([]);
    expect(result.payload.contracts.map((c) => [c.symbol, c.change])).toEqual([["FRESH", "added"]]);
  });

  it("reports a changed file missing from BOTH programs through the project tier, not silently", () => {
    const constant = makeConstantFixture();
    try {
      const result = runExtractor({
        extractor: "contracts",
        repo: constant.dir,
        base: constant.base,
        head: constant.head,
        // Covers `src/config.ts` but NOT `src/legacy/auth.ts`, which the same
        // diff also modified. Both sides now use this tsconfig, so the file is
        // absent from both — and the run must still say so.
        tsConfigPath: writeNarrowTsConfig(constant.dir),
      });
      const document = result.document as unknown as ContractsDocument;
      expect(document.contracts.some((c) => c.file === "src/legacy/auth.ts")).toBe(false);
      expect(document.coverage).toBe("degraded");
      expect(
        document.degraded.some((d) => /not in the compiled project/.test(d.reason)),
        "a changed file nobody analysed must be named",
      ).toBe(true);
    } finally {
      constant.cleanup();
    }
  });
});

/**
 * Type TEXT is not stable between two programs, and every instability produces
 * a contract delta that did not happen.
 */
describe("contracts — canonical type text", () => {
  it("strips the absolute path out of an unnamed type", () => {
    expect(canonicalType('import("/private/var/folders/x/y/src/user").User')).toBe("User");
    expect(canonicalType('Promise<import("/tmp/a/b").Foo | null>')).toBe("Promise<Foo | null>");
  });

  it("treats a reordered union as the same type", () => {
    expect(canonicalType('"fail" | "complete"')).toBe(canonicalType('"complete" | "fail"'));
    expect(canonicalType("A | B | C")).toBe(canonicalType("C | A | B"));
  });

  it("reorders a union nested inside an object member — the case that survived twice", () => {
    const a = '{ retries: number; then: "complete" | "fail"; }';
    const b = '{ retries: number; then: "fail" | "complete"; }';
    expect(canonicalType(a)).toBe(canonicalType(b));
  });

  it("keeps a real difference different, and never reorders parameters", () => {
    expect(canonicalType('"fail" | "complete"')).not.toBe(canonicalType('"fail" | "skipped"'));
    expect(canonicalType("(a: string, b: number) => void")).not.toBe(
      canonicalType("(b: number, a: string) => void"),
    );
  });
});

/** A tsconfig that deliberately covers only part of the changed set. */
function writeNarrowTsConfig(repo: string): string {
  const path = join(repo, "narrow.tsconfig.json");
  writeFileSync(
    path,
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src/config.ts", "src/client/**/*"],
    }),
    "utf8",
  );
  return path;
}
