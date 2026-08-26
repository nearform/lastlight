/**
 * `prepare` — WP4's affordance.
 *
 * Two halves, split on purpose. Detection, the `env.json` contract and every
 * loudness rule run against REAL repos, because they are claims about what is
 * on disk. The package manager's own behaviour — what `npm ci` does with a
 * lockfile that has drifted, how long an install takes, whether a registry is
 * reachable — is behind the injected {@link ExecFn}, because a unit test that
 * shells out to a registry is a test of the network and would be the flakiest
 * thing in this suite.
 *
 * The rule under test throughout: **a step that could not run and a step that
 * ran and found nothing must never produce the same JSON.**
 */
import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PACKAGE_MANAGERS,
  detectPackageManager,
  envFor,
  parseTscDiagnostics,
  prepareTree,
  resolveCoverageCommand,
  type ExecFn,
  type ExecResult,
} from "../src/prepare.js";
import { ProbeEnvSchema } from "../src/schema.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A bare directory with the files a case needs. Not a git repo — `prepare`
 * makes no claim about a commit range, so it must not need one. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ll-prepare-"));
  dirs.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

const ok: ExecResult = { status: 0, stdout: "", stderr: "", timedOut: false };
const failed: ExecResult = { status: 1, stdout: "", stderr: "ENOENT lockfile drift", timedOut: false };

/** Records what it was asked to run, and answers from a script. */
function fakeExec(answers: ExecResult[] | ((cmd: string, args: string[]) => ExecResult)): {
  exec: ExecFn;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  let index = 0;
  const exec: ExecFn = (command, args) => {
    calls.push({ command, args });
    return typeof answers === "function" ? answers(command, args) : (answers[index++] ?? ok);
  };
  return { exec, calls };
}

describe("detectPackageManager — corepack's order of authority", () => {
  it("prefers what the repo DECLARED over what its lockfiles imply", () => {
    const repo = tree({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }),
      "package-lock.json": "{}",
    });
    expect(detectPackageManager(repo)).toBe("pnpm");
  });

  it("falls back to the lockfile, most specific first", () => {
    // A stale `package-lock.json` beside a live `pnpm-lock.yaml` is an ordinary
    // state in a repo that migrated; reading it as npm would install a tree the
    // repo does not use.
    const repo = tree({ "package.json": "{}", "pnpm-lock.yaml": "", "package-lock.json": "{}" });
    expect(detectPackageManager(repo)).toBe("pnpm");
  });

  it("defaults to npm for a package.json with no lockfile at all", () => {
    expect(detectPackageManager(tree({ "package.json": "{}" }))).toBe("npm");
  });

  it("answers null — not npm — when there is no npm project", () => {
    // A Java or Go PR. `null` is the correct answer and must not read as a
    // failure: locked decision 14 is TypeScript-first, deliberately.
    expect(detectPackageManager(tree({ "pom.xml": "<project/>" }))).toBeNull();
  });

  it("ignores an unparseable package.json rather than throwing", () => {
    const repo = tree({ "package.json": "{ not json", "yarn.lock": "" });
    expect(detectPackageManager(repo)).toBe("yarn");
  });
});

