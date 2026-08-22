/**
 * WP1 acceptance criterion 4 — the TS 7 landmine, pinned.
 *
 * **TypeScript 7 has no programmatic compiler API.** `tsgo` is CLI + LSP only.
 * `ts-morph@28` vendors its own compiler and carries no `typescript`
 * dependency, so a toolchain that resolved the target repo's TypeScript would
 * break on every TS-7 repo — which is now most of them.
 *
 * The rule is therefore: NEVER resolve `typescript` from the repo under review.
 * A rule stated in a comment is a rule that lasts until the next refactor, so
 * this file is the gate — modelled on `apps/server/tests/state/driver-isolation.test.ts`,
 * which pins an equivalent invariant for the Postgres drivers.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilerInfo } from "../src/project.js";
import { makeConstantFixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import type { FactsDocument } from "../src/schema.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Comments are stripped before matching, exactly as
 * `scripts/lint-import-boundaries.mjs` does — a doc comment that NAMES the
 * forbidden shape (`project.ts` does, deliberately) is prose, and a gate that
 * cries wolf on prose gets switched off.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("compiler isolation (WP1 AC4)", () => {
  it("no module under src/ resolves or imports `typescript`", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = stripComments(readFileSync(file, "utf8"));
      // Any form of reaching for the compiler by name. `ts-morph` re-exports
      // its own `ts` namespace, which is the ONLY sanctioned route.
      const patterns = [
        /require\.resolve\(\s*["']typescript["']/,
        /from\s+["']typescript["']/,
        /import\(\s*["']typescript["']/,
        /require\(\s*["']typescript["']/,
        // The specific shape WP1 names as a bug.
        /resolve\([^)]*paths\s*:\s*\[\s*repo/,
      ];
      for (const pattern of patterns) {
        if (pattern.test(source)) offenders.push(`${file.slice(SRC.length + 1)} → ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the compiler in use lives in THIS package's dependency tree, not the target repo's", () => {
    const { modulePath, version } = compilerInfo();
    expect(version).toMatch(/^\d+\.\d+/);
    expect(modulePath).toMatch(/@ts-morph[/+]common/);
    // Never anywhere under a repo being analysed. The fixture below proves the
    // dynamic half; this proves the static one.
    expect(modulePath.startsWith("/tmp/")).toBe(false);
    expect(modulePath.startsWith("/var/folders/")).toBe(false);
  });

  it("ignores a `typescript` installed in the repo under review", () => {
    const fixture = makeConstantFixture();
    try {
      // A decoy: a different compiler, in the place a naive resolver would look.
      const decoy = join(fixture.dir, "node_modules", "typescript");
      mkdirSync(decoy, { recursive: true });
      writeFileSync(
        join(decoy, "package.json"),
        JSON.stringify({ name: "typescript", version: "0.0.0-decoy", main: "index.js" }),
        "utf8",
      );
      writeFileSync(join(decoy, "index.js"), `throw new Error("the decoy compiler was loaded");`);

      const before = compilerInfo();
      const result = runExtractor({
        extractor: "facts",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      });
      const after = compilerInfo();

      // Same compiler before and after, and it is not the decoy.
      expect(after).toEqual(before);
      expect(after.version).not.toBe("0.0.0-decoy");
      expect(after.modulePath.startsWith(fixture.dir)).toBe(false);
      // And the analysis still worked, which is the point of vendoring it.
      expect((result.document as unknown as FactsDocument).symbols.length).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  /**
   * REWRITTEN 2026-08-22 (`docs/plans/fact-engine/`), and the inversion is the
   * point.
   *
   * This case used to assert `dependencies` does NOT contain `typescript`. That
   * was a proxy for the real invariant — *the compiler must not come from the
   * repo under review* — and the proxy held only while ts-morph vendored its
   * own compiler. `tsgo` IS `typescript`, so the package must now ship it, and
   * keeping the old assertion would have forced the engine into a devDependency
   * that is absent for every npm consumer: `ERR_MODULE_NOT_FOUND` at runtime,
   * for a package whose entire purpose is to not fail silently.
   *
   * The invariant itself is unchanged and is enforced by the three cases above,
   * structurally: `compilerInfo().modulePath` must not sit inside the fixture
   * repo, even when that repo pins a decoy `typescript`. What this case adds is
   * the other half — the shipped pin must be EXACT. A range would let a
   * consumer's install float the compiler underneath us, and a different
   * compiler is a different type printer, which is the phantom-delta class
   * (`01b-code-facts-hardening.md`, bug 1 and bug 2).
   */
  it("ships `typescript` as an EXACT-pinned runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pinned = pkg.dependencies?.typescript;
    expect(pinned).toBeDefined();
    // No `^`, `~`, `>=`, `*` or `x` — a bare version and nothing else.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    // And it must not ALSO be a devDependency, where a range would shadow the
    // pin in this workspace and hide a drift that only bites npm consumers.
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("typescript");
  });
});
