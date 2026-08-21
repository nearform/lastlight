/**
 * Fixture repos — REAL git repos with two real commits, built in `beforeAll`.
 *
 * Not mocks, on purpose. Every extractor in this package is a claim about what
 * `git diff` and a type-checker say, and a mock of either would let the claim
 * be wrong while the test passed — which is the exact failure mode
 * (dependency-cruiser, green while seeing nothing) the whole package exists to
 * prevent. The repos are tiny, so the cost of being honest here is a second or
 * two.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Commit {
  message: string;
  /** Path → contents. A `null` deletes the file. */
  files: Record<string, string | null>;
}

export interface Fixture {
  dir: string;
  base: string;
  head: string;
  cleanup(): void;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function writeAll(dir: string, files: Record<string, string | null>): void {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    if (contents === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
}

/** Build a two-commit repo and return both SHAs. */
export function makeFixture(name: string, base: Commit, head: Commit): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `ll-facts-${name}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "fixture"]);

  writeAll(dir, base.files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", base.message]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]).trim();

  writeAll(dir, head.files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", head.message]);
  const headSha = git(dir, ["rev-parse", "HEAD"]).trim();

  return {
    dir,
    base: baseSha,
    head: headSha,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Add and commit more files on top of an existing fixture. */
export function commitMore(fixture: Fixture, files: Record<string, string | null>): string {
  writeAll(fixture.dir, files);
  git(fixture.dir, ["add", "-A"]);
  git(fixture.dir, ["commit", "-q", "-m", "more"]);
  return git(fixture.dir, ["rev-parse", "HEAD"]).trim();
}

export const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*", "test/**/*"],
  },
  null,
  2,
);

/**
 * THE HEADLINE FIXTURE — the `1587-r2` shape, made mechanical.
 *
 * `MAX_TOKEN_AGE` is declared once, referenced only on the CLIENT side, and
 * never compared server-side; `src/legacy/auth.ts` carries the same value
 * hard-coded, which is set `B \ A`. This is the one shape the investigation
 * ever converted into a posted Critical, so it is the regression guard for the
 * whole package.
 */
export function makeConstantFixture(): Fixture {
  return makeFixture(
    "constant",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-constant", version: "1.0.0" }, null, 2),
        "src/config.ts": `export const MAX_TOKEN_AGE = 3600;\nexport const APP_NAME = "fixture";\n`,
        "src/client/session.ts": `import { MAX_TOKEN_AGE } from "../config.js";\n\nexport function cookieMaxAge(): number {\n  return MAX_TOKEN_AGE;\n}\n`,
        "src/server/verify.ts": `export function verify(token: string): boolean {\n  return token.length > 0;\n}\n`,
        "src/legacy/auth.ts": `export function legacyExpiry(): number {\n  return 3600;\n}\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/config.ts": `export const MAX_TOKEN_AGE = 900;\nexport const APP_NAME = "fixture";\n`,
        // The PR updates the value in TWO places — the constant, and a copy
        // that never went through it. `B \\ A` is exactly this line.
        "src/legacy/auth.ts": `export function legacyExpiry(): number {\n  return 900;\n}\n`,
      },
    },
  );
}

/**
 * The cross-file contract change: `getUser` goes from `User | null` to `User`
 * plus a thrown `NotFoundError`, and the ONLY consumer is outside the diff.
 */
export function makeContractFixture(): Fixture {
  return makeFixture(
    "contract",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-contract", version: "1.0.0" }, null, 2),
        "src/user.ts": `export interface User {\n  id: string;\n}\n\nexport function getUser(id: string): User | null {\n  return id ? { id } : null;\n}\n`,
        "src/api/handler.ts": `import { getUser } from "../user.js";\n\nexport function handle(id: string): string {\n  const user = getUser(id);\n  return user ? user.id : "anonymous";\n}\n`,
        "test/user.test.ts": `import { getUser } from "../src/user.js";\n\nexport const probe = getUser("a");\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/user.ts": `export interface User {\n  id: string;\n}\n\nexport class NotFoundError extends Error {}\n\nexport function getUser(id: string): User {\n  if (!id) throw new NotFoundError(id);\n  return { id };\n}\n`,
      },
    },
  );
}

/** A barrel re-export chain, so `findReferences` has to cross two files. */
export function makeBarrelFixture(): Fixture {
  return makeFixture(
    "barrel",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-barrel", version: "1.0.0" }, null, 2),
        "src/core/limits.ts": `export function rateLimit(n: number): number {\n  return n;\n}\n`,
        "src/index.ts": `export { rateLimit } from "./core/limits.js";\n`,
        "src/consumer.ts": `import { rateLimit } from "./index.js";\n\nexport const applied = rateLimit(5);\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/core/limits.ts": `export function rateLimit(n: number, burst = 0): number {\n  return n + burst;\n}\n`,
      },
    },
  );
}

/** A dependency bump plus the `createRequire(...)("pkg")` load pattern. */
export function makeDepsFixture(): Fixture {
  return makeFixture(
    "deps",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify(
          {
            name: "fixture-deps",
            version: "1.0.0",
            dependencies: { "left-pad": "^1.3.0" },
            devDependencies: { eslint: "^8.0.0" },
          },
          null,
          2,
        ),
        "src/lint.ts": `export const rules = [];\n`,
      },
    },
    {
      message: "head",
      files: {
        "package.json": JSON.stringify(
          {
            name: "fixture-deps",
            version: "1.0.0",
            dependencies: { "left-pad": "^1.3.0", "eslint-plugin-require-extensions": "^0.1.3" },
            devDependencies: { eslint: "^9.0.0" },
          },
          null,
          2,
        ),
        "src/lint.ts": `import { createRequire } from "node:module";\n\nconst plugin = createRequire(import.meta.url)("eslint-plugin-require-extensions");\n\nexport const rules = [plugin];\n`,
      },
    },
  );
}

/** No TypeScript or JavaScript at all — tier 3. */
export function makeNonTsFixture(): Fixture {
  return makeFixture(
    "nonts",
    {
      message: "base",
      files: {
        "main.py": `def add(a, b):\n    return a + b\n`,
        "README.md": "# fixture\n",
      },
    },
    {
      message: "head",
      files: { "main.py": `def add(a, b):\n    return a - b\n` },
    },
  );
}

/** A tsconfig that is not valid JSON — the tier-2 degradation path. */
export function makeBrokenTsConfigFixture(): Fixture {
  return makeFixture(
    "broken",
    {
      message: "base",
      files: {
        "tsconfig.json": `{ "compilerOptions": { "strict": true `,
        "package.json": JSON.stringify({ name: "fixture-broken", version: "1.0.0" }, null, 2),
        "src/a.ts": `export const LIMIT = 10;\n`,
      },
    },
    {
      message: "head",
      files: { "src/a.ts": `export const LIMIT = 25;\n` },
    },
  );
}

/**
 * A fake tool on `PATH`, for the binary-backed tier. It prints exactly what the
 * real tool prints, so the adapter is exercised on real-shaped output rather
 * than on a stub of our own normaliser.
 */
export function makeFakeTool(name: string, script: string): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), `ll-facts-bin-${name}-`));
  const bin = join(dir, name);
  writeFileSync(bin, script, { encoding: "utf8", mode: 0o755 });
  return { dir, bin };
}