describe("install", () => {
  it("does not install when node_modules is already there — the warm re-review path", () => {
    const repo = tree({ "package.json": "{}", "node_modules/.keep": "" });
    const { exec, calls } = fakeExec([]);
    const env = prepareTree({ repo, install: true, exec });

    expect(env.install).toBe("already-present");
    expect(env.installed).toBe(true);
    expect(calls).toHaveLength(0);
    expect(env.degraded).toHaveLength(0);
  });

  it("runs the STRICT install first, and does not run the loose one when it works", () => {
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { exec, calls } = fakeExec([ok]);
    prepareTree({ repo, install: true, exec });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm");
    expect(calls[0].args).toContain("ci");
  });

  it("makes the fallback ACTUALLY loose, per manager — measured on cal-com-10600", () => {
    // A fallback bit-identical to the thing it falls back from is a second copy
    // of the failure. yarn Berry and pnpm both read `CI` — which `envFor` sets —
    // and turn immutable installs ON, so a bare `yarn install` re-failed with
    // `YN0028: The lockfile would have been modified` and reported `failed` on a
    // tree that would have installed fine.
    for (const spec of PACKAGE_MANAGERS) {
      expect(spec.loose.join(" "), spec.id).not.toBe(spec.strict.join(" "));
    }
    const yarn = PACKAGE_MANAGERS.find((s) => s.id === "yarn")!;
    expect(yarn.loose).toEqual(["install", "--no-immutable"]);
    const pnpm = PACKAGE_MANAGERS.find((s) => s.id === "pnpm")!;
    expect(pnpm.loose).toEqual(["install", "--no-frozen-lockfile"]);
  });

  it("falls back to a loose install when the lockfile has drifted — and SAYS SO", () => {
    // Routine on a PR that edits dependencies, i.e. exactly the PRs `deps`
    // cares most about. The fallback is fine; silently resolving different
    // versions than the lockfile pins is not.
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { exec, calls } = fakeExec([failed, ok]);
    const env = prepareTree({ repo, install: true, exec });

    expect(calls.map((c) => c.args[0])).toEqual(["ci", "install"]);
    expect(env.install).toBe("installed");
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/NOT the lockfile's/);
  });

  it("records a failed install as a FACT, never as a throw", () => {
    // §D12: a phase that fails hard is re-dispatched by cron-review.yaml every
    // thirty minutes, forever. `prepare` may not be the thing that does that.
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { exec } = fakeExec([failed, failed]);
    const env = prepareTree({ repo, install: true, exec });

    expect(env.install).toBe("failed");
    expect(env.installed).toBe(false);
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/NOTHING downstream may read a thin result/);
  });

  it("records a timeout as a failure with the reason, not as a clean skip", () => {
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const timeout: ExecResult = { status: null, stdout: "", stderr: "", timedOut: true };
    const { exec, calls } = fakeExec([timeout]);
    const env = prepareTree({ repo, install: true, exec });

    // A timeout must NOT trigger the drift fallback — the lockfile is not the
    // problem and a second 300-second install would double the phase's cost.
    expect(calls).toHaveLength(1);
    expect(env.install).toBe("failed");
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/timed out/);
  });

  it("names the affordance gap when there is no npm project at all", () => {
    const repo = tree({ "pom.xml": "<project/>" });
    const env = prepareTree({ repo, install: true, exec: fakeExec([]).exec });

    expect(env.install).toBe("no-project");
    expect(env.packageManager).toBeNull();
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/extends.*bare package specifier/s);
  });

  it("reads `installed` off the filesystem, not off the exit code", () => {
    // A failed install can still leave a partly-populated tree, and the only
    // question a downstream phase has is whether the files are there.
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { exec } = fakeExec(() => {
      mkdirSync(join(repo, "node_modules"), { recursive: true });
      return failed;
    });
    const env = prepareTree({ repo, install: true, exec });

    expect(env.install).toBe("failed");
    expect(env.installed).toBe(true);
  });
});

describe("lifecycle scripts are off unless asked for", () => {
  it("passes --ignore-scripts by default", () => {
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { exec, calls } = fakeExec([ok]);
    const env = prepareTree({ repo, install: true, exec });

    expect(calls[0].args).toContain("--ignore-scripts");
    expect(env.lifecycleScripts).toBe(false);
  });

  it("drops the flag when a caller opts in, and records that it did", () => {
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { exec, calls } = fakeExec([ok]);
    const env = prepareTree({ repo, install: true, lifecycleScripts: true, exec });

    expect(calls[0].args).not.toContain("--ignore-scripts");
    expect(env.lifecycleScripts).toBe(true);
  });

  it("covers yarn through the environment, which has no reliable flag", () => {
    // Yarn 1 takes `--ignore-scripts`; Berry does not. A guarantee that depends
    // on which yarn a repo pinned is not a guarantee.
    expect(envFor(false).YARN_ENABLE_SCRIPTS).toBe("false");
    expect(envFor(false).npm_config_ignore_scripts).toBe("true");
    expect(envFor(true).YARN_ENABLE_SCRIPTS).toBeUndefined();
    expect(envFor(true).npm_config_ignore_scripts).toBeUndefined();
  });
});

describe("the environment stops an install from waiting on a human", () => {
  it("silences Corepack's download prompt — measured on cal-com-10600, not guessed", () => {
    // The FIRST real corpus case failed both installs with "! Corepack is about
    // to download https://repo.yarnpkg.com/3.4.1/…". `CI=1` does not silence
    // that one, and a repo that pins its manager through `packageManager` — the
    // field `detectPackageManager` reads first, and the shape of every monorepo
    // this phase exists for — cannot install at all without it.
    for (const scripts of [true, false]) {
      expect(envFor(scripts).COREPACK_ENABLE_DOWNLOAD_PROMPT, String(scripts)).toBe("0");
      expect(envFor(scripts).CI, String(scripts)).toBe("1");
    }
  });
});

