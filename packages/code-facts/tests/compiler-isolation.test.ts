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

  it("declares no `typescript` runtime dependency of its own", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("typescript");
  });
});
