/**
 * `deps` — and the two v3 bugs that must never come back.
 *
 * `1641-r2`'s gold finding lived inside `eslint-plugin-require-extensions`. The
 * v3 enumerator's denylist used an `^eslint` PREFIX and swallowed it, so the
 * package the defect was in never reached the model. And the plugin was loaded
 * with `createRequire(import.meta.url)("...")`, which the import scan did not
 * recognise. Both are pinned here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  makeDepsFixture,
  makeFakeTool,
  makeFixture,
  makeGoFixture,
  makeJavaFixture,
  makeMixedEcosystemFixture,
  makePythonFixture,
  makeRubyFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { isToolingPackage, lockedVersion, packageNameOf, scanImports } from "../src/deps.js";
import {
  ecosystemOf,
  parseGemfile,
  parseGemfileLock,
  parseGoMod,
  parseGradle,
  parsePom,
  parsePyproject,
  parseRequirements,
} from "../src/manifests.js";
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

/**
 * WS6 stage 0 — `deps` beyond npm.
 *
 * MEASURED on the 50-case corpus, and the numbers are the argument: keycloak's
 * root manifest is Maven and discourse's is a Gemfile — **neither repo has a
 * root `package.json`** — so `deps` degraded outright on ~19 of 50 cases. The
 * mixed repos were worse, because they degraded on nothing: grafana
 * (`package.json` + `go.mod`) and sentry (`package.json` + `pyproject.toml`)
 * reported the JS half and looked complete.
 */
function deps(fixture: Fixture): DepsDocument {
  return runExtractor({
    extractor: "deps",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
  }).document as unknown as DepsDocument;
}

