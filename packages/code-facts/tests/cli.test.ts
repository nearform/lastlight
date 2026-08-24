/**
 * `lastlight-facts` on a command line.
 *
 * `runCli` RETURNS its exit code rather than calling `process.exit`, precisely
 * so this file needs no subprocess — and the flags below are therefore asserted
 * THROUGH THE EMITTED DOCUMENT rather than by watching what `runExtractor` was
 * called with. A test that asserts "the flag reached the option object" passes
 * happily while the option means nothing downstream; a test that reads the
 * document cannot.
 *
 * `console.*` is legal in `cli.ts` and nowhere else in this package, which is
 * the other reason the `io` seam exists: the terminal writer is injected, so
 * the CLI's own output is a value here rather than a side effect.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConstantFixture, makeFakeTool, type Fixture } from "./helpers.js";
import { parseArgv, runCli } from "../src/cli.js";
import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE } from "../src/errors.js";
import { ProbeEnvSchema } from "../src/schema.js";
import type { CoverageDocument, FactsDocument, PatternsDocument } from "../src/schema.js";

/** Collect what the CLI wrote, keeping the two streams apart. */
function capture(): { out: string[]; err: string[]; io: { out: (s: string) => void; err: (s: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

describe("parseArgv", () => {
  it("accepts `--flag value` and `--flag=value` alike", () => {
    expect(parseArgv(["facts", "--base", "main"])).toEqual({
      command: "facts",
      flags: { base: "main" },
    });
    expect(parseArgv(["facts", "--base=main"])).toEqual({
      command: "facts",
      flags: { base: "main" },
    });
    // An `=` inside the VALUE survives — `--sides client=web/,server=api/`.
    expect(parseArgv(["constants", "--sides=client=web/"]).flags.sides).toBe("client=web/");
  });

  it("treats the declared boolean flags as booleans, not as value-takers", () => {
    const parsed = parseArgv(["facts", "--never-fail", "--stage", "--base", "main"]);
    expect(parsed.flags["never-fail"]).toBe(true);
    expect(parsed.flags.stage).toBe(true);
    // The flag AFTER a boolean is still a flag, not that boolean's value.
    expect(parsed.flags.base).toBe("main");
  });

  /**
   * A value that begins with `-` must not be swallowed. Silently consuming the
   * NEXT ARGUMENT as a value is how `--out --never-fail` would write a file
   * called `--never-fail` and quietly drop the wrapper that keeps the 30-minute
   * re-dispatch loop shut (§D12).
   */
  it("does not swallow a following argument that begins with `-`", () => {
    const parsed = parseArgv(["facts", "--out", "--never-fail", "--base", "main"]);
    expect(parsed.flags.out).toBe(true);
    expect(parsed.flags["never-fail"]).toBe(true);
    expect(parsed.flags.base).toBe("main");
    // The explicit form is how a caller genuinely passes a leading-dash value.
    expect(parseArgv(["facts", "--base=-5"]).flags.base).toBe("-5");
  });

  it("leaves a trailing flag with no value as `true`", () => {
    expect(parseArgv(["facts", "--out"]).flags.out).toBe(true);
  });

  it("takes the FIRST positional as the command and ignores the rest", () => {
    expect(parseArgv(["facts", "contracts", "all"]).command).toBe("facts");
    expect(parseArgv([]).command).toBe("");
    expect(parseArgv(["--base", "main"]).command).toBe("");
  });
});

describe("the informational commands", () => {
  it("`--version` prints its own version, the compiler PATH and the toolchain stamp", () => {
    const { out, io } = capture();
    expect(runCli(["--version"], io)).toBe(EXIT_OK);
    const printed = JSON.parse(out.join("\n")) as {
      "lastlight-code-facts": string;
      compiler: {
        version: string;
        modulePath: string;
        platformPackage: string | null;
        executable: string | null;
      };
      toolchain: { manifest: number; binaries: Record<string, unknown> };
    };
    expect(printed["lastlight-code-facts"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(printed.compiler.version).toMatch(/^\d+\.\d+/);
    // The path is the load-bearing half: the compiler must come from THIS
    // package's tree, never from the repo under review (`compiler-isolation`).
    expect(printed.compiler.modulePath).toMatch(/node_modules[/\\]typescript[/\\]package\.json$/);
    // And the per-platform sidecar, because only the matching one installs: a
    // `typescript` that imports with no executable behind it is the shape a
    // wrong-platform image produces, and "which compiler produced this?" has to
    // stay answerable from the stamp alone.
    expect(printed.compiler.platformPackage).toMatch(
      new RegExp(`typescript-${process.platform}-${process.arch}$`),
    );
    expect(printed.compiler.executable).toMatch(/[/\\](?:tsc|tsgo)(?:\.exe)?$/);
    expect(printed.toolchain.manifest).toBe(2);
    expect(Object.keys(printed.toolchain.binaries).length).toBeGreaterThan(0);
  });

  it("`toolchain` prints the pinned manifest AND what actually resolved", () => {
    const { out, io } = capture();
    expect(runCli(["toolchain"], io)).toBe(EXIT_OK);
    const printed = JSON.parse(out.join("\n")) as {
      manifest: { version: number; binaries: Record<string, { version: string; sources: unknown }> };
      resolved: { binaries: Record<string, { status: string; expected: string | null }> };
    };
    expect(printed.manifest.version).toBe(2);
    for (const [name, entry] of Object.entries(printed.manifest.binaries)) {
      // The manifest half is what SHOULD be there; the resolved half is what is.
      expect(printed.resolved.binaries[name].expected, name).toBe(entry.version);
      expect(printed.resolved.binaries[name].status, name).toMatch(/^(ok|mismatch|missing|unprobed)$/);
    }
  });

  it("`--help` with a command exits 0; with no command it exits 2", () => {
    const withCommand = capture();
    expect(runCli(["facts", "--help"], withCommand.io)).toBe(EXIT_OK);
    expect(withCommand.out.join("\n")).toMatch(/Usage:/);

    // No command is a USAGE ERROR, not a request for help — the difference is
    // what a script that shelled out incorrectly reads.
    const bare = capture();
    expect(runCli(["--help"], bare.io)).toBe(EXIT_UNAVAILABLE);
    expect(bare.out.join("\n")).toMatch(/Usage:/);
    expect(runCli([], capture().io)).toBe(EXIT_UNAVAILABLE);
  });

  it("names the legal command set on stderr for an unknown command", () => {
    const { out, err, io } = capture();
    expect(runCli(["fatcs", "--base", "main"], io)).toBe(EXIT_UNAVAILABLE);
    expect(out).toEqual([]);
    const message = err.join("\n");
    expect(message).toMatch(/unknown command "fatcs"/);
    for (const command of ["facts", "contracts", "constants", "deps", "patterns", "coverage", "all", "toolchain"]) {
      expect(message, command).toContain(command);
    }
  });

  it("refuses to run without --base rather than guessing one", () => {
    const { err, io } = capture();
    expect(runCli(["facts"], io)).toBe(EXIT_UNAVAILABLE);
    expect(err.join("\n")).toMatch(/--base <ref> is required/);
  });
});

/**
 * FLAG PLUMBING, asserted through the document.
 *
 * One fixture, reused: each of these is a full extraction, and the point of
 * every assertion below is a field in the output rather than a call argument.
 */
describe("the flags reach the extraction", () => {
  let fixture: Fixture;
  const scratch: string[] = [];

  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => {
    fixture.cleanup();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function run(argv: string[]): { code: number; out: string; err: string } {
    const { out, err, io } = capture();
    const code = runCli([...argv, "--repo", fixture.dir, "--base", fixture.base, "--head", fixture.head], io);
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  /**
   * `--max-references` caps the recorded SITES and leaves `referenceCount`
   * truthful. The divergence IS the contract: a capped list beside a count that
   * matched it would say "this symbol has one consumer", and a symbol whose
   * references are mostly outside the diff is the whole reason `facts` exists.
   */
  it("`--max-references 1` caps references[] while referenceCount stays truthful", () => {
    const uncapped = JSON.parse(run(["facts"]).out) as FactsDocument;
    const before = uncapped.symbols.find((s) => s.name === "MAX_TOKEN_AGE");
    expect(before?.references.length, "the fixture must have more than one reference").toBeGreaterThan(1);

    const capped = JSON.parse(run(["facts", "--max-references", "1"]).out) as FactsDocument;
    const after = capped.symbols.find((s) => s.name === "MAX_TOKEN_AGE");
    expect(after?.references).toHaveLength(1);
    expect(after?.referenceCount).toBe(before?.referenceCount);
    expect(after?.referenceCount).toBeGreaterThan(1);
  });

  it("`--tsconfig` at a path that does not exist degrades and NAMES the path", () => {
    const { code, out } = run(["facts", "--tsconfig", join(fixture.dir, "nope.tsconfig.json")]);
    const document = JSON.parse(out) as FactsDocument;
    expect(code).not.toBe(EXIT_OK);
    expect(document.coverage).toBe("degraded");
    expect(
      document.degraded.some((d) => d.reason.includes("nope.tsconfig.json")),
      "a forced tsconfig that could not be loaded must name itself",
    ).toBe(true);
  });

  it("`--rules` at a path that does not exist degrades and NAMES the path", () => {
    // opengrep is absent on a developer Mac, and the missing-binary branch
    // short-circuits before the ruleset is ever looked at — so the flag can only
    // be exercised with something resolvable behind it.
    const opengrep = makeFakeTool("opengrep", `#!/bin/sh\necho '{"results":[],"errors":[]}'\n`);
    scratch.push(opengrep.dir);
    const missing = join(fixture.dir, "no-such-rules.yaml");
    process.env.LASTLIGHT_OPENGREP_BIN = opengrep.bin;
    try {
      const { out } = run(["patterns", "--rules", missing]);
      const document = JSON.parse(out) as PatternsDocument;
      const entry = document.degraded.find((d) => d.reason.includes(missing));
      expect(entry, "an unreadable ruleset must not read as `no findings`").toBeDefined();
      expect(entry?.reason).toMatch(/does not exist/);
      expect(document.findings).toEqual([]);
      expect(document.coverage).toBe("degraded");
    } finally {
      delete process.env.LASTLIGHT_OPENGREP_BIN;
    }
  });

  it("`--report` beats the default candidate list", () => {
    mkdirSync(join(fixture.dir, "coverage"), { recursive: true });
    // A DEFAULT candidate, sitting right where the extractor would look.
    writeFileSync(
      join(fixture.dir, "coverage", "lcov.info"),
      "SF:src/config.ts\nDA:1,9\nend_of_record\n",
      "utf8",
    );
    // …and the one the caller actually named, disagreeing with it.
    mkdirSync(join(fixture.dir, "artifacts"), { recursive: true });
    writeFileSync(
      join(fixture.dir, "artifacts", "named.info"),
      "SF:src/config.ts\nDA:1,0\nend_of_record\n",
      "utf8",
    );

    const document = JSON.parse(run(["coverage", "--report", "artifacts/named.info"]).out) as CoverageDocument;
    expect(document.report).toBe("artifacts/named.info");
    // Read from the named artifact, which says the line is UNCOVERED; the
    // default candidate says it ran nine times.
    expect(document.files.find((f) => f.path === "src/config.ts")?.uncoveredChangedLines).toEqual([1]);

    // The pin without the flag: the same repo defaults back to the candidate.
    const fallback = JSON.parse(run(["coverage"]).out) as CoverageDocument;
    expect(fallback.report).toBe("coverage/lcov.info");
    expect(fallback.files.find((f) => f.path === "src/config.ts")?.uncoveredChangedLines).toEqual([]);

    rmSync(join(fixture.dir, "coverage"), { recursive: true, force: true });
    rmSync(join(fixture.dir, "artifacts"), { recursive: true, force: true });
  });

  it("`--out` writes into a directory that does not exist yet, and prints nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ll-facts-cli-out-"));
    scratch.push(dir);
    const target = join(dir, "deep", "nested", "facts.json");
    const { code, out } = run(["facts", "--out", target]);
    expect(code).toBe(EXIT_OK);
    // stdout is for the document; with `--out` there is nothing to print, and a
    // caller piping the file must not also get a copy on the pipe.
    expect(out).toBe("");
    const written = JSON.parse(readFileSync(target, "utf8")) as FactsDocument;
    expect(written.symbols.some((s) => s.name === "MAX_TOKEN_AGE")).toBe(true);
  });
});

/**
 * `prepare` — WP4. The branching lives in `tests/prepare.test.ts`; what is
 * asserted here is the CLI contract, because that is what a workflow phase
 * actually invokes.
 */
describe("the `prepare` command", () => {
  const trees: string[] = [];
  afterAll(() => {
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ll-facts-prepare-cli-"));
    trees.push(dir);
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), contents, "utf8");
    }
    return dir;
  }

  it("needs no --base: it makes no claim about a commit range", () => {
    // Every other command refuses without one. `prepare` analyses nothing, so
    // demanding a range would be asking for an answer it never gives.
    const repo = tree({ "package.json": "{}", "node_modules/.keep": "" });
    const { io, out } = capture();
    expect(runCli(["prepare", "--repo", repo], io)).toBe(EXIT_OK);
    expect(JSON.parse(out.join("\n")).install).toBe("already-present");
  });

  it("exits 3 when something degraded, so a human reading the code learns it", () => {
    const repo = tree({ "pom.xml": "<project/>" });
    const { io } = capture();
    expect(runCli(["prepare", "--repo", repo], io)).toBe(EXIT_DEGRADED);
  });

  it("`--never-fail` flattens that to 0 — §D12, the 30-minute re-dispatch loop", () => {
    const repo = tree({ "pom.xml": "<project/>" });
    const { io } = capture();
    expect(runCli(["prepare", "--repo", repo, "--never-fail"], io)).toBe(EXIT_OK);
  });

  it("`--no-install` reports the tree without touching it", () => {
    const repo = tree({ "package.json": "{}", "package-lock.json": "{}" });
    const { io, out } = capture();
    expect(runCli(["prepare", "--repo", repo, "--no-install"], io)).toBe(EXIT_OK);
    const env = JSON.parse(out.join("\n"));
    expect(env.install).toBe("skipped");
    expect(env.installed).toBe(false);
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
  });

  it("`--out` writes env.json into a directory that does not exist yet", () => {
    const repo = tree({ "package.json": "{}", "node_modules/.keep": "" });
    const target = join(repo, ".lastlight", "pr-review", "probes", "env.json");
    const { io, out } = capture();
    expect(runCli(["prepare", "--repo", repo, "--out", target], io)).toBe(EXIT_OK);
    expect(out.join("")).toBe("");
    expect(ProbeEnvSchema.parse(JSON.parse(readFileSync(target, "utf8")))).toBeTruthy();
  });
});

/**
 * `seed --contract` — the CONTROL arm's one entry point.
 *
 * Asserted THROUGH THE EMITTED DOCUMENT and the emitted BLOCKS, per this file's
 * opening note: a test that watched the option object reach `seedObligations`
 * would pass while the block on disk still said `full`, and the block on disk is
 * the only thing a survey ever reads.
 */
describe("`seed --contract`", () => {
  const trees: string[] = [];
  afterAll(() => {
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal `all` envelope with one constant, so a family has an obligation. */
  function factsTree(): { dir: string; facts: string } {
    const dir = mkdtempSync(join(tmpdir(), "ll-facts-seed-cli-"));
    trees.push(dir);
    const facts = join(dir, "facts.json");
    writeFileSync(
      facts,
      JSON.stringify({
        version: 2,
        generatedAt: "2026-08-23T00:00:00.000Z",
        extractor: "all",
        repo: "acme/widgets",
        baseSha: "b".repeat(40),
        headSha: "h".repeat(40),
        tier: 1,
        engine: "tsgo",
        languages: [],
        coverage: "full",
        degraded: [],
        toolchain: { manifest: 2, bundled: {}, binaries: {} },
        extractors: {
          constants: {
            sideDefinitions: {},
            constants: [
              {
                constant: "MAX_TOKEN_AGE",
                declaredAt: "src/config.ts:12",
                value: "900",
                valueKind: "number",
                references: ["src/server/auth.ts:73"],
                hardCodedDuplicates: [],
                sides: null,
              },
            ],
          },
        },
      }),
      "utf8",
    );
    return { dir, facts };
  }

  const seedInto = (dir: string, facts: string, argv: string[]) => {
    const { io, out, err } = capture();
    const code = runCli(
      ["seed", "--facts", facts, "--out", join(dir, "obligations.json"), "--blocks", join(dir, "blocks"), ...argv],
      io,
    );
    return { code, out, err };
  };

  it("defaults to `full`, and stamps it", () => {
    const { dir, facts } = factsTree();
    expect(seedInto(dir, facts, []).code).toBe(EXIT_OK);
    const doc = JSON.parse(readFileSync(join(dir, "obligations.json"), "utf8"));
    expect(doc.contract).toBe("full");
    expect(readFileSync(join(dir, "blocks", "enforcement.md"), "utf8")).toMatch(/"discharge":/);
  });

  it("`--contract minimal` reaches the BLOCK on disk, not just the option object", () => {
    const { dir, facts } = factsTree();
    expect(seedInto(dir, facts, ["--contract", "minimal"]).code).toBe(EXIT_OK);
    const doc = JSON.parse(readFileSync(join(dir, "obligations.json"), "utf8"));
    expect(doc.contract).toBe("minimal");

    const block = readFileSync(join(dir, "blocks", "enforcement.md"), "utf8");
    expect(block).not.toMatch(/"discharge":/);
    expect(block).not.toMatch(/"failureScenario":/);
    expect(block).not.toContain("WORKED EXAMPLE");
    expect(block).toContain("Append one JSON object per hypothesis to");
  });

  it("refuses an unrecognised value instead of quietly rendering `full`", () => {
    // The `--family` case, not the `--max-files` case: a typo'd control arm that
    // fell back to the default would RUN, produce a number, and report it for an
    // experiment that never happened. Nothing downstream could detect that.
    const { dir, facts } = factsTree();
    const { code, err } = seedInto(dir, facts, ["--contract", "mininal"]);
    expect(code).toBe(EXIT_UNAVAILABLE);
    expect(err.join(" ")).toMatch(/--contract must be one of full \| minimal/);
    expect(existsSync(join(dir, "obligations.json"))).toBe(false);
  });

  it("`--mint bogus` exits 2, names the valid tokens, and reads no document", () => {
    // Same rule as `--contract` above: a typo'd arm silently running baseline
    // would report a number for an experiment that never happened.
    const { dir, facts } = factsTree();
    const { code, err } = seedInto(dir, facts, ["--mint", "bogus"]);
    expect(code).toBe(EXIT_UNAVAILABLE);
    expect(err.join(" ")).toMatch(/--mint must be a comma-list over all-in-diff \| registrations/);
    expect(existsSync(join(dir, "obligations.json"))).toBe(false);
    // A known token dragging a typo along fails identically.
    expect(seedInto(dir, facts, ["--mint", "all-in-diff,registartions"]).code).toBe(EXIT_UNAVAILABLE);
  });

  it("absent `--mint` stamps both arms false; a spec stamps what was asked", () => {
    const { dir, facts } = factsTree();
    expect(seedInto(dir, facts, []).code).toBe(EXIT_OK);
    const baseline = JSON.parse(readFileSync(join(dir, "obligations.json"), "utf8"));
    expect(baseline.minting).toEqual({ allInDiff: false, registrations: false });

    expect(seedInto(dir, facts, ["--mint", "all-in-diff,registrations"]).code).toBe(EXIT_OK);
    const minted = JSON.parse(readFileSync(join(dir, "obligations.json"), "utf8"));
    expect(minted.minting).toEqual({ allInDiff: true, registrations: true });
  });
});

afterEach(() => {
  delete process.env.LASTLIGHT_OPENGREP_BIN;
});
