#!/usr/bin/env node
/**
 * `lastlight-facts` — the deterministic layer, on a command line.
 *
 * Also reachable as `lastlight facts …`: `code-facts` ships INSIDE the
 * `lastlight` CLI (design review §D1), because the eval harness defaults to
 * `--sandbox none` — in-process, on the host — and no eval configuration on a
 * Mac can see `/opt/lastlight/`. An image-only toolchain would be unmeasurable,
 * and a rung nobody can measure is a rung nobody can defend.
 *
 * `console.*` is correct HERE and nowhere else in this package: this file is a
 * terminal entry point, and every module it calls takes an injected
 * `LoggerPort` instead.
 *
 *   lastlight-facts <facts|contracts|constants|deps|patterns|coverage|all> \
 *     --repo <dir> --base <ref> --head <ref> [--out <file>] [--never-fail]
 */
import { EXIT_UNAVAILABLE, EXIT_OK } from "./errors.js";
import { runExtractor, runWrapped, writeDocument } from "./run.js";
import { DOCUMENT_SCHEMAS, type ExtractorName } from "./schema.js";
import { loadManifest, resolveFactsBin, toolchainStamp } from "./toolchain.js";
import { compilerInfo } from "./project.js";
import { packageRoot } from "./toolchain.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoggerPort } from "./log.js";

const EXTRACTORS = Object.keys(DOCUMENT_SCHEMAS) as ExtractorName[];

const USAGE = `lastlight-facts — deterministic program-analysis facts about a pull request

Usage:
  lastlight-facts <command> --repo <dir> --base <ref> --head <ref> [options]

Commands:
  facts       changed symbols + the impact cone (references, tests, callees)
  contracts   exported-signature delta, base vs head, + consumers outside the diff
  constants   references MINUS literals — the hard-coded-duplicate subtraction
  deps        manifest delta, import sites, optional staged source
  patterns    opengrep + gitleaks, scoped to the diff (probed on PATH)
  coverage    changed lines executed by zero tests, from an EXISTING report
  all         every extractor, one envelope, one file
  toolchain   print the pinned manifest and what actually resolved

Options:
  --repo <dir>        the checkout to analyse            (default: cwd)
  --base <ref>        base ref                           (required)
  --head <ref>        head ref                           (default: HEAD)
  --out <file>        write JSON here                    (default: stdout)
  --tsconfig <file>   force a tsconfig instead of discovering one
  --max-files <n>     program-size ceiling before degrading loudly
  --max-references <n>  cap reference sites recorded per symbol (0 = unbounded)
  --sides <spec>      constants side partition, e.g. client=web/,server=api/
  --rules <file>      opengrep ruleset (default: the local one in rules/)
  --report <file>     coverage artifact instead of the usual candidates
  --stage             npm pack changed runtime deps into .lastlight/ (NETWORK)
  --never-fail        the phase wrapper: on failure write a coverage:"none"
                      envelope and exit 0 (see §D12 — a failed run is
                      re-dispatched every 30 minutes, forever)
  --version           print versions and exit

Exit codes:
  0  analysis ran and the result is trustworthy
  2  analysis could not run — NOTHING downstream may read this as "no findings"
  3  analysis ran degraded — results PLUS a populated degraded[]
`;

interface Parsed {
  command: string;
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["never-fail", "stage", "help", "h", "version", "v", "json"]);

export function parseArgv(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument.startsWith("--")) {
      const body = argument.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positionals.push(argument);
    }
  }
  return { command: positionals[0] ?? "", flags };
}

function numberFlag(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function selfVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The whole CLI, injectable for tests. Returns the exit code instead of calling
 * `process.exit`, so a test can assert the §D12 contract — that `--never-fail`
 * returns 0 on a repo that cannot be analysed — without spawning.
 */
export function runCli(
  argv: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  log?: LoggerPort,
): number {
  const { command, flags } = parseArgv(argv);

  if (flags.version === true || flags.v === true) {
    const compiler = compilerInfo();
    io.out(
      JSON.stringify(
        {
          "lastlight-code-facts": selfVersion(),
          compiler: { version: compiler.version, modulePath: compiler.modulePath },
          toolchain: toolchainStamp(Object.keys(loadManifest().binaries)),
          factsBin: resolveFactsBin(),
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  if (!command || flags.help === true || flags.h === true) {
    io.out(USAGE);
    return command ? EXIT_OK : EXIT_UNAVAILABLE;
  }

  if (command === "toolchain") {
    io.out(
      JSON.stringify(
        { manifest: loadManifest(), resolved: toolchainStamp(Object.keys(loadManifest().binaries)) },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  if (!EXTRACTORS.includes(command as ExtractorName)) {
    io.err(`unknown command "${command}". One of: ${EXTRACTORS.join(", ")}, toolchain`);
    return EXIT_UNAVAILABLE;
  }

  const base = stringFlag(flags.base);
  if (!base) {
    io.err("--base <ref> is required");
    return EXIT_UNAVAILABLE;
  }

  const options = {
    extractor: command as ExtractorName,
    repo: stringFlag(flags.repo) ?? process.cwd(),
    base,
    head: stringFlag(flags.head) ?? "HEAD",
    tsConfigPath: stringFlag(flags.tsconfig),
    maxFiles: numberFlag(flags["max-files"]),
    maxReferences: numberFlag(flags["max-references"]),
    sides: stringFlag(flags.sides),
    rulesPath: stringFlag(flags.rules),
    reportPath: stringFlag(flags.report),
    stage: flags.stage === true,
    log,
  };

  const neverFail = flags["never-fail"] === true;
  const result = neverFail ? runWrapped(options) : runExtractor(options);

  const out = stringFlag(flags.out);
  if (out) writeDocument(out, result.document);
  else io.out(JSON.stringify(result.document, null, 2));

  // §D12: the wrapper's whole job is to keep a failed analysis from failing the
  // RUN. The envelope it just wrote is what makes the failure loud.
  return neverFail ? EXIT_OK : result.exitCode;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href || entry.endsWith("cli.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  let code: number;
  try {
    code = runCli(process.argv.slice(2), {
      out: (s) => process.stdout.write(`${s}\n`),
      err: (s) => process.stderr.write(`${s}\n`),
    });
  } catch (err) {
    // Reached only WITHOUT --never-fail, where a non-zero exit is the right
    // signal — a human or a test is reading it.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    code = EXIT_UNAVAILABLE;
  }
  process.exitCode = code;
}
