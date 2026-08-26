/**
 * `engine` + `languages[]` — the envelope fields that make silence legible.
 *
 * WP1's thesis is that **an empty obligation list and an unavailable analyser
 * must never be indistinguishable**. Before this, a Java PR produced an envelope
 * with eight degraded reasons and zero facts — and a *clean* TypeScript run with
 * one degraded reason produced the same SHAPE of document, differing only in
 * prose a consumer would have to read. Now the Java run additionally says
 *
 *     engine: "none", languages: [{ id: "java", changedFiles: 2, parsedFiles: 0, engine: "none" }]
 *
 * which no clean run can ever look like: a language was recognised, files of it
 * changed, and nothing parsed one of them. That is a machine-checkable
 * statement, and this file is what checks it.
 */
import { describe, expect, it } from "vitest";
import {
  makeBrokenTsConfigFixture,
  makeConstantFixture,
  makeGoFixture,
  makeJavaFixture,
  makeRubyFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { isTestPath, languageIdOf } from "../src/project.js";
import type { AllDocument } from "../src/schema.js";

function all(fixture: Fixture): AllDocument {
  return runExtractor({
    extractor: "all",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
    env: { PATH: "" },
  }).document as unknown as AllDocument;
}

describe("the envelope names the engine and every language in the diff", () => {
  it("a Java PR says `engine: none` and NAMES java with zero parsed files", () => {
    const fixture = makeJavaFixture();
    try {
      const document = all(fixture);
      expect(document.tier).toBe(3);
      expect(document.engine).toBe("none");
      const java = document.languages.find((l) => l.id === "java");
      expect(java, "a recognised-but-unanalysed language must APPEAR, not vanish").toBeDefined();
      expect(java?.changedFiles).toBeGreaterThan(0);
      expect(java?.parsedFiles).toBe(0);
      expect(java?.engine).toBe("none");
      // The XML manifest is a changed file too, and it gets its own row rather
      // than being folded into "other".
      expect(document.languages.map((l) => l.id)).toContain("xml");
    } finally {
      fixture.cleanup();
    }
  });

  it("a Go PR is the shape the brief names", () => {
    const fixture = makeGoFixture();
    try {
      const document = all(fixture);
      expect(document.engine).toBe("none");
      expect(document.languages.find((l) => l.id === "go")).toMatchObject({
        parsedFiles: 0,
        engine: "none",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("a healthy TypeScript PR says tsgo, with parsedFiles equal to changedFiles", () => {
    const fixture = makeConstantFixture();
    try {
      const document = all(fixture);
      expect(document.engine).toBe("tsgo");
      const ts = document.languages.find((l) => l.id === "typescript");
      expect(ts?.engine).toBe("tsgo");
      expect(ts?.parsedFiles).toBe(ts?.changedFiles);
      expect(ts?.parsedFiles).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("a tier-2 repo says ast-grep AND counts the files ast-grep really parsed", () => {
    const broken = makeBrokenTsConfigFixture();
    try {
      const document = all(broken);
      expect(document.tier).toBe(2);
      expect(document.engine).toBe("ast-grep");
      const ts = document.languages.find((l) => l.id === "typescript");
      // `parsedFiles` means ONE thing in every tier: this run obtained a syntax
      // tree. On tier 2 that is ast-grep actually parsing, not a declared-
      // parsable count — which is the difference between a true number and a
      // number that would read as success on a file nothing could read.
      expect(ts?.engine).toBe("ast-grep");
      expect(ts?.parsedFiles).toBeGreaterThan(0);
    } finally {
      broken.cleanup();
    }
  });

  /**
   * `.es6` KILLS THE TSGO CHILD — measured on `typescript@7.0.2` in this
   * checkout, and the reason this case changed shape rather than being deleted.
   *
   * Handing tsgo an `.es6` path through `openFiles` panics the Go process
   * (*"ScriptKind must be specified when parsing source file"*) and the panic
   * takes the WHOLE snapshot with it — every project, every other file, and an
   * `Unexpected EOF while reading from child process` on the node side. Probed
   * across all nine analysable extensions: the other eight open cleanly and are
   * held by a program; `.es6` alone throws. The previous engine parsed it.
   *
   * So the extension stays ANALYSABLE and is simply never handed to the
   * compiler (`isCompilerParsable`). What that costs is the type-aware tier for
   * these files; what it buys is a document at all. The payoff the case was
   * written for is unchanged — Discourse's 20 Ember files are still visible and
   * the constant inside one is still found — it just comes from ast-grep now,
   * and the envelope says which.
   */
  it("gives `.es6` to javascript and parses it — 20 Discourse Ember files", () => {
    const fixture = makeRubyFixture();
    try {
      const document = all(fixture);
      const js = document.languages.find((l) => l.id === "javascript");
      expect(js, "`.es6` used to be invisible to the whole package").toBeDefined();
      expect(js?.parsedFiles).toBeGreaterThan(0);
      // NOT tsgo: the compiler cannot be handed this extension at all.
      expect(document.engine).toBe("ast-grep");
      expect(js?.engine).toBe("ast-grep");
      // And it is NAMED — a file the compiler never saw must not read as one it
      // saw and found nothing in.
      expect(
        document.degraded.some((d) => /panics the child process/.test(d.reason)),
        "a whole extension excluded from the compiler must never be silent",
      ).toBe(true);
      // The payoff, unchanged: the constant inside the `.es6` file is reachable.
      const constant = document.extractors.constants?.constants.find(
        (c) => c.constant === "MAX_TOKEN_AGE",
      );
      expect(constant?.value).toBe("900");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("the language table", () => {
  it("maps the extensions the corpus actually contains", () => {
    expect(languageIdOf("src/a.ts")).toBe("typescript");
    expect(languageIdOf("src/a.tsx")).toBe("typescript");
    expect(languageIdOf("src/a.mjs")).toBe("javascript");
    expect(languageIdOf("app/x.es6")).toBe("javascript");
    expect(languageIdOf("src/main/java/A.java")).toBe("java");
    expect(languageIdOf("pkg/a.go")).toBe("go");
    expect(languageIdOf("src/a.py")).toBe("python");
    expect(languageIdOf("app/a.rb")).toBe("ruby");
    expect(languageIdOf("app/a.scss")).toBe("scss");
    expect(languageIdOf("conf/messages.properties")).toBe("properties");
    expect(languageIdOf("app/t.hbs")).toBe("handlebars");
    expect(languageIdOf("app/v.erb")).toBe("erb");
  });

  it("falls back to the bare extension rather than dropping the file", () => {
    // A language nobody thought about still gets a row, which is the whole
    // contract: recognised-but-unanalysed must appear, never vanish.
    expect(languageIdOf("build.zig")).toBe("zig");
    expect(languageIdOf("a/b/Dockerfile")).toBe("(no-extension)");
    expect(languageIdOf(".gitignore")).toBe("(no-extension)");
  });
});

describe("isTestPath is language-aware", () => {
  it("recognises each ecosystem's own convention", () => {
    for (const path of [
      "src/a.test.ts",
      "tests/a.ts",
      "pkg/api/handler_test.go",
      "tests/test_auth.py",
      "src/auth_test.py",
      "services/src/test/java/org/x/AT.java",
      "core/src/main/java/org/x/TokenServiceTest.java",
      "core/src/main/java/org/x/TokenIT.java",
      "spec/models/session_spec.rb",
      "app/models/session_spec.rb",
      "test/session_test.rb",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it("does not call production code a test", () => {
    for (const path of [
      "src/auth.py",
      "pkg/api/handler.go",
      "src/main/java/org/x/TokenService.java",
      "app/models/session.rb",
      "src/latest.ts",
      "src/contest/a.ts",
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});