describe("typecheck — diagnostics, not a CI re-run", () => {
  it("is `unavailable`, never `clean`, when there is no compiler in the tree", () => {
    // The failure with money on it: an empty diagnostic list from a compiler
    // that never ran reads exactly like a clean typecheck.
    const repo = tree({ "package.json": "{}", "tsconfig.json": "{}", "node_modules/.keep": "" });
    const env = prepareTree({ repo, install: false, typecheck: true, exec: fakeExec([]).exec });

    expect(env.typecheck).toBe("unavailable");
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/NOT a clean typecheck/);
  });

  it("is `unavailable` when there is no root tsconfig", () => {
    const repo = tree({
      "package.json": "{}",
      "node_modules/typescript/bin/tsc": "",
    });
    const env = prepareTree({ repo, install: false, typecheck: true, exec: fakeExec([]).exec });
    expect(env.typecheck).toBe("unavailable");
  });

  it("records per-file, per-line diagnostics — the only reason to run it locally", () => {
    const repo = tree({
      "package.json": "{}",
      "tsconfig.json": "{}",
      "node_modules/typescript/bin/tsc": "",
    });
    const { exec } = fakeExec([
      {
        status: 2,
        stdout: [
          "src/auth.ts(73,11): error TS2345: Argument of type 'string' is not assignable.",
          "src/auth.ts(74,3): error TS2532: Object is possibly 'undefined'.",
          "Found 2 errors in 1 file.",
        ].join("\n"),
        stderr: "",
        timedOut: false,
      },
    ]);
    const env = prepareTree({ repo, install: false, typecheck: true, exec });

    expect(env.typecheck).toBe("errors");
    expect(env.typecheckDiagnostics).toEqual([
      { file: "src/auth.ts", line: 73, code: "TS2345", message: "Argument of type 'string' is not assignable." },
      { file: "src/auth.ts", line: 74, code: "TS2532", message: "Object is possibly 'undefined'." },
    ]);
    // A repo whose head does not typecheck is a fact about the PR — CI already
    // said so — not a degradation of this phase.
    expect(env.degraded).toHaveLength(0);
  });

  it("distinguishes a compiler that crashed from one that found nothing", () => {
    const repo = tree({
      "package.json": "{}",
      "tsconfig.json": "{}",
      "node_modules/typescript/bin/tsc": "",
    });
    const { exec } = fakeExec([{ status: null, stdout: "", stderr: "", timedOut: true }]);
    const env = prepareTree({ repo, install: false, typecheck: true, exec });

    expect(env.typecheck).toBe("failed");
    expect(env.typecheckDiagnostics).toEqual([]);
  });

  it("ignores warnings and the summary line", () => {
    expect(
      parseTscDiagnostics(
        [
          "src/a.ts(1,1): warning TS0000: nope",
          "Found 0 errors.",
          "src/b.ts(9,2): error TS1005: ';' expected.",
        ].join("\n"),
      ),
    ).toEqual([{ file: "src/b.ts", line: 9, code: "TS1005", message: "';' expected." }]);
  });
});