describe("deps — the ecosystems with no package.json at all", () => {
  it("reads a Maven pom, resolving the ${…} property that carries the bump", () => {
    const fixture = makeJavaFixture();
    try {
      const document = deps(fixture);
      // The whole point: no package.json anywhere, and the delta is still real.
      expect(document.coverage).toBe("full");
      expect(document.manifests).toEqual([{ path: "pom.xml", ecosystem: "maven" }]);

      const jackson = document.changes.find(
        (c) => c.name === "com.fasterxml.jackson.core:jackson-databind",
      );
      expect(jackson?.change).toBe("bumped");
      expect(jackson?.before).toBe("2.15.0");
      expect(jackson?.after).toBe("2.17.1");
      expect(jackson?.ecosystem).toBe("maven");
      expect(jackson?.manifest).toBe("pom.xml");
      // `<scope>test</scope>` folds onto npm's vocabulary so one array is
      // comparable across a PR that touches two ecosystems.
      expect(document.changes.find((c) => c.name.endsWith(":junit-jupiter"))).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("reads go.mod and does NOT report the `// indirect` lines", () => {
    const fixture = makeGoFixture();
    try {
      const document = deps(fixture);
      expect(document.manifests).toEqual([{ path: "go.mod", ecosystem: "go" }]);
      const grpc = document.changes.find((c) => c.name === "google.golang.org/grpc");
      expect(grpc?.before).toBe("v1.62.0");
      expect(grpc?.after).toBe("v1.64.0");
      // An indirect pin is a transitive the toolchain wrote, not a declaration
      // this PR made — reporting them buries the one line a human typed.
      expect(document.changes.map((c) => c.name)).not.toContain("golang.org/x/sys");
    } finally {
      fixture.cleanup();
    }
  });

  it("reads a Gemfile, including the `group :development, :test` scope", () => {
    const fixture = makeRubyFixture();
    try {
      const document = deps(fixture);
      expect(document.manifests).toEqual([{ path: "Gemfile", ecosystem: "bundler" }]);
      const rails = document.changes.find((c) => c.name === "rails");
      expect(rails?.change).toBe("bumped");
      expect(rails?.before).toBe("~> 7.0");
      expect(rails?.after).toBe("~> 7.1");
    } finally {
      fixture.cleanup();
    }
  });

  it("reads pyproject.toml AND requirements.txt from the same PR", () => {
    const fixture = makePythonFixture();
    try {
      const document = deps(fixture);
      expect(document.manifests.map((m) => m.path).sort()).toEqual([
        "pyproject.toml",
        "requirements.txt",
      ]);
      const django = document.changes.find((c) => c.name === "django");
      expect(django?.before).toBe(">=4.2,<5.0");
      expect(django?.after).toBe(">=5.0,<6.0");
      expect(django?.manifest).toBe("pyproject.toml");

      const celery = document.changes.find((c) => c.name === "celery");
      expect(celery?.manifest).toBe("requirements.txt");
      expect(celery?.after).toBe("==5.4.0");
    } finally {
      fixture.cleanup();
    }
  });

  it("covers BOTH halves of a mixed npm + go.mod PR — the grafana shape", () => {
    const fixture = makeMixedEcosystemFixture();
    try {
      const document = deps(fixture);
      expect(document.manifests).toEqual([
        { path: "package.json", ecosystem: "npm" },
        { path: "pkg/api/go.mod", ecosystem: "go" },
      ]);
      // A root-only scan reported the first of these and looked complete.
      expect(document.changes.find((c) => c.name === "date-fns")?.ecosystem).toBe("npm");
      const mux = document.changes.find((c) => c.name === "github.com/gorilla/mux");
      expect(mux?.ecosystem).toBe("go");
      expect(mux?.manifest).toBe("pkg/api/go.mod");
      expect(mux?.change).toBe("bumped");
    } finally {
      fixture.cleanup();
    }
  });

  it("names a nested manifest only when the diff touched it — cal.com has 140", () => {
    const fixture = makeMixedEcosystemFixture();
    try {
      // `pkg/api/go.mod` is in the diff; nothing else nested is, and the scan is
      // scoped to touched-plus-root rather than to every manifest in the tree.
      expect(deps(fixture).manifests).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("deps — manifest recognition and the individual parsers", () => {
  it("recognises a manifest by basename, at any depth", () => {
    expect(ecosystemOf("package.json")).toBe("npm");
    expect(ecosystemOf("apps/web/package.json")).toBe("npm");
    expect(ecosystemOf("go.mod")).toBe("go");
    expect(ecosystemOf("pom.xml")).toBe("maven");
    expect(ecosystemOf("build.gradle.kts")).toBe("gradle");
    expect(ecosystemOf("Gemfile.lock")).toBe("bundler");
    expect(ecosystemOf("requirements-dev.txt")).toBe("pypi");
    expect(ecosystemOf("src/index.ts")).toBeNull();
    expect(ecosystemOf("package-lock.json")).toBeNull();
  });

  it("parses both go.mod require forms", () => {
    const parsed = parseGoMod(
      "module m\n\ngo 1.22\n\nrequire github.com/a/b v1.0.0\n\nrequire (\n\tgithub.com/c/d v2.1.0\n\tgithub.com/e/f v0.1.0 // indirect\n)\n",
    );
    expect(parsed.get("github.com/a/b")?.version).toBe("v1.0.0");
    expect(parsed.get("github.com/c/d")?.version).toBe("v2.1.0");
    expect(parsed.has("github.com/e/f")).toBe(false);
  });

  it("parses gradle's quoted-coordinate forms and skips a version catalog reference", () => {
    const parsed = parseGradle(
      [
        `implementation("org.foo:bar:1.2.3")`,
        `testImplementation 'org.junit:junit:4.13'`,
        // No version HERE — it lives in gradle/libs.versions.toml, and reporting
        // a wrong version is worse than reporting nothing.
        `implementation(libs.baz.qux)`,
      ].join("\n"),
    );
    expect(parsed.get("org.foo:bar")).toEqual({ version: "1.2.3", scope: "dependencies" });
    expect(parsed.get("org.junit:junit")?.scope).toBe("devDependencies");
    expect(parsed.size).toBe(2);
  });

  it("prefers a dependencyManagement version over a bare module declaration", () => {
    const parsed = parsePom(
      `<project><dependencyManagement><dependencies><dependency>` +
        `<groupId>g</groupId><artifactId>a</artifactId><version>3.0.0</version>` +
        `</dependency></dependencies></dependencyManagement>` +
        `<dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId></dependency></dependencies></project>`,
    );
    expect(parsed.get("g:a")?.version).toBe("3.0.0");
  });

  it("takes the DEPENDENCIES section of a Gemfile.lock, not the resolved graph", () => {
    const parsed = parseGemfileLock(
      [
        "GEM",
        "  specs:",
        "    rails (7.1.0)",
        "    activesupport (7.1.0)",
        "",
        "DEPENDENCIES",
        "  rails (~> 7.1)",
        "",
        "BUNDLED WITH",
        "   2.5.0",
      ].join("\n"),
    );
    // `activesupport` is a transitive; only `rails` was declared.
    expect([...parsed.keys()]).toEqual(["rails"]);
    expect(parsed.get("rails")?.version).toBe("7.1.0");
  });

  it("scopes a Gemfile group block and closes it at `end`", () => {
    const parsed = parseGemfile(
      `gem "rails", "~> 7.0"\n\ngroup :development, :test do\n  gem "rspec"\nend\n\ngem "pg"\n`,
    );
    expect(parsed.get("rails")?.scope).toBe("dependencies");
    expect(parsed.get("rspec")?.scope).toBe("devDependencies");
    expect(parsed.get("pg")?.scope).toBe("dependencies");
  });

  it("reads PEP 621, PEP 735 and Poetry out of one pyproject", () => {
    const parsed = parsePyproject(
      [
        "[project]",
        'name = "x"',
        'dependencies = ["django>=5.0", "requests"]',
        "",
        "[project.optional-dependencies]",
        'pg = ["psycopg[binary]>=3"]',
        "",
        "[dependency-groups]",
        'dev = ["pytest>=8"]',
        "",
        "[tool.poetry.group.test.dependencies]",
        'factory-boy = "^3.3"',
      ].join("\n"),
    );
    expect(parsed.get("django")).toEqual({ version: ">=5.0", scope: "dependencies" });
    expect(parsed.get("requests")?.version).toBeNull();
    expect(parsed.get("psycopg")?.scope).toBe("optionalDependencies");
    expect(parsed.get("pytest")?.scope).toBe("devDependencies");
    expect(parsed.get("factory-boy")).toEqual({ version: "^3.3", scope: "devDependencies" });
  });

  it("drops `-r` / `-e` lines from a requirements.txt — they are not declarations", () => {
    const parsed = parseRequirements("celery==5.4.0\n-r base.txt\n-e .\n# comment\n\nboto3\n");
    expect([...parsed.keys()].sort()).toEqual(["boto3", "celery"]);
  });
});

/**
 * The four scopes and the third change type.
 *
 * Every fixture above only ever ADDED or BUMPED something in `dependencies` or
 * `devDependencies`, so `removed` — the change a reviewer most wants flagged,
 * because the import that still references it compiles until it does not — had
 * never been emitted, and the peer/optional scopes had never left the parser.
 */
describe("deps — every scope, and the `removed` change", () => {
  let fixture: Fixture;
  let document: DepsDocument;

  beforeAll(() => {
    const manifest = (
      deps: Record<string, string>,
      peer: Record<string, string>,
      optional: Record<string, string>,
    ): string =>
      JSON.stringify(
        {
          name: "fixture-scopes",
          version: "1.0.0",
          dependencies: deps,
          peerDependencies: peer,
          optionalDependencies: optional,
        },
        null,
        2,
      );
    fixture = makeFixture(
      "scopes",
      {
        message: "base",
        files: {
          "package.json": manifest(
            { "left-pad": "^1.3.0", "dead-dep": "^2.0.0" },
            { react: "^17.0.0" },
            { fsevents: "^2.3.0" },
          ),
          "src/index.ts": `import "dead-dep";\n\nexport const ok = true;\n`,
        },
      },
      {
        message: "head",
        files: {
          "package.json": manifest(
            { "left-pad": "^1.3.0" },
            { react: "^18.0.0" },
            { fsevents: "^2.3.2" },
          ),
          "src/index.ts": `export const ok = true;\n`,
        },
      },
    );
    document = runExtractor({
      extractor: "deps",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as DepsDocument;
  });
  afterAll(() => fixture.cleanup());

  it("reports a dropped dependency as `removed`, with a before and no after", () => {
    const removed = document.changes.find((c) => c.name === "dead-dep");
    expect(removed?.change).toBe("removed");
    expect(removed?.before).toBe("^2.0.0");
    expect(removed?.after).toBeNull();
    expect(removed?.scope).toBe("dependencies");
    // Nothing is staged for a removal — there is no version left to fetch.
    expect(removed?.stagedAt).toBeNull();
  });

  it("carries peerDependencies and optionalDependencies through with their own scope", () => {
    expect(document.changes.find((c) => c.name === "react")).toMatchObject({
      scope: "peerDependencies",
      change: "bumped",
      before: "^17.0.0",
      after: "^18.0.0",
    });
    expect(document.changes.find((c) => c.name === "fsevents")).toMatchObject({
      scope: "optionalDependencies",
      change: "bumped",
      before: "^2.3.0",
      after: "^2.3.2",
    });
  });

  it("leaves an unchanged dependency out of the delta entirely", () => {
    expect(document.changes.map((c) => c.name)).not.toContain("left-pad");
  });
});

/**
 * `lockedVersion` — WHICH version `npm pack` is asked for.
 *
 * `npm pack pkg@^1.2.3` resolves to whatever is newest today, which is not what
 * the PR would run, so the point of this function is to prefer something
 * pinned. All four branches are here, in priority order, each on a real file:
 * every one of them decides which SOURCE a reviewer ends up reading.
 */
describe("deps — lockedVersion, all four branches", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ll-facts-locked-"));
    scratch.push(dir);
    for (const [path, contents] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return dir;
  }

  it("prefers the INSTALLED package.json over every lockfile", () => {
    const repo = repoWith({
      "node_modules/left-pad/package.json": JSON.stringify({ version: "1.3.0" }),
      "package-lock.json": JSON.stringify({
        packages: { "node_modules/left-pad": { version: "9.9.9" } },
      }),
      "pnpm-lock.yaml": "packages:\n  left-pad@8.8.8:\n    resolution: {}\n",
    });
    expect(lockedVersion(repo, "left-pad", "^1.0.0")).toBe("1.3.0");
  });

  it("falls back to package-lock.json's `node_modules/<name>` entry", () => {
    const repo = repoWith({
      "package-lock.json": JSON.stringify({
        packages: { "": {}, "node_modules/left-pad": { version: "1.3.1" } },
      }),
    });
    expect(lockedVersion(repo, "left-pad", "^1.0.0")).toBe("1.3.1");
  });

  it("reads pnpm-lock.yaml's two-space `<name>@<version>` key", () => {
    const repo = repoWith({
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "packages:",
        // A scoped name has regex metacharacters in it; a nested key at a
        // deeper indent must not match.
        "  '@scope/thing@2.4.0':",
        "    resolution: {integrity: sha512-x}",
        "  left-pad@1.3.2:",
        "    resolution: {integrity: sha512-y}",
        "",
      ].join("\n"),
    });
    expect(lockedVersion(repo, "left-pad", "^1.0.0")).toBe("1.3.2");
  });

  it("falls back to the declared RANGE, stripped of its operator", () => {
    const repo = repoWith({ "package.json": "{}" });
    expect(lockedVersion(repo, "left-pad", "^1.3.0")).toBe("1.3.0");
    expect(lockedVersion(repo, "left-pad", "~2.0.0")).toBe("2.0.0");
    expect(lockedVersion(repo, "left-pad", ">=3.1.4")).toBe("3.1.4");
    // Nothing declared and nothing installed: there is no version to pack, and
    // guessing one would stage a library the PR does not use.
    expect(lockedVersion(repo, "left-pad", null)).toBeNull();
  });

  it("ignores an unparseable lockfile rather than throwing", () => {
    const repo = repoWith({
      "node_modules/left-pad/package.json": "{ not json",
      "package-lock.json": "{ also not json",
    });
    expect(lockedVersion(repo, "left-pad", "^1.3.0")).toBe("1.3.0");
  });
});

/**
 * `--stage` — the affordance fix, with a FAKE `npm` on `PATH`.
 *
 * The review workspace has no `node_modules`, so "open the library source" was
 * structurally impossible; staging turns it into a one-`read` action. A failure
 * here must degrade loudly and NEVER throw — a `deps` phase that exits non-zero
 * is re-dispatched every thirty minutes (§D12) over a library that could not be
 * fetched.
 *
 * Nothing below touches the network: the fake `npm` builds its own tarball with
 * the real `tar`, so the unpack half is exercised for real too.
 */
const NPM_PACK_OK = `#!/bin/sh
dest=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--pack-destination" ]; then dest="$arg"; fi
  prev="$arg"
done
work=$(mktemp -d)
mkdir -p "$work/package"
printf 'export const staged = true;\n' > "$work/package/index.js"
printf '{"name":"staged","version":"0.1.3"}\n' > "$work/package/package.json"
(cd "$work" && tar -czf "$dest/staged-0.1.3.tgz" package)
exit 0
`;

const NPM_PACK_404 = `#!/bin/sh
echo "npm warn using --force" >&2
echo "npm error code E404" >&2
echo "npm error 404 Not Found - GET https://registry.npmjs.org/nope" >&2
exit 1
`;

/** Exits clean and writes nothing — the shape a cache hit used to produce. */
const NPM_PACK_SILENT = `#!/bin/sh
exit 0
`;

/** A tarball that is not one, so the REAL `tar` is what fails. */
const NPM_PACK_CORRUPT = `#!/bin/sh
dest=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--pack-destination" ]; then dest="$arg"; fi
  prev="$arg"
done
printf 'this is not a gzip stream\\n' > "$dest/broken-0.1.3.tgz"
exit 0
`;

describe("deps — --stage, against a fake npm", () => {
  let fixture: Fixture;
  const scratch: string[] = [];
  const originalPath = process.env.PATH;

  beforeAll(() => {
    fixture = makeDepsFixture();
  });
  afterAll(() => {
    fixture.cleanup();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** Prepend a directory holding ONE fake binary; `tar` still resolves for real. */
  function withFakeNpm(script: string): string {
    const tool = makeFakeTool("npm", script);
    scratch.push(tool.dir);
    process.env.PATH = `${tool.dir}${delimiter}${originalPath ?? ""}`;
    const stageDir = mkdtempSync(join(tmpdir(), "ll-facts-stage-"));
    scratch.push(stageDir);
    return stageDir;
  }

  function stage(stageDir: string): DepsDocument {
    return runExtractor({
      extractor: "deps",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      stage: true,
      stageDir,
    }).document as unknown as DepsDocument;
  }

  it("unpacks the added dependency and records where it landed", () => {
    const stageDir = withFakeNpm(NPM_PACK_OK);
    const document = stage(stageDir);
    const added = document.changes.find((c) => c.name === "eslint-plugin-require-extensions");
    // `--strip-components=1`, so the tarball's `package/` prefix is gone and the
    // source sits directly under the staged directory — one `read` away.
    expect(added?.stagedAt).toBe(join(stageDir, "eslint-plugin-require-extensions"));
    expect(existsSync(join(added!.stagedAt!, "index.js"))).toBe(true);
    expect(readFileSync(join(added!.stagedAt!, "index.js"), "utf8")).toMatch(/staged = true/);
    expect(document.degraded.filter((d) => d.extractor === "deps")).toEqual([]);
  });

  it("degrades with npm's own last stderr line when `npm pack` exits non-zero", () => {
    const document = stage(withFakeNpm(NPM_PACK_404));
    expect(document.changes.every((c) => c.stagedAt === null)).toBe(true);
    const entry = document.degraded.find((d) => /npm pack .* failed/.test(d.reason));
    expect(entry?.reason).toMatch(/eslint-plugin-require-extensions@0\.1\.3/);
    // The LAST line, which is the one that says what went wrong.
    expect(entry?.reason).toMatch(/404 Not Found/);
    expect(entry?.reason).not.toMatch(/using --force/);
    expect(document.coverage).toBe("degraded");
  });

  it("degrades when `npm pack` succeeds but produces no tarball", () => {
    const document = stage(withFakeNpm(NPM_PACK_SILENT));
    expect(
      document.degraded.some((d) => /produced no tarball/.test(d.reason)),
      "exit 0 with nothing on disk is still a missing affordance",
    ).toBe(true);
    expect(document.changes.every((c) => c.stagedAt === null)).toBe(true);
  });

  it("degrades when the tarball cannot be unpacked", () => {
    const document = stage(withFakeNpm(NPM_PACK_CORRUPT));
    const entry = document.degraded.find((d) => /unpacking .* failed/.test(d.reason));
    expect(entry?.reason).toMatch(/eslint-plugin-require-extensions@0\.1\.3/);
    expect(document.changes.every((c) => c.stagedAt === null)).toBe(true);
  });

  it("stages nothing at all without the flag — `deps` is offline by default", () => {
    const stageDir = withFakeNpm(NPM_PACK_OK);
    const document = runExtractor({
      extractor: "deps",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      stageDir,
    }).document as unknown as DepsDocument;
    expect(document.changes.every((c) => c.stagedAt === null)).toBe(true);
    expect(existsSync(join(stageDir, "eslint-plugin-require-extensions"))).toBe(false);
  });
});

describe("deps — the degraded paths", () => {
  it("says `--stage is npm-only` for every other ecosystem rather than staging silently", () => {
    const fixture = makeGoFixture();
    try {
      const result = runExtractor({
        extractor: "deps",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
        stage: true,
      });
      const document = result.document as unknown as DepsDocument;
      // No network was touched, and the affordance being missing is a
      // DOCUMENTED fact rather than an empty `stagedAt` nobody can interpret.
      expect(document.changes.every((c) => c.stagedAt === null)).toBe(true);
      const reason = document.degraded.find((d) => /--stage is npm-only/.test(d.reason));
      expect(reason?.reason).toMatch(/go dependencies were NOT staged/);
      // ONE entry for the ecosystem, not one per package: a degraded list with
      // sixty identical lines in it is a list nobody reads.
      expect(document.degraded.filter((d) => /--stage is npm-only/.test(d.reason))).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("degrades loudly when a repo has no dependency manifest of any kind", () => {
    const fixture = makeFixture(
      "no-manifest",
      { message: "base", files: { "README.md": "# x\n", "main.c": "int main(){return 0;}\n" } },
      { message: "head", files: { "main.c": "int main(){return 1;}\n" } },
    );
    try {
      const document = deps(fixture);
      expect(document.manifests).toEqual([]);
      expect(document.changes).toEqual([]);
      const reason = document.degraded.find((d) => d.extractor === "deps");
      expect(reason?.reason).toMatch(/no dependency manifest at base or head/);
      // The sentence that keeps "clean" and "blind" apart.
      expect(reason?.reason).toMatch(/means unknown, not unchanged/);
    } finally {
      fixture.cleanup();
    }
  });
});
