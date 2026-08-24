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
import {
  checkDischarge,
  dischargeExitCode,
  renderDischargeCheck,
  renderDischargeLedger,
} from "./discharge.js";
import { EXIT_DEGRADED, EXIT_UNAVAILABLE, EXIT_OK } from "./errors.js";
import {
  buildFindingsLedger,
  checkFindings,
  renderFindingsCheck,
  renderFindingsLedger,
} from "./findings.js";
import { prepareTree } from "./prepare.js";
import { checkProbes, renderProbeCheck } from "./probes.js";
import { runExtractor, runWrapped, writeDocument } from "./run.js";
import { AllDocumentSchema, DOCUMENT_SCHEMAS, type AllDocument, type ExtractorName } from "./schema.js";
import {
  isObligationContract,
  OBLIGATION_CONTRACTS,
  SEEDABLE_FAMILIES,
  seedObligations,
  type MintOptions,
} from "./seed.js";
import { renderFamilyBlock } from "./seed-render.js";
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
  seed        turn an \`all\` envelope into mechanism-complete obligations
  prepare     install deps so a probe can be RUN (WP4's affordance, not CI)
  discharge   a SURVEY's exit gate — every obligation of one family carries a
              QUOTE / ABSENT / PARTIAL / PROBE discharge in its .jsonl
  probes      the \`falsify\` loop's exit gate — every hypothesis that needed a
              probe has a verdict, and every claim of execution has a transcript
  findings    the \`adjudicate\` loop's exit gate — the CONSERVATION check: every
              hypothesis has exactly one disposition, and every deletion names a
              transcript that exists
  toolchain   print the pinned manifest and what actually resolved

\`discharge\` options (WP3 — it replaces \`test -s\`, which one line of any content
passes; it reads no quote and judges no claim):
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --family <f>        the survey branch's family                   (required)
  --ledger            print the CHECKLIST instead of grading: every obligation
                      of the family, \`[x]\`/\`[ ]\`, with its question. For the
                      SURVEY to run. Reports; never grades — ALWAYS exits 0.
  Exit 0 = every obligation carries one of QUOTE / ABSENT / PARTIAL / PROBE (or
  there were none, or the family is NOT MEASURED). 3 = the file exists and
  something is outstanding. 2 = there was nothing to grade — no
  hypotheses/<family>.jsonl at all, no readable obligations.json, or a --family
  the document does not name. ANY non-zero means "iterate again".

\`probes\` options (an existence gate, not a validator — it reads no transcript):
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --repo <dir>        what a transcript path is relative to (default: cwd)
  Exit 0 = the loop may stop. Non-zero = something still owes a verdict, which
  a pass can always discharge honestly by recording \`unprobed\`.

\`findings\` options (conservation, not schema validation — WP6c):
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --repo <dir>        what a \`refutedBy\` path is relative to (default: cwd)
  --repair            the §D12 FLOOR. Record every unaccounted hypothesis at
                      tier "internal", un-delete every drop with no transcript,
                      rewrite findings.json and exit 0. Idempotent, and it never
                      deletes: an unjustified deletion becomes a recorded
                      non-deletion. Run it on the LAST iteration.
  --ledger            print the CHECKLIST instead of grading: every declared id
                      by family, which already carry a disposition, and which do
                      not. For the ADJUDICATOR to run, so it discharges an
                      explicit list rather than reconstructing one from six
                      .jsonl files. Reports; never grades — ALWAYS exits 0.
  Exit 0 = the loop may stop. Non-zero = a hypothesis is unaccounted for, a
  deletion has nothing to show for it, or there is no readable findings.json.

\`prepare\` options (it acts on a tree; no --base/--head, and it runs no analysis):
  --repo <dir>        the checkout to prepare               (default: cwd)
  --out <file>        write env.json here                   (default: stdout)
  --no-install        don't install, just report what is already there
  --lifecycle-scripts allow the tree's own postinstall to run. OFF by default:
                      this runs against a PR HEAD, so that is the author's code
                      executing on the operator's machine
  --typecheck         run the repo's own tsc --noEmit for per-line diagnostics
                      (NOT a CI re-run — CI reports pass/fail, this reports
                      something a hypothesis can be anchored to)
  --coverage          run a coverage command so the \`tests\` family has an input.
                      The one step that runs a test suite; opt-in for that reason
  --coverage-cmd <s>  explicit coverage command (beats package.json detection)
  --install-timeout <ms> / --typecheck-timeout <ms> / --coverage-timeout <ms>

\`seed\` options (it reads a DOCUMENT, not a repo — no --base/--head):
  --facts <file>      the \`all\` document to seed from            (required)
  --out <file>        write obligations.json here                (default: stdout)
  --blocks <dir>      also write one rendered block per family, \`<family>.md\`
  --max-obligations <n>  per-PR budget (default 40). The seeder RANKS and the
                      drop is counted in the document — never silent.
  --contract <mode>   which obligation BLOCK the families get: \`full\` (default —
                      the mandatory discharge contract, the un-truncated id
                      checklist and the worked exemplar) or \`minimal\` (the block
                      as it stood before 2026-08-23: same obligations, delivered
                      just as reliably, asking the OLD question). It is stamped
                      into obligations.json, and \`discharge\` degrades to the
                      \`test -s\` floor when it reads \`minimal\` — a gate must
                      never grade a contract the block did not ask for. A value
                      that is neither is a WIRING bug and exits 2.
  --mint <spec>       which D2 minting arms run, as a comma-list over
                      \`all-in-diff\` (contract obligations for symbols whose
                      every reference is inside the diff) and \`registrations\`
                      (security obligations for route/hook registration order).
                      Absent = neither — the baseline document, byte-identical.
                      Stamped into obligations.json as \`minting\`. Any unknown
                      token is a WIRING bug and exits 2 before the document is
                      read — a typo'd arm silently running baseline would
                      report a number for an experiment that never happened.

Options:
  --repo <dir>        the checkout to analyse            (default: cwd)
  --base <ref>        base ref                           (required)
  --head <ref>        head ref                           (default: HEAD)
  --out <file>        write JSON here                    (default: stdout)
  --tsconfig <file>   force ONE tsconfig for the whole diff. It also disables
                      the orphan fallback — a caller that named a program did
                      not ask for a second to be opened around it.
  --max-files <n>     ceiling on how many files a repository-wide SCAN reads:
                      set B's literal sweep and the tier-2 name index. NOT a
                      compiler budget — the tsgo snapshot holds every tsconfig
                      the diff touches and has none. Hitting it is always named
                      in degraded[], because an absence claim over a truncated
                      file set is unsound rather than merely weak.
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

const BOOLEAN_FLAGS = new Set([
  "never-fail",
  "stage",
  "help",
  "h",
  "version",
  "v",
  "json",
  "no-install",
  "lifecycle-scripts",
  "typecheck",
  "coverage",
  "repair",
  // Both `findings --ledger` and `discharge --ledger` take no value. Declaring
  // it keeps `--ledger` from swallowing the next token as one.
  "ledger",
]);

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
          compiler,
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

  if (command === "prepare") {
    // `prepare` never analyses anything, so it has no envelope, no tier and no
    // exit code that could mean "could not run": the tree is whatever it is and
    // `env.json` says so. The exit code follows `degraded[]` alone, and
    // `--never-fail` flattens even that — §D12, the same reason every other
    // command has the flag.
    const env = prepareTree({
      repo: stringFlag(flags.repo) ?? process.cwd(),
      install: flags["no-install"] !== true,
      lifecycleScripts: flags["lifecycle-scripts"] === true,
      typecheck: flags.typecheck === true,
      coverage: flags.coverage === true,
      coverageCommand: stringFlag(flags["coverage-cmd"]),
      installTimeoutMs: numberFlag(flags["install-timeout"]),
      typecheckTimeoutMs: numberFlag(flags["typecheck-timeout"]),
      coverageTimeoutMs: numberFlag(flags["coverage-timeout"]),
      log,
    });

    const envOut = stringFlag(flags.out);
    if (envOut) writeDocument(envOut, env);
    else io.out(JSON.stringify(env, null, 2));

    if (flags["never-fail"] === true) return EXIT_OK;
    return env.degraded.length > 0 ? EXIT_DEGRADED : EXIT_OK;
  }

  if (command === "discharge") {
    // A SURVEY branch's `until_bash`, and the same contract as `probes` and
    // `findings`: its non-zero exit is the LOOP condition, not a failure, so it
    // is deliberately NOT wrapped by `--never-fail`.
    const family = stringFlag(flags.family);
    if (!family) {
      // The `$LL_FAMILY` bug, refused at the door: WP3's first design gated on
      // a variable nothing set, so the test read `hypotheses/.jsonl`, failed
      // forever, and the loop burned every iteration against a condition that
      // meant nothing. An empty --family must break loudly, never quietly pass.
      io.err("--family <f> is required (the survey branch's family)");
      return EXIT_UNAVAILABLE;
    }
    const result = checkDischarge({
      dir: stringFlag(flags.dir) ?? ".lastlight/pr-review",
      family,
      log,
    });

    // `--ledger` is the CHECKLIST mode and its caller is the SURVEY ITSELF
    // rather than the harness, so it **always exits 0** — the gate's non-zero
    // "iterate again" would read inside an agent's own bash tool as a tool
    // failure. Same reading of the same files, two audiences, two exit
    // contracts. It writes nothing; neither does the gate.
    if (flags.ledger === true) {
      io.out(renderDischargeLedger(result));
      return EXIT_OK;
    }

    io.out(renderDischargeCheck(result));
    return dischargeExitCode(result);
  }

  if (command === "probes") {
    // The `falsify` loop's `until_bash`. NOT wrapped by `--never-fail`: its
    // non-zero exit is the loop condition, not a failure — the phase around it
    // still succeeds when the loop runs out of iterations, which is what keeps
    // §D12 intact.
    const result = checkProbes({
      dir: stringFlag(flags.dir) ?? ".lastlight/pr-review",
      repo: stringFlag(flags.repo),
    });
    io.out(renderProbeCheck(result));
    return result.satisfied ? EXIT_OK : EXIT_DEGRADED;
  }

  if (command === "findings") {
    const dir = stringFlag(flags.dir) ?? ".lastlight/pr-review";

    // `--ledger` is the CHECKLIST mode, and its caller is the ADJUDICATOR
    // ITSELF rather than the harness — so it **always exits 0**. The two other
    // modes below are a loop condition, where non-zero means "iterate again";
    // an agent running that inside its own bash tool would read the same exit
    // as a tool failure. Same reading of the same files, two audiences, two
    // exit contracts, and conflating them is how the checklist would come to
    // be treated as the gate.
    if (flags.ledger === true) {
      io.out(
        renderFindingsLedger(
          buildFindingsLedger({ dir, repo: stringFlag(flags.repo), log }),
        ),
      );
      return EXIT_OK;
    }

    // The `adjudicate` loop's `until_bash`, and the same contract as `probes`:
    // its non-zero exit is the LOOP condition, not a failure, so it is not
    // wrapped by `--never-fail`. `--repair` is the §D12 floor — it always
    // returns 0, because a floor that can fail is not a floor.
    const result = checkFindings({
      dir: stringFlag(flags.dir) ?? ".lastlight/pr-review",
      repo: stringFlag(flags.repo),
      repair: flags.repair === true,
      log,
    });
    io.out(renderFindingsCheck(result));
    return result.satisfied ? EXIT_OK : EXIT_DEGRADED;
  }

  if (command === "seed") {
    const factsPath = stringFlag(flags.facts);
    if (!factsPath) {
      io.err("--facts <file> is required (the `all` document to seed from)");
      return EXIT_UNAVAILABLE;
    }
    // An unrecognised contract is the `--family` case, not the `--max-files`
    // case: nothing downstream can recover from it, and the failure is silent in
    // the direction that matters — a typo'd control arm would render `full`,
    // run, and report a number for an experiment that never happened. So it
    // breaks at the wiring, exactly as an unknown `--family` does, and it breaks
    // BEFORE any work: a flag nobody can fix from inside the run should not cost
    // a document parse first.
    const contractFlag = stringFlag(flags.contract);
    if (contractFlag !== undefined && !isObligationContract(contractFlag)) {
      io.err(
        `--contract must be one of ${OBLIGATION_CONTRACTS.join(" | ")} (got "${contractFlag}")`,
      );
      return EXIT_UNAVAILABLE;
    }

    // `--mint` is validated the same way, for the same reason, and BEFORE the
    // document is read: a typo'd arm that silently ran baseline would report a
    // number for an experiment that never happened, and a flag nobody can fix
    // from inside the run should not cost a document parse first.
    const mint: MintOptions = { allInDiff: false, registrations: false };
    if (flags.mint !== undefined) {
      const spec = stringFlag(flags.mint);
      const tokens = (spec ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
      if (tokens.length === 0) {
        io.err(`--mint needs at least one of all-in-diff | registrations (comma-separated)`);
        return EXIT_UNAVAILABLE;
      }
      for (const token of tokens) {
        if (token === "all-in-diff") mint.allInDiff = true;
        else if (token === "registrations") mint.registrations = true;
        else {
          io.err(
            `--mint must be a comma-list over all-in-diff | registrations (got "${token}")`,
          );
          return EXIT_UNAVAILABLE;
        }
      }
    }

    let document: AllDocument;
    try {
      document = AllDocumentSchema.parse(JSON.parse(readFileSync(factsPath, "utf8")));
    } catch (err) {
      // A malformed or absent envelope is EXIT_UNAVAILABLE, never an empty
      // obligation set: "nobody looked" and "looked and found none" must stay
      // distinguishable at every layer, and this is the layer where an empty
      // file would be read as the second.
      io.err(`could not read a valid \`all\` document from ${factsPath}: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_UNAVAILABLE;
    }

    const obligations = seedObligations(document, {
      maxObligations: numberFlag(flags["max-obligations"]),
      contract: contractFlag,
      mint,
      log,
    });

    const blocksDir = stringFlag(flags.blocks);
    if (blocksDir) {
      for (const family of SEEDABLE_FAMILIES) {
        const block = renderFamilyBlock(obligations, family);
        // An empty block means "nothing to say AND nothing degraded". Writing an
        // empty file would make a phase's `test -s` gate pass on silence.
        if (block) writeDocument(join(blocksDir, `${family}.md`), block, { raw: true });
      }
    }

    const seedOut = stringFlag(flags.out);
    if (seedOut) writeDocument(seedOut, obligations);
    else io.out(JSON.stringify(obligations, null, 2));

    // The envelope's coverage is inherited, so the exit code follows it: a
    // `none` envelope produced obligations from nothing and the caller must be
    // able to tell without parsing.
    return obligations.coverage === "none" ? EXIT_UNAVAILABLE : EXIT_OK;
  }

  if (!EXTRACTORS.includes(command as ExtractorName)) {
    io.err(
      `unknown command "${command}". One of: ${EXTRACTORS.join(", ")}, seed, prepare, discharge, probes, findings, toolchain`,
    );
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