describe("coverage — the one step that runs a suite", () => {
  it("is skipped entirely unless asked for", () => {
    const repo = tree({ "package.json": "{}" });
    const env = prepareTree({ repo, install: false, exec: fakeExec([]).exec });
    expect(env.coverage).toBe("skipped");
    expect(env.degraded).toHaveLength(0);
  });

  it("refuses to GUESS a command, and says the tests family was not measured", () => {
    // Guessing `npm test -- --coverage` would run the whole suite on a repo
    // that never asked, produce nothing, and cost fifteen minutes — after which
    // "no command" and "no artifact" would be the same row.
    const repo = tree({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const { exec, calls } = fakeExec([]);
    const env = prepareTree({ repo, install: false, coverage: true, exec });

    expect(calls).toHaveLength(0);
    expect(env.coverage).toBe("unavailable");
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/NOT MEASURED/);
  });

  it("uses a script the repo itself named", () => {
    const repo = tree({ "package.json": JSON.stringify({ scripts: { "test:coverage": "vitest --coverage" } }) });
    expect(resolveCoverageCommand(repo, undefined, "pnpm")).toBe("pnpm run test:coverage");
  });

  it("reports `produced` only when an artifact the extractor can READ exists", () => {
    const repo = tree({ "package.json": JSON.stringify({ scripts: { coverage: "x" } }) });
    const { exec } = fakeExec(() => {
      mkdirSync(join(repo, "coverage"), { recursive: true });
      writeFileSync(join(repo, "coverage", "lcov.info"), "SF:src/a.ts\nDA:1,1\nend_of_record\n");
      return ok;
    });
    const env = prepareTree({ repo, install: false, coverage: true, exec });

    expect(env.coverage).toBe("produced");
    expect(env.coverageReport).toBe("coverage/lcov.info");
    expect(env.degraded).toHaveLength(0);
  });

  it("reports `absent` — loudly — when the command ran and produced nothing", () => {
    // This is what stands between the `tests` family and "well tested".
    const repo = tree({ "package.json": JSON.stringify({ scripts: { coverage: "x" } }) });
    const env = prepareTree({ repo, install: false, coverage: true, exec: fakeExec([ok]).exec });

    expect(env.coverage).toBe("absent");
    expect(env.coverageReport).toBeNull();
    expect(env.degraded.map((d) => d.reason).join(" ")).toMatch(/NOT MEASURED/);
  });

  it("keeps the artifact from a RED suite — coverage needs no green baseline", () => {
    // The whole reason coverage replaced `mutants` (§D13): a mutation run needs
    // something green to mutate against, and a coverage run does not.
    const repo = tree({ "package.json": JSON.stringify({ scripts: { coverage: "x" } }) });
    const { exec } = fakeExec(() => {
      mkdirSync(join(repo, "coverage"), { recursive: true });
      writeFileSync(join(repo, "coverage", "lcov.info"), "SF:src/a.ts\nDA:1,0\nend_of_record\n");
      return { status: 1, stdout: "", stderr: "3 tests failed", timedOut: false };
    });
    const env = prepareTree({ repo, install: false, coverage: true, exec });

    expect(env.coverage).toBe("produced");
    expect(env.coverageReport).toBe("coverage/lcov.info");
  });
});

describe("the env.json contract", () => {
  /**
   * The field list, pinned as a literal on BOTH sides of an edge that does not
   * exist.
   *
   * `apps/server` has no dependency on this package — the CLI is invoked as a
   * process, resolved through `LASTLIGHT_FACTS_BIN`, which is what lets the eval
   * harness measure the pipeline on a host that has never seen the sandbox
   * image. So `pr-review.yaml`'s shell fallback hand-writes this document, and
   * `apps/server/tests/workflows/pr-review-probes.test.ts` pins the same list.
   * ADDING A FIELD HERE MEANS EDITING THAT `printf` TOO: a fallback missing a
   * field is only ever reached when something has already gone wrong, which is
   * the worst moment to find out.
   */
  it("carries exactly the fields pr-review.yaml's fallback hand-writes", () => {
    const repo = tree({ "package.json": "{}", "node_modules/.keep": "" });
    const env = prepareTree({ repo, install: true, exec: fakeExec([]).exec });
    expect(Object.keys(env).sort()).toEqual(
      [
        "version",
        "generatedAt",
        "repo",
        "packageManager",
        "install",
        "installed",
        "lifecycleScripts",
        "typecheck",
        "typecheckDiagnostics",
        "coverage",
        "coverageReport",
        "durationMs",
        "degraded",
      ].sort(),
    );
  });

  it("validates against its own schema on every path, including the failures", () => {
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const env = prepareTree({ repo, install: true, typecheck: true, coverage: true, exec: fakeExec([failed, failed]).exec });
    expect(() => ProbeEnvSchema.parse(env)).not.toThrow();
  });

  it("times every step separately, so `prepare` cannot hide which one was slow", () => {
    const repo = tree({ "package.json": "{}", "node_modules/.keep": "" });
    const env = prepareTree({ repo, install: true, exec: fakeExec([]).exec });
    expect(env.durationMs.total).toBeGreaterThanOrEqual(0);
    expect(env.durationMs.install).toBe(0);
  });

  it("writes nothing to the tree by itself", () => {
    // `prepare` is allowed to install; it is not allowed to leave artifacts in
    // the checkout the agent then reviews.
    const repo = tree({ "package.json": "{}", "node_modules/.keep": "" });
    prepareTree({ repo, install: true, exec: fakeExec([]).exec });
    expect(existsSync(join(repo, ".lastlight"))).toBe(false);
  });
});
