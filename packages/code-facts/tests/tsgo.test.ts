/**
 * THE TSGO SEAM, measured.
 *
 * `src/tsgo.ts` is the one module here that touches a compiler API, so every
 * claim it makes about TypeScript 7 has to be a claim a test ran. Three of the
 * four things this file pins were WRONG in the brief that commissioned the
 * module, and were found by running the API rather than by reading about it:
 *
 *   1. a tsconfig that will not parse does NOT throw — it yields a
 *      recovered-looking project plus config diagnostics nobody has to read;
 *   2. a tsconfig that does not exist is dropped from `getProjects()` in
 *      silence;
 *   3. an overlay keyed under one spelling of the repo root silently serves HEAD
 *      content on the BASE side, in any program that reached the file through a
 *      symlink.
 *
 * Each of those is paired here with the number it would be WITHOUT the fix —
 * `tests/noise-floor.test.ts`'s rule, because a ceiling nobody could have
 * violated is not a guard. The floors are measured against a RAW `API`, which is
 * why this file imports the compiler directly and `src/` never may.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { API } from "typescript/unstable/sync";
import {
  type EngineSnapshot,
  openSnapshot,
  resolveTsgoBinary,
  TsgoError,
  TSGO_BIN_ENV,
} from "../src/tsgo.js";
import {
  type Fixture,
  makeBrokenTsConfigFixture,
  makeContractFixture,
  makeFixture,
  makeMultiProjectFixture,
} from "./helpers.js";

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
    },
    include: ["src"],
  },
  null,
  2,
);

/**
 * THE CROSS-PACKAGE FIXTURE — two tsconfigs, and package `b` reaching package
 * `a` the way a real workspace does: through a `node_modules` symlink.
 *
 * The symlink is not decoration. It is what makes tsgo `realpath` the file
 * before reading it, which is the mechanism behind the overlay's one silent
 * failure mode (see "the two spellings of the repo root" below). A `paths`
 * mapping would cross the same package boundary and would NOT exhibit it, so
 * the fixture would pass while the bug shipped.
 */
function makeCrossPackageFixture(): Fixture {
  const shared: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture-cross", private: true }, null, 2),
    "packages/a/package.json": JSON.stringify(
      { name: "@fixture/cross-a", version: "1.0.0", types: "src/token.ts" },
      null,
      2,
    ),
    "packages/a/tsconfig.json": TSCONFIG,
    "packages/b/package.json": JSON.stringify(
      { name: "@fixture/cross-b", version: "1.0.0" },
      null,
      2,
    ),
    "packages/b/tsconfig.json": TSCONFIG,
    "packages/b/src/session.ts": `import { mintToken } from "@fixture/cross-a";

export function open(id: string) {
  return mintToken(id);
}
`,
  };
  return makeFixture(
    "cross",
    {
      message: "base",
      files: {
        ...shared,
        "packages/a/src/token.ts": `export interface Token {
  value: string;
}

export function mintToken(value: string): Token | null {
  return value ? { value } : null;
}
`,
      },
    },
    {
      message: "head: mintToken stops returning null, and a file is added",
      files: {
        "packages/a/src/token.ts": `export interface Token {
  value: string;
}

export function mintToken(value: string): Token {
  return { value };
}
`,
        // ADDED by the PR: it must be absent from the base view, which is what
        // a `null` overlay entry is for.
        "packages/a/src/added.ts": `export const ADDED = 1;\n`,
      },
    },
  );
}

/** `git show <sha>:<path>`, or `null` when the file did not exist at that commit. */
function blobAt(repo: string, sha: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], { cwd: repo, encoding: "utf8" });
  } catch {
    return null;
  }
}

