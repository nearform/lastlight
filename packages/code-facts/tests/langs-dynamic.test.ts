/**
 * Python, Go and Java — the DYNAMIC grammars (`src/langs/dynamic.ts`) and the
 * tier-2 `facts` they make possible.
 *
 * Every language gets the same small shape, as a real two-commit git repo: a
 * class/struct with methods, a function in ANOTHER file calling one of them, and
 * a test file mentioning it. The head commit changes exactly one method body, so
 * the hunk → enclosing-symbol mapping has one right answer and a wrong one next
 * door.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeFixture, TSCONFIG, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { scanDeclarations, scanImportLines, scanSource } from "../src/syntactic.js";
import {
  descriptorForPath,
  forceGrammarUnavailable,
  grammarStatus,
  preflightLibrary,
  GO_DESCRIPTOR,
  JAVA_DESCRIPTOR,
  PYTHON_DESCRIPTOR,
  supportedKinds,
  interestingKinds,
} from "../src/langs/index.js";
import type { AllDocument, SymbolFact } from "../src/schema.js";
import { createRequire } from "node:module";

function all(fixture: Fixture): AllDocument {
  return runExtractor({
    extractor: "all",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
    env: { PATH: "" },
  }).document as unknown as AllDocument;
}

function symbol(document: AllDocument, name: string): SymbolFact | undefined {
  return document.extractors.facts?.symbols.find((s) => s.name === name);
}

// ── fixtures ────────────────────────────────────────────────────────────────

const PY_SERVICE = (body: string): string => `class TokenService:
    def verify(self, token):
        ${body}

    def _refresh(self):
        return None


def _hidden():
    return 1
`;

function makePythonRepo(): Fixture {
  return makeFixture(
    "dyn-python",
    {
      message: "base",
      files: {
        "app/service.py": PY_SERVICE("return bool(token)"),
        "app/views.py": `from app.service import TokenService


def handle(request):
    return TokenService().verify(request.token)
`,
        "tests/test_service.py": `from app.service import TokenService


def test_verify():
    assert TokenService().verify("x")
`,
      },
    },
    { message: "head", files: { "app/service.py": PY_SERVICE("return bool(token) and len(token) > 8") } },
  );
}

const GO_SERVICE = (body: string): string => `package api

type TokenService struct {
	secret string
}

func (s *TokenService) Verify(token string) bool {
	${body}
}

func (s *TokenService) refresh() {}
`;

function makeGoRepo(): Fixture {
  return makeFixture(
    "dyn-go",
    {
      message: "base",
      files: {
        "go.mod": "module example.com/api\n\ngo 1.22\n",
        "pkg/api/service.go": GO_SERVICE(`return token != ""`),
        "pkg/api/handler.go": `package api

func Handle(s *TokenService, token string) bool {
	return s.Verify(token)
}
`,
        "pkg/api/service_test.go": `package api

func TestVerify(t *testing.T) {
	_ = (&TokenService{}).Verify("x")
}
`,
      },
    },
    { message: "head", files: { "pkg/api/service.go": GO_SERVICE(`return len(token) > 8`) } },
  );
}

const JAVA_SERVICE = (body: string): string => `package org.fixture;

public class TokenService {
    public boolean verify(String token) {
        ${body}
    }

    private void refresh() {}
}
`;

function makeJavaRepo(): Fixture {
  return makeFixture(
    "dyn-java",
    {
      message: "base",
      files: {
        "src/main/java/org/fixture/TokenService.java": JAVA_SERVICE("return token != null;"),
        "src/main/java/org/fixture/Handler.java": `package org.fixture;

public class Handler {
    public boolean handle(TokenService service, String token) {
        return service.verify(token);
    }
}
`,
        "src/test/java/org/fixture/TokenServiceTest.java": `package org.fixture;

public class TokenServiceTest {
    public void testVerify() {
        new TokenService().verify("x");
    }
}
`,
      },
    },
    {
      message: "head",
      files: {
        "src/main/java/org/fixture/TokenService.java": JAVA_SERVICE("return token != null && !token.isBlank();"),
      },
    },
  );
}

// ── the three languages, one shape ──────────────────────────────────────────

const CASES = [
  {
    id: "python",
    make: makePythonRepo,
    method: "TokenService.verify",
    methodFile: "app/service.py",
    sibling: "TokenService._refresh",
    callerFile: "app/views.py",
    callerSymbol: "handle",
    testFile: "tests/test_service.py",
    callee: "len",
  },
  {
    id: "go",
    make: makeGoRepo,
    method: "TokenService.Verify",
    methodFile: "pkg/api/service.go",
    sibling: "TokenService.refresh",
    callerFile: "pkg/api/handler.go",
    callerSymbol: "Handle",
    testFile: "pkg/api/service_test.go",
    callee: "len",
  },
  {
    id: "java",
    make: makeJavaRepo,
    method: "TokenService.verify",
    methodFile: "src/main/java/org/fixture/TokenService.java",
    sibling: "TokenService.refresh",
    callerFile: "src/main/java/org/fixture/Handler.java",
    callerSymbol: "handle",
    testFile: "src/test/java/org/fixture/TokenServiceTest.java",
    callee: "token.isBlank",
  },
] as const;

describe.each(CASES)("$id — tier-2 facts from a dynamic grammar", (c) => {
  it("names the changed METHOD, qualified, and only it", () => {
    const fixture = c.make();
    try {
      const document = all(fixture);
      const names = document.extractors.facts?.symbols.map((s) => s.name) ?? [];
      // The hunk is inside the method body: the method is touched, its sibling
      // method is not, and neither is anything in an unchanged file.
      expect(names).toContain(c.method);
      expect(names).not.toContain(c.sibling);
      expect(names).not.toContain(c.callerSymbol);

      const fact = symbol(document, c.method)!;
      expect(fact.kind).toBe("method");
      expect(fact.exported).toBe(true);
      expect(fact.resolution).toBe("name-match");
      expect(fact.nameAmbiguity).toBe(1);
      expect(fact.declaredAt.startsWith(`${c.methodFile}:`)).toBe(true);
      expect(fact.changedHunks.length).toBe(1);
      expect(fact.changedHunks[0].startsWith(`${c.methodFile}:`)).toBe(true);
      expect(fact.callees).toContain(c.callee);
      // Nobody looked — a type query at tier 2 is not answerable.
      expect(fact.implementations).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it("finds the cross-file CALLER and the test that mentions it", () => {
    const fixture = c.make();
    try {
      const fact = symbol(all(fixture), c.method)!;
      const caller = fact.references.find((r) => r.at.startsWith(`${c.callerFile}:`));
      expect(caller, "the call site in another file is a reference").toBeDefined();
      expect(caller?.inSymbol).toBe(c.callerSymbol);
      expect(caller?.isTest).toBe(false);
      expect(caller?.inDiff).toBe(false);
      expect(fact.tests).toEqual([c.testFile]);
      expect(fact.referenceCount).toBeGreaterThanOrEqual(2);
      expect(fact.referencesInDiff).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("stamps the envelope: tier 2, ast-grep, degraded, and a language row that parsed", () => {
    const fixture = c.make();
    try {
      const document = all(fixture);
      expect(document.tier).toBe(2);
      expect(document.engine).toBe("ast-grep");
      expect(document.coverage).toBe("degraded");
      expect(document.degraded.some((d) => d.extractor === "project")).toBe(true);
      expect(document.degraded.some((d) => d.extractor === "facts")).toBe(true);
      const row = document.languages.find((l) => l.id === c.id);
      expect(row).toMatchObject({ engine: "ast-grep" });
      expect(row?.parsedFiles).toBe(row?.changedFiles);
      expect(document.extractors.facts?.files.find((f) => f.path === c.methodFile)?.analysed).toBe(true);
      // `constants` stays TS/JS-only, and says so rather than looking clean.
      expect(document.extractors.constants?.constants).toEqual([]);
      expect(
        document.degraded.some((d) => d.extractor === "constants" && d.reason.includes(c.id)),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

// ── the descriptor tables, directly ─────────────────────────────────────────

describe("the descriptor tables", () => {
  it("every kind a descriptor names exists in its grammar", () => {
    // ast-grep refuses a whole rule over one unknown kind, so a typo here is a
    // silently-empty scan. `rejected` must be empty for every table.
    for (const descriptor of [PYTHON_DESCRIPTOR, GO_DESCRIPTOR, JAVA_DESCRIPTOR]) {
      const kinds = interestingKinds(descriptor, {
        declarations: true,
        references: true,
        literals: true,
        calls: true,
      });
      const withImports = [...kinds, ...(descriptor.importKinds ?? [])];
      expect(supportedKinds(descriptor, withImports).rejected, descriptor.id).toEqual([]);
    }
  });

  it("python: methods by enclosing class, decorators in the range, underscore privacy", () => {
    const sites = scanDeclarations(
      "pkg/m.py",
      `LIMIT = 3\n_secret = 1\n\nclass A:\n    @property\n    def run(self):\n        def inner():\n            pass\n        return 1\n\n    def __init__(self):\n        pass\n\n    def _p(self):\n        pass\n`,
    )!;
    const by = new Map(sites.map((s) => [s.name, s]));
    expect(by.get("A.run")).toMatchObject({ kind: "method", startLine: 5, line: 6, exported: true });
    expect(by.get("inner")).toMatchObject({ kind: "function", exported: false });
    expect(by.get("A.__init__")?.exported).toBe(true);
    expect(by.get("A._p")?.exported).toBe(false);
    expect(by.get("LIMIT")).toMatchObject({ kind: "variable", exported: true });
    expect(by.get("_secret")?.exported).toBe(false);
  });

  it("go: receiver-qualified methods, struct/interface kinds, capital-letter export", () => {
    const sites = scanDeclarations(
      "p/a.go",
      `package p\n\nconst Max = 3600\n\ntype S struct{}\ntype I interface { Do() }\n\nfunc (s *S) Run() {}\nfunc (s S[T]) stop() {}\nfunc helper() { x := 1; _ = x }\n`,
    )!;
    const by = new Map(sites.map((s) => [s.name, s]));
    expect(by.get("S")).toMatchObject({ kind: "struct", exported: true });
    expect(by.get("I")).toMatchObject({ kind: "interface", exported: true });
    expect(by.get("I.Do")).toMatchObject({ kind: "interface-method" });
    expect(by.get("S.Run")).toMatchObject({ kind: "method", exported: true });
    expect(by.get("S.stop")).toMatchObject({ kind: "method", exported: false });
    expect(by.get("helper")?.exported).toBe(false);
    expect(by.get("Max")).toMatchObject({ kind: "variable", valueText: "3600" });
    // A local (`x := 1`) is not a declaration.
    expect(by.has("x")).toBe(false);
  });

  it("java: fields vs locals by parent, `public`, interface members, `object.name` callees", () => {
    const sites: ReturnType<typeof scanDeclarations> = [];
    scanSource(
      JAVA_DESCRIPTOR,
      "src/main/java/A.java",
      `public class A {\n  public static final int MAX = 1;\n  private int n;\n  public A() {}\n  void run() { int local = 1; B.go(local); stop(); }\n}\ninterface I { void ping(); }\n`,
      { callees: true, declaration: (site) => sites.push(site) },
    );
    const by = new Map(sites.map((s) => [s.name, s]));
    expect(by.get("A.MAX")).toMatchObject({ kind: "property", exported: true, valueText: "1" });
    expect(by.get("A.n")?.exported).toBe(false);
    expect(by.get("A.A")).toMatchObject({ kind: "constructor", exported: true });
    expect(by.get("A.run")).toMatchObject({ kind: "method", exported: false });
    expect(by.get("A.run")?.callees.sort()).toEqual(["B.go", "stop"]);
    expect([...by.keys()].some((name) => name.endsWith("local"))).toBe(false);
    expect(by.get("I.ping")).toMatchObject({ kind: "interface-method", exported: true });
  });

  it("test paths, per language convention", () => {
    expect(PYTHON_DESCRIPTOR.isTestPath("app/test_x.py")).toBe(true);
    expect(PYTHON_DESCRIPTOR.isTestPath("app/x_test.py")).toBe(true);
    expect(PYTHON_DESCRIPTOR.isTestPath("tests/helpers.py")).toBe(true);
    expect(PYTHON_DESCRIPTOR.isTestPath("app/x.py")).toBe(false);
    expect(GO_DESCRIPTOR.isTestPath("pkg/a_test.go")).toBe(true);
    expect(GO_DESCRIPTOR.isTestPath("pkg/tests/a.go")).toBe(false);
    expect(JAVA_DESCRIPTOR.isTestPath("src/test/java/A.java")).toBe(true);
    expect(JAVA_DESCRIPTOR.isTestPath("src/main/java/A.java")).toBe(false);
  });

  it("import lines through the descriptor's importKinds", () => {
    expect(scanImportLines("a.py", `import os\nfrom x import (\n  a,\n)\nX = 1\n`)).toEqual([1, 2, 3, 4]);
    expect(scanImportLines("a.go", `package a\n\nimport (\n\t"fmt"\n)\n`)).toEqual([3, 4, 5]);
    expect(scanImportLines("A.java", `package a;\nimport java.util.List;\nclass A {}\n`)).toEqual([2]);
    // No importKinds on the TS/JS descriptors — the unit survey has its own path.
    expect(scanImportLines("a.ts", `import x from "y";\n`)).toBeNull();
  });
});

// ── mixed diffs: tier 1 stays tier 1, and families never cross ──────────────

describe("a mixed TypeScript + Python diff", () => {
  it("keeps the TS answer type-aware and adds the Python symbols name-matched", () => {
    const fixture = makeFixture(
      "dyn-mixed",
      {
        message: "base",
        files: {
          "tsconfig.json": TSCONFIG,
          "package.json": JSON.stringify({ name: "mixed", version: "1.0.0" }),
          "src/verify.ts": `export function verify(token: string): boolean {\n  return token.length > 0;\n}\n`,
          // The same NAME in the other family: a name matcher that crossed
          // languages would count this as a reference to the Python `verify`.
          "src/use.ts": `import { verify } from "./verify.js";\n\nexport const ok = verify("x");\n`,
          "py/auth.py": `def verify(token):\n    return bool(token)\n`,
          "py/views.py": `from py.auth import verify\n\n\ndef handle(t):\n    return verify(t)\n`,
          // The same LITERAL in both families: `constants`' set B is TS/JS-only.
          "src/other.ts": `export const elsewhere = 4242;\n`,
          "py/limits.py": `LIMIT = 4242\n`,
        },
      },
      {
        message: "head",
        files: {
          "src/verify.ts": `export function verify(token: string): boolean {\n  return token.length > 8;\n}\n`,
          "py/auth.py": `def verify(token):\n    return bool(token) and len(token) > 8\n`,
          "src/limits.ts": `export const LIMIT = 4242;\n`,
        },
      },
    );
    try {
      const document = all(fixture);
      expect(document.tier).toBe(1);
      expect(document.engine).toBe("tsgo");
      const symbols = document.extractors.facts?.symbols ?? [];
      const ts = symbols.find((s) => s.declaredAt.startsWith("src/verify.ts"));
      const py = symbols.find((s) => s.declaredAt.startsWith("py/auth.py"));
      expect(ts?.resolution).toBe("type-aware");
      expect(py?.resolution).toBe("name-match");
      // Family isolation: the Python symbol's references are Python files only,
      // and its ambiguity counts Python declarations only.
      expect(py?.references.map((r) => r.at.split(":")[0]).every((p) => p.endsWith(".py"))).toBe(true);
      expect(py?.references.some((r) => r.at.startsWith("py/views.py:"))).toBe(true);
      expect(py?.nameAmbiguity).toBe(1);
      expect(document.languages.find((l) => l.id === "python")).toMatchObject({
        engine: "ast-grep",
        parsedFiles: 1,
      });
      expect(document.extractors.facts?.files.find((f) => f.path === "py/auth.py")?.analysed).toBe(true);
      // Tier 1 with a name-matched half is not a clean tier-1 run.
      expect(document.coverage).toBe("degraded");
      // `constants`: the TS constant's literal sweep never reads a .py file.
      const limit = document.extractors.constants?.constants.find((c) => c.constant === "LIMIT");
      expect(limit?.hardCodedDuplicates).toEqual(["src/other.ts:1"]);
    } finally {
      fixture.cleanup();
    }
  });
});

// ── a grammar that does not load is LOUD, never silent ──────────────────────

describe("a grammar that fails to load", () => {
  afterEach(() => forceGrammarUnavailable("python", null));

  it("the preflight refuses a library that is not there or is not a library", () => {
    expect(preflightLibrary("/nonexistent/parser.so")).toMatch(/does not exist/);
    // A file that exists and is not a shared library: the loader refuses it.
    expect(preflightLibrary(new URL(import.meta.url).pathname)).not.toBeNull();
    // The real one maps.
    const require = createRequire(import.meta.url);
    const { libraryPath } = require("@ast-grep/lang-go") as { libraryPath: string };
    expect(preflightLibrary(libraryPath)).toBeNull();
  });

  it("every dynamic grammar loads on this platform", () => {
    for (const lang of ["python", "go", "java"]) {
      expect(grammarStatus(lang), lang).toEqual({ ok: true });
    }
  });

  it("names the language in degraded[], parses nothing, and keeps parsedFiles honest", () => {
    forceGrammarUnavailable("python", "injected: no prebuild for this platform");
    const fixture = makePythonRepo();
    try {
      const document = all(fixture);
      // Still tier 2 — the files ARE claimed — but nothing was learned.
      expect(document.coverage).toBe("degraded");
      expect(document.extractors.facts?.symbols).toEqual([]);
      const row = document.languages.find((l) => l.id === "python");
      expect(row?.changedFiles).toBeGreaterThan(0);
      expect(row?.parsedFiles).toBe(0);
      expect(document.extractors.facts?.files.every((f) => f.analysed === false)).toBe(true);
      const named = document.degraded.filter(
        (d) => d.extractor === "facts" && d.reason.includes("python") && d.reason.includes("injected"),
      );
      expect(named.length).toBe(1);
      // The per-file answer too: no declarations, and `scanSource` refuses.
      expect(scanDeclarations("a.py", "def f():\n    pass\n")).toBeNull();
      expect(descriptorForPath("a.py")?.id).toBe("python");
    } finally {
      fixture.cleanup();
    }
  });
});
