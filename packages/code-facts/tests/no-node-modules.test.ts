/**
 * WP1 acceptance criterion 3 — `node_modules` in the target repo is neither
 * required nor consulted for `facts` / `contracts` / `constants`.
 *
 * This is not a theoretical property. The review workspace HAS NO
 * `node_modules` (00-evidence §3: that is why "open the library source" was
 * structurally impossible), and `pr-review` runs against exactly that tree. An
 * extractor that quietly needed an install would work on every developer
 * machine and produce nothing in production.
 *
 * WP1 says to verify it "by a test that deletes it", so that is literally what
 * this does.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeConstantFixture, makeContractFixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { withWorktree } from "../src/git.js";
import type { ConstantsDocument, ContractsDocument, FactsDocument } from "../src/schema.js";

describe("no node_modules in the target repo (WP1 AC3)", () => {
  it("produces the same facts with node_modules present and deleted", () => {
    const fixture = makeConstantFixture();
    try {
      // Present, and full of something that must never be read.
      const modules = join(fixture.dir, "node_modules", "some-package");
      mkdirSync(modules, { recursive: true });
      writeFileSync(join(modules, "index.js"), "module.exports = 1;\n", "utf8");

      const withModules = runExtractor({
        extractor: "facts",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      }).document as unknown as FactsDocument;

      rmSync(join(fixture.dir, "node_modules"), { recursive: true, force: true });
      expect(existsSync(join(fixture.dir, "node_modules"))).toBe(false);

      const without = runExtractor({
        extractor: "facts",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      }).document as unknown as FactsDocument;

      expect(without.coverage).toBe("full");
      expect(without.symbols).toEqual(withModules.symbols);
      expect(without.symbols.find((s) => s.name === "MAX_TOKEN_AGE")?.referenceCount).toBeGreaterThan(
        0,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("computes the contract delta and the constant subtraction with no install", () => {
    const contract = makeContractFixture();
    const constant = makeConstantFixture();
    try {
      expect(existsSync(join(contract.dir, "node_modules"))).toBe(false);

      const contracts = runExtractor({
        extractor: "contracts",
        repo: contract.dir,
        base: contract.base,
        head: contract.head,
      }).document as unknown as ContractsDocument;
      expect(contracts.coverage).toBe("full");
      expect(contracts.contracts.find((c) => c.symbol === "getUser")?.after?.returns).toBe("User");

      const constants = runExtractor({
        extractor: "constants",
        repo: constant.dir,
        base: constant.base,
        head: constant.head,
      }).document as unknown as ConstantsDocument;
      expect(constants.coverage).toBe("full");
      expect(
        constants.constants.find((c) => c.constant === "MAX_TOKEN_AGE")?.hardCodedDuplicates,
      ).toEqual(["src/legacy/auth.ts:2"]);
    } finally {
      contract.cleanup();
      constant.cleanup();
    }
  });

  /**
   * The other half of the same property: nothing REQUIRES an install, but when
   * the head tree has one, the base worktree must see the same modules —
   * because a comparison between a resolved program and an unresolved one is
   * not a comparison.
   *
   * Measured on this monorepo's own WP0 commit: without the mirror every export
   * whose type touched an unresolvable external read as changed, and
   * `contracts` reported 227 deltas where 1 was real.
   */
  it("mirrors the head tree's node_modules into the base worktree", () => {
    const fixture = makeContractFixture();
    try {
      const modules = join(fixture.dir, "node_modules", "marker-pkg");
      mkdirSync(modules, { recursive: true });
      writeFileSync(join(modules, "package.json"), JSON.stringify({ name: "marker-pkg" }), "utf8");

      let seen: string[] = [];
      withWorktree(fixture.dir, fixture.base, (dir) => {
        seen = existsSync(join(dir, "node_modules"))
          ? readdirSync(join(dir, "node_modules"))
          : [];
      });
      expect(seen).toContain("marker-pkg");
    } finally {
      fixture.cleanup();
    }
  });
});