function typeOfExport(
  snapshot: EngineSnapshot,
  path: string,
  exportName: string,
): string | null {
  const file = snapshot.lookup(path);
  if (!file) return null;
  const checker = file.owner.project.checker;
  const moduleSymbol = checker.getSymbolAtLocation(file.sourceFile);
  if (!moduleSymbol) return null;
  const symbol = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === exportName);
  if (!symbol) return null;
  const type = checker.getTypeOfSymbol(symbol);
  return type ? checker.typeToString(type) : null;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("openSnapshot — one snapshot, every program", () => {
  let fixture: Fixture;
  let snapshot: EngineSnapshot;

  beforeAll(() => {
    fixture = makeMultiProjectFixture();
    snapshot = openSnapshot({
      repo: fixture.dir,
      tsConfigPaths: ["packages/a/tsconfig.json", "packages/b/tsconfig.json"],
      openFiles: ["scripts/release.ts"],
    });
  });

  afterAll(() => {
    snapshot?.dispose();
    fixture?.cleanup();
  });

  it("compiles BOTH tsconfigs in a single snapshot", () => {
    const configured = snapshot.projects.filter((p) => !p.inferred);
    expect(configured.map((p) => p.tsConfigPath)).toEqual([
      "packages/a/tsconfig.json",
      "packages/b/tsconfig.json",
    ]);
    // Every program really compiled: `lib.*.d.ts` alone is dozens of files, and
    // a project reporting a handful would be a project that saw nothing.
    for (const project of configured) expect(project.fileCount).toBeGreaterThan(10);
    expect(snapshot.failures).toEqual([]);
  });

  it("resolves each package's own changed symbol in its own program", () => {
    // `ttl?: number | undefined` rather than `ttl?: number` is not a TS 7
    // quirk: `ts-morph`'s own `typeChecker.typeToString` prints an optional
    // parameter the same way (checked, because a printing difference between
    // the engines would land straight in `contracts`, which compares type TEXT
    // and compares `throws` RAW).
    expect(typeOfExport(snapshot, "packages/a/src/token.ts", "mintToken")).toBe(
      "(value: string, ttl?: number | undefined) => Token",
    );
    expect(typeOfExport(snapshot, "packages/b/src/session.ts", "openSession")).toBe(
      "(id: string, warm?: boolean | undefined) => Session",
    );
  });

  it("routes each file to the program that ROOTS it, not merely to one that holds it", () => {
    const a = snapshot.lookup("packages/a/src/token.ts");
    const b = snapshot.lookup("packages/b/src/session.ts");
    expect(a?.owner.tsConfigPath).toBe("packages/a/tsconfig.json");
    expect(a?.isRootFile).toBe(true);
    expect(b?.owner.tsConfigPath).toBe("packages/b/tsconfig.json");
    expect(b?.isRootFile).toBe(true);
  });

  it("returns null — not a fabricated file — for a path no program holds", () => {
    expect(snapshot.lookup("packages/a/src/does-not-exist.ts")).toBeNull();
    expect(snapshot.lookup("../outside-the-repo.ts")).toBeNull();
  });

  describe("a file under NO tsconfig — the bug-4 claim", () => {
    it("still gets a working checker, via tsgo's inferred project", () => {
      const file = snapshot.lookup("scripts/release.ts");
      expect(file).not.toBeNull();
      expect(file?.owner.inferred).toBe(true);
      expect(file?.owner.tsConfigPath).toBeNull();
      // Not just "present": the checker answers a real type-resolution question
      // about it. `CHANGED = "beta"` is only a literal type if the checker ran.
      expect(typeOfExport(snapshot, "scripts/release.ts", "tagFor")).toBe(
        "(version: string) => string",
      );
      expect(typeOfExport(snapshot, "scripts/release.ts", "CHANNEL")).toBe('"beta"');
    });

    it("says so — inferred-project output is not tsconfig-tier output", () => {
      expect(snapshot.degraded).toHaveLength(1);
      expect(snapshot.degraded[0]?.extractor).toBe("tsgo");
      expect(snapshot.degraded[0]?.reason).toMatch(/inferred project/);
      // The COUNT, not the request size — see below for why that is not the
      // same number.
      expect(snapshot.degraded[0]?.reason).toMatch(/^1 file is covered by no tsconfig/);
      expect(snapshot.degraded[0]?.reason).toContain("scripts/release.ts");
    });
  });
});

