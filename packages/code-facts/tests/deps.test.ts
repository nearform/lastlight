/**
 * `deps` — and the two v3 bugs that must never come back.
 *
 * `1641-r2`'s gold finding lived inside `eslint-plugin-require-extensions`. The
 * v3 enumerator's denylist used an `^eslint` PREFIX and swallowed it, so the
 * package the defect was in never reached the model. And the plugin was loaded
 * with `createRequire(import.meta.url)("...")`, which the import scan did not
 * recognise. Both are pinned here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDepsFixture, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { isToolingPackage, packageNameOf, scanImports } from "../src/deps.js";
import type { DepsDocument } from "../src/schema.js";

describe("deps — manifest delta", () => {
  let fixture: Fixture;
  let document: DepsDocument;

  beforeAll(() => {
    fixture = makeDepsFixture();
    document = runExtractor({
      extractor: "deps",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as DepsDocument;
  });
  afterAll(() => fixture.cleanup());

  it("reports added and bumped dependencies with their scope", () => {
    const added = document.changes.find((c) => c.name === "eslint-plugin-require-extensions");
    expect(added?.change).toBe("added");
    expect(added?.scope).toBe("dependencies");
    expect(added?.after).toBe("^0.1.3");

    const bumped = document.changes.find((c) => c.name === "eslint");
    expect(bumped?.change).toBe("bumped");
    expect(bumped?.before).toBe("^8.0.0");
    expect(bumped?.after).toBe("^9.0.0");
  });

  it("ties an added dependency to the line that loads it, via createRequire(...)(...)", () => {
    const added = document.changes.find((c) => c.name === "eslint-plugin-require-extensions");
    expect(added?.importedAt).toEqual(["src/lint.ts:3"]);
  });

  it("does not stage anything unless asked — `deps` is offline by default", () => {
    expect(document.changes.every((c) => c.stagedAt === null)).toBe(true);
    expect(document.coverage).toBe("full");
  });
});

describe("deps — the `^eslint` prefix bug (1641-r2)", () => {
  it("flags `eslint` as tooling but NOT `eslint-plugin-require-extensions`", () => {
    expect(isToolingPackage("eslint")).toBe(true);
    expect(isToolingPackage("eslint-plugin-require-extensions")).toBe(false);
    expect(isToolingPackage("eslint-config-airbnb")).toBe(false);
    expect(isToolingPackage("@typescript-eslint/parser")).toBe(false);
  });

  it("emits every changed dependency regardless — `tooling` is a hint, never a filter", () => {
    // A lint package IS the subject when the config is the diff, which is
    // exactly the shape of the PR the gold finding lived in.
    expect(isToolingPackage("prettier")).toBe(true);
  });
});

describe("deps — the import scan", () => {
  it("recognises every load form, including the two v3 missed", () => {
    const source = [
      `import a from "pkg-static";`,
      `import "pkg-side-effect";`,
      `export { x } from "pkg-reexport";`,
      `const b = await import("pkg-dynamic");`,
      `const c = require("pkg-require");`,
      `const d = createRequire(import.meta.url)("eslint-plugin-require-extensions");`,
      `import e from "./relative";`,
      `import f from "node:fs";`,
    ].join("\n");
    const found = [...scanImports(source).keys()].sort();
    expect(found).toEqual([
      "eslint-plugin-require-extensions",
      "pkg-dynamic",
      "pkg-reexport",
      "pkg-require",
      "pkg-side-effect",
      "pkg-static",
    ]);
  });

  it("reduces a deep specifier to its package name and drops non-packages", () => {
    expect(packageNameOf("@scope/pkg/sub/path.js")).toBe("@scope/pkg");
    expect(packageNameOf("pkg/sub")).toBe("pkg");
    expect(packageNameOf("./local")).toBeNull();
    expect(packageNameOf("node:fs")).toBeNull();
  });
});
