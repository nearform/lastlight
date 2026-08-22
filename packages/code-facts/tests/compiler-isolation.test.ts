/**
 * WP1 acceptance criterion 4 — the TS 7 landmine, pinned.
 *
 * The premise that made the rule expired and the RULE did not. `ts-morph@28`
 * vendored its own compiler and carried no `typescript` dependency; this package
 * now ships `typescript@7.0.2` itself and spawns its Go compiler. So the old
 * proxy — *"`typescript` must not be a dependency"* — is dead, and the invariant
 * it stood for is unchanged and sharper:
 *
 *   **NEVER resolve `typescript` from the repo under review, and the copy that
 *   DOES resolve must be the exact-pinned one in this package's own tree.**
 *
 * Both halves matter. A toolchain that resolved the target repo's TypeScript
 * breaks on every repo whose own compiler is a different major; a toolchain
 * whose compiler can float breaks something quieter — a different compiler is a
 * different TYPE PRINTER, and `contracts` compares type text, which is the
 * phantom-delta class (`01b-code-facts-hardening.md`, bugs 1 and 2).
 *
 * A rule stated in a comment is a rule that lasts until the next refactor, so
 * this file is the gate — modelled on
 * `apps/server/tests/state/driver-isolation.test.ts`, which pins an equivalent
 * invariant for the Postgres drivers.
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
      // Any form of reaching for the compiler by NAME from a caller-supplied
      // path. The sanctioned route is a bare `typescript/unstable/*` subpath
      // import, which node resolves from this module's own tree; the shapes
      // below are the ones that can be pointed somewhere else.
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
    const { modulePath, version, platformPackage, executable } = compilerInfo();
    expect(version).toMatch(/^\d+\.\d+/);
    expect(modulePath).toMatch(/node_modules[/\\]typescript[/\\]package\.json$/);
    // Never anywhere under a repo being analysed. The fixture below proves the
    // dynamic half; this proves the static one.
    expect(modulePath.startsWith("/tmp/")).toBe(false);
    expect(modulePath.startsWith("/var/folders/")).toBe(false);

    // STRENGTHENED: the copy that resolved must be the one this package PINNED.
    // `version` alone would pass on a hoisted stranger of the same version.
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(version).toBe(pkg.dependencies?.typescript);
    const installed = JSON.parse(readFileSync(modulePath, "utf8")) as { version?: string };
    expect(installed.version).toBe(version);

    // …and the thing that is actually SPAWNED is the platform sidecar under
    // that same package, not a `tsgo` on PATH. `resolveTsgoBinary` has no PATH
    // step on purpose: a `tsgo` on PATH is an arbitrary version.
    expect(platformPackage).toMatch(
      new RegExp(`typescript-${process.platform}-${process.arch}$`),
    );
    expect(executable).toMatch(/[/\\](?:tsc|tsgo)(?:\.exe)?$/);
    expect(executable?.startsWith(platformPackage as string)).toBe(true);
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

      // A second decoy, in the place `getExePath()` would look if it consulted
      // `cwd` — VERIFIED that it does not (it resolves against the installed
      // package's own `__dirname`), and asserted anyway, because that is what
      // this file is for.
      const decoyPlatform = join(
        fixture.dir,
        "node_modules",
        "@typescript",
        `typescript-${process.platform}-${process.arch}`,
        "lib",
      );
      mkdirSync(decoyPlatform, { recursive: true });
      writeFileSync(join(decoyPlatform, "tsgo"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });

      const before = compilerInfo();
      const result = runExtractor({
        extractor: "facts",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      });
      const after = compilerInfo();

      // Same compiler before and after, and it is not either decoy.
      expect(after).toEqual(before);
      expect(after.version).not.toBe("0.0.0-decoy");
      expect(after.modulePath.startsWith(fixture.dir)).toBe(false);
      expect(after.platformPackage?.startsWith(fixture.dir)).toBe(false);
      expect(after.executable?.startsWith(fixture.dir)).toBe(false);
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