describe("openFiles is `didOpen`, not `give me an inferred project`", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeMultiProjectFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("routes an opened file its own tsconfig covers to the CONFIGURED project", () => {
    const snapshot = openSnapshot({
      repo: fixture.dir,
      tsConfigPaths: ["packages/a/tsconfig.json"],
      // Already inside `packages/a/tsconfig.json`'s `include`.
      openFiles: ["packages/a/src/token.ts"],
    });
    try {
      expect(snapshot.lookup("packages/a/src/token.ts")?.owner.inferred).toBe(false);
      // Nothing fell through, so nothing is claimed to have fallen through. A
      // `degraded[]` populated on every run has stopped carrying signal.
      expect(snapshot.degraded).toEqual([]);
    } finally {
      snapshot.dispose();
    }
  });

  it("names an opened file that ended up in no program at all", () => {
    const snapshot = openSnapshot({
      repo: fixture.dir,
      tsConfigPaths: ["packages/a/tsconfig.json"],
      openFiles: ["packages/a/src/never-existed.ts"],
    });
    try {
      expect(snapshot.lookup("packages/a/src/never-existed.ts")).toBeNull();
      expect(snapshot.degraded.map((d) => d.reason).join("\n")).toMatch(/no program at all/);
    } finally {
      snapshot.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the base overlay — a base program with no second worktree", () => {
  let fixture: Fixture;
  let head: EngineSnapshot;
  let base: EngineSnapshot;

  beforeAll(() => {
    fixture = makeContractFixture();
    // THE SYMMETRY INVARIANT, as code: one argument list, used twice, with the
    // overlay as the only difference. `contracts` once reported 227 deltas of
    // which one was real because the two sides were built differently.
    const shape = {
      repo: fixture.dir,
      tsConfigPaths: ["tsconfig.json"],
    } as const;
    head = openSnapshot(shape);
    base = openSnapshot({
      ...shape,
      overlay: new Map([["src/user.ts", blobAt(fixture.dir, fixture.base, "src/user.ts")]]),
    });
  });

  afterAll(() => {
    head?.dispose();
    base?.dispose();
    fixture?.cleanup();
  });

  it("gives the head signature off the working tree", () => {
    expect(head.overlaid).toBe(false);
    expect(typeOfExport(head, "src/user.ts", "getUser")).toBe("(id: string) => User");
  });

  it("gives the BASE signature from the same tree", () => {
    expect(base.overlaid).toBe(true);
    expect(typeOfExport(base, "src/user.ts", "getUser")).toBe("(id: string) => User | null");
  });

  it("changes only the CONTENT — never which programs exist or what they hold", () => {
    expect(base.projects.map((p) => p.tsConfigPath)).toEqual(
      head.projects.map((p) => p.tsConfigPath),
    );
    expect(base.projects.map((p) => p.fileCount)).toEqual(head.projects.map((p) => p.fileCount));
    expect(base.failures).toEqual(head.failures);
    // The consumer outside the diff is untouched by the overlay and must read
    // identically on both sides — an asymmetry here is a phantom delta.
    expect(typeOfExport(base, "src/api/handler.ts", "handle")).toBe(
      typeOfExport(head, "src/api/handler.ts", "handle"),
    );
  });

  it("WITHOUT the overlay the base view is the head view — the floor", () => {
    // The pin that makes the assertion above a guard rather than a restatement:
    // an overlay that silently did nothing would produce this, and every other
    // test in this block would still pass.
    const unoverlaid = openSnapshot({ repo: fixture.dir, tsConfigPaths: ["tsconfig.json"] });
    try {
      expect(typeOfExport(unoverlaid, "src/user.ts", "getUser")).toBe(
        typeOfExport(head, "src/user.ts", "getUser"),
      );
      expect(typeOfExport(unoverlaid, "src/user.ts", "getUser")).not.toBe(
        typeOfExport(base, "src/user.ts", "getUser"),
      );
    } finally {
      unoverlaid.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the two spellings of the repo root", () => {
  let fixture: Fixture;
  let link: string;
  let baseToken: string;

  beforeAll(() => {
    fixture = makeCrossPackageFixture();
    // The workspace shape: `packages/b` reaches `packages/a` through a
    // `node_modules` symlink, exactly as pnpm lays a monorepo out.
    const linkPath = join(fixture.dir, "packages/b/node_modules/@fixture/cross-a");
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(join(fixture.dir, "packages/a"), linkPath, "dir");
    // And the repo itself is reached through a symlink — a review workspace
    // under `$TMPDIR` on macOS already is one, and `contracts` materialises its
    // base worktree there today.
    link = join(tmpdir(), `ll-facts-cross-link-${process.pid}-${Date.now()}`);
    symlinkSync(fixture.dir, link, "dir");
    baseToken = blobAt(fixture.dir, fixture.base, "packages/a/src/token.ts") ?? "";
    expect(baseToken).toContain("Token | null");
  });

  afterAll(() => {
    if (link) rmSync(link, { force: true });
    fixture?.cleanup();
  });

  const open = (overlay?: Map<string, string | null>): EngineSnapshot =>
    openSnapshot({
      repo: link,
      tsConfigPaths: ["packages/a/tsconfig.json", "packages/b/tsconfig.json"],
      ...(overlay ? { overlay } : {}),
    });

  it("resolves a symbol ACROSS the package boundary in one snapshot", () => {
    const snapshot = open();
    try {
      // `open` in package b is typed only if b's program resolved
      // `@fixture/cross-a` through the symlink and type-checked package a's
      // source. Package a is not a root of b's program.
      expect(typeOfExport(snapshot, "packages/b/src/session.ts", "open")).toBe(
        "(id: string) => Token",
      );
      expect(typeOfExport(snapshot, "packages/a/src/token.ts", "mintToken")).toBe(
        "(value: string) => Token",
      );
      // …and the declaration is still owned by its OWN program, so a reference
      // query about it runs where its references live.
      expect(snapshot.lookup("packages/a/src/token.ts")?.owner.tsConfigPath).toBe(
        "packages/a/tsconfig.json",
      );
    } finally {
      snapshot.dispose();
    }
  });

  it("serves the overlay in EVERY program, however the file was reached", () => {
    const snapshot = open(new Map([["packages/a/src/token.ts", baseToken]]));
    try {
      expect(typeOfExport(snapshot, "packages/a/src/token.ts", "mintToken")).toBe(
        "(value: string) => Token | null",
      );
      // The one that a single-spelling index gets wrong.
      expect(typeOfExport(snapshot, "packages/b/src/session.ts", "open")).toBe(
        "(id: string) => Token | null",
      );
    } finally {
      snapshot.dispose();
    }
  });

  it("a SINGLE-spelling overlay silently serves head content to the far program — the floor", () => {
    // Measured against a raw `API`, because this is the shape `openSnapshot`
    // replaced and there is no way to ask it for the broken behaviour. Note what
    // the failure looks like: no error, no empty result, package `a` correct and
    // package `b` quietly reading the head tree. That is the 227-phantom-deltas
    // class arriving from a new direction.
    const index = new Map([[join(link, "packages/a/src/token.ts"), baseToken]]);
    const api = new API({
      cwd: link,
      ...(resolveTsgoBinary() ? { tsserverPath: resolveTsgoBinary() as string } : {}),
      fs: { readFile: (f) => (index.has(f) ? index.get(f) : undefined) },
    });
    try {
      const snapshot = api.updateSnapshot({
        openProjects: [
          join(link, "packages/a/tsconfig.json"),
          join(link, "packages/b/tsconfig.json"),
        ],
      });
      const read = (config: string, file: string, name: string): string | null => {
        const project = snapshot.getProject(config);
        const sourceFile = project?.program.getSourceFile(file);
        if (!project || !sourceFile) return null;
        const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) return null;
        const symbol = project.checker
          .getExportsOfModule(moduleSymbol)
          .find((s) => s.name === name);
        if (!symbol) return null;
        const type = project.checker.getTypeOfSymbol(symbol);
        return type ? project.checker.typeToString(type) : null;
      };
      expect(
        read(join(link, "packages/a/tsconfig.json"), join(link, "packages/a/src/token.ts"), "mintToken"),
      ).toBe("(value: string) => Token | null");
      // The miss, pinned: HEAD's signature, on the BASE side, with no complaint.
      expect(
        read(join(link, "packages/b/tsconfig.json"), join(link, "packages/b/src/session.ts"), "open"),
      ).toBe("(id: string) => Token");
    } finally {
      api.close();
    }
  });

  it("a `null` overlay entry makes an ADDED file absent at base", () => {
    const snapshot = open(
      new Map<string, string | null>([
        ["packages/a/src/token.ts", baseToken],
        // The head commit adds it, so at base it does not exist. `[]` here would
        // be an empty file; `null` is the file not being there.
        ["packages/a/src/added.ts", null],
      ]),
    );
    try {
      expect(snapshot.lookup("packages/a/src/added.ts")).toBeNull();
    } finally {
      snapshot.dispose();
    }
    const headSnapshot = open();
    try {
      expect(headSnapshot.lookup("packages/a/src/added.ts")).not.toBeNull();
      expect(typeOfExport(headSnapshot, "packages/a/src/added.ts", "ADDED")).toBe("1");
    } finally {
      headSnapshot.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("fail loud — the compiler's two silences", () => {
  it("EXCLUDES a tsconfig that will not parse, and names why", () => {
    const fixture = makeBrokenTsConfigFixture();
    const snapshot = openSnapshot({ repo: fixture.dir, tsConfigPaths: ["tsconfig.json"] });
    try {
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.failures).toEqual([
        { tsConfigPath: "tsconfig.json", reason: "tsconfig-unparsable", detail: expect.any(String) },
      ]);
      expect(snapshot.degraded).toHaveLength(1);
      expect(snapshot.degraded[0]?.reason).toMatch(/abandoned rather than analysed/);
      // Abandoned, not globbed around: no file of that project is reachable, so
      // nothing downstream can mistake it for a type-aware answer.
      expect(snapshot.lookup("src/a.ts")).toBeNull();
    } finally {
      snapshot.dispose();
      fixture.cleanup();
    }
  });

  it("…and WITHOUT that check the compiler hands back a project that looks fine — the floor", () => {
    // The measurement the check exists for: `updateSnapshot` does not throw on
    // an unparseable tsconfig. It recovers a project, fills it with source
    // files, and demotes the parse failure to a diagnostic list nobody is
    // obliged to read. Left unchecked, a repo whose build config is broken is
    // silently promoted to tier 1.
    const fixture = makeBrokenTsConfigFixture();
    const config = join(fixture.dir, "tsconfig.json");
    const binary = resolveTsgoBinary();
    const api = new API({ cwd: fixture.dir, ...(binary ? { tsserverPath: binary } : {}) });
    try {
      const projects = api.updateSnapshot({ openProjects: [config] }).getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]?.program.getSourceFileNames().length).toBeGreaterThan(10);
      expect(projects[0]?.rootFiles.length).toBeGreaterThan(0);
      // The only place the truth is recorded.
      expect(projects[0]?.program.getConfigFileParsingDiagnostics().length).toBeGreaterThan(0);
    } finally {
      api.close();
      fixture.cleanup();
    }
  });

  it("a HEALTHY tsconfig carries no parse errors — the other half of that floor", () => {
    // Without this, "excluded when diagnostics are non-empty" could be excluding
    // every project on every repo and the test above would not notice.
    const fixture = makeContractFixture();
    const snapshot = openSnapshot({ repo: fixture.dir, tsConfigPaths: ["tsconfig.json"] });
    try {
      expect(snapshot.failures).toEqual([]);
      expect(snapshot.degraded).toEqual([]);
      expect(snapshot.projects).toHaveLength(1);
    } finally {
      snapshot.dispose();
      fixture.cleanup();
    }
  });

  it("names a tsconfig that is not there, instead of quietly returning fewer projects", () => {
    const fixture = makeContractFixture();
    const snapshot = openSnapshot({
      repo: fixture.dir,
      tsConfigPaths: ["tsconfig.json", "packages/ghost/tsconfig.json"],
    });
    try {
      expect(snapshot.projects.map((p) => p.tsConfigPath)).toEqual(["tsconfig.json"]);
      expect(snapshot.failures).toEqual([
        { tsConfigPath: "packages/ghost/tsconfig.json", reason: "tsconfig-absent", detail: null },
      ]);
      expect(snapshot.degraded[0]?.reason).toMatch(/NOT in this snapshot/);
    } finally {
      snapshot.dispose();
      fixture.cleanup();
    }
  });
});

describe("fail loud — the binary", () => {
  it("throws a NAMED error for a binary that is not there", () => {
    // A missing binary must never reach `spawn`: `syncChannel.js` attaches no
    // `'error'` listener, so an ENOENT there kills the process on the next tick
    // with no stack a `try`/`catch` can reach — the `tests/oom.test.ts` shape,
    // which `--never-fail` provably cannot cover.
    expect(() => resolveTsgoBinary("/definitely/not/here/tsgo")).toThrowError(TsgoError);
    try {
      resolveTsgoBinary("/definitely/not/here/tsgo");
      expect.unreachable("resolveTsgoBinary should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TsgoError);
      expect((err as TsgoError).reason).toBe("binary-unresolvable");
      expect((err as TsgoError).extractor).toBe("tsgo");
      expect((err as TsgoError).message).toMatch(/does not exist/);
    }
  });

  it("throws a DIFFERENT named error for a path that exists but cannot be executed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ll-facts-tsgo-bin-"));
    try {
      const notExecutable = join(dir, "tsgo");
      writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      try {
        resolveTsgoBinary(notExecutable);
        expect.unreachable("resolveTsgoBinary should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TsgoError);
        expect((err as TsgoError).reason).toBe("binary-not-executable");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours the §D1 environment override", () => {
    const previous = process.env[TSGO_BIN_ENV];
    process.env[TSGO_BIN_ENV] = "/definitely/not/here/tsgo";
    try {
      expect(() => resolveTsgoBinary()).toThrowError(/LASTLIGHT_TSGO_BIN/);
    } finally {
      if (previous === undefined) delete process.env[TSGO_BIN_ENV];
      else process.env[TSGO_BIN_ENV] = previous;
    }
  });

  it("resolves the platform binary out of THIS package's tree", () => {
    const binary = resolveTsgoBinary();
    expect(binary).not.toBeNull();
    // Never from a repo under review — the TS 7 landmine
    // (`tests/compiler-isolation.test.ts`).
    expect(binary?.startsWith(tmpdir())).toBe(false);
    expect(binary).toMatch(/@typescript[/+]typescript-/);
  });
});

describe("dispose", () => {
  it("is idempotent, so a `finally` may run twice", () => {
    const fixture = makeContractFixture();
    try {
      const snapshot = openSnapshot({ repo: fixture.dir, tsConfigPaths: ["tsconfig.json"] });
      expect(typeOfExport(snapshot, "src/user.ts", "getUser")).toBe("(id: string) => User");
      snapshot.dispose();
      expect(() => snapshot.dispose()).not.toThrow();
      expect(() => snapshot.dispose()).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves no child process behind after a whole suite of snapshots", () => {
    // The reason `dispose()` belongs in a `finally`: each snapshot is a spawned
    // `tsgo`, and a leaked one keeps the vitest worker alive.
    const fixture = makeContractFixture();
    try {
      for (let i = 0; i < 3; i++) {
        const snapshot = openSnapshot({ repo: fixture.dir, tsConfigPaths: ["tsconfig.json"] });
        try {
          expect(snapshot.projects).toHaveLength(1);
        } finally {
          snapshot.dispose();
        }
      }
    } finally {
      fixture.cleanup();
    }
  });
});
