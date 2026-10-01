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
import { checkFindings, renderFindingsCheck } from "./findings.js";
import { renderStampSeverity, stampDerivedSeverity } from "./finding-severity.js";
import { normalizeFamilyIds } from "./hypotheses.js";
import { prepareTree } from "./prepare.js";
import { checkProbes, renderProbeCheck } from "./probes.js";
import { runExtractor, runWrapped, writeDocument } from "./run.js";
import {
  AllDocumentSchema,
  DOCUMENT_SCHEMAS,
  type AllDocument,
  type ExtractorName,
} from "./schema.js";
import {
  isObligationContract,
  OBLIGATION_CONTRACTS,
  SEEDABLE_FAMILIES,
  seedObligations,
  type MintOptions,
  type SeedFamily,
} from "./seed.js";
import { buildUnitsOrEmpty, emptyUnitsDocument } from "./units.js";
import { ingestUnits, renderIngest } from "./units-ingest.js";
import { renderProbePlanSummary, writeProbePlan } from "./probe-plan.js";
import { loadManifest, resolveFactsBin, toolchainStamp } from "./toolchain.js";
import { compilerInfo } from "./project.js";
import {
  checkSelection,
  checkSiteSlot,
  finalizeSiteFindings,
  renderFinalize,
  renderSelectionCheck,
  renderSiteCheck,
  renderSiteMerge,
  renderSitePlanSummary,
  writeSiteMerge,
  writeSitePlan,
} from "./site-review.js";
import { packageRoot } from "./toolchain.js";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
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
              QUOTE / ABSENT / PARTIAL / PROBE discharge in its .jsonl. First
              writes each row's canonical id into its \`id\` (the survey's own
              label kept as \`declared_id\`). \`--ungraded\` for a family whose
              obligations are not on disk (\`spec\`): the id rewrite plus a
              non-empty-file check
  probe-plan  decide WHICH hypotheses \`falsify\` probes: the gate's owed set
              (derived Critical, or a survey's own \`needsProbe\`), ranked and
              capped, written to probes/plan.json + the records falsify reads,
              probes/plan.md. The \`probes\` gate then owes exactly that list
  probes      the \`falsify\` loop's exit gate — every hypothesis that needed a
              probe has a verdict, and every claim of execution has a transcript
              that OPENS with the command it ran
  findings    the CONSERVATION floor (\`--repair\`): every hypothesis findings.json
              does not account for is recorded at tier "internal", and every
              hypothesis-derived finding's severity is derived
  units       cut the PR into units (one per changed function/method, at most
              one per file for its module-scope regions, one \`pr\` unit for
              obligations no unit holds) and render each unit's COMPLETE model request into
              units.json — the input to the in-process unit survey
  units-ingest  validate each units/responses/<unitId>.json and write the
              replies as hypotheses/<family>.jsonl rows (the shape every later
              phase already reads), plus units/ingest.json. Every obligation
              gets a row even when its unit failed — with unknown evidence
  sites       the \`sites\` review engine's deterministic steps: --plan (rank
              sites, write one brief per slot plus sites/branches.json, the
              fan-out manifest; --top <n> sites, --pair for a second
              investigator per site as <site-id>-b), --check <site-id> (a site
              investigator's gate), --merge (pool the findings for \`select\`),
              --check-select (select's gate), --finalize (write findings.json)
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

\`units\` options (it reads the pipeline's own artifacts plus git; no --base/--head):
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --repo <dir>        the checkout whose git objects are read   (default: cwd)
  --facts <file>      the \`all\` document            (default: <dir>/facts.json)
  --obligations <f>   the seeder's document   (default: <dir>/obligations.json).
                      Absent ⇒ units carry no obligations, named in degraded[]
  --spec <file>       core's spec obligations (default: <dir>/spec-obligations.json).
                      Each rides on the unit with the most touched lines in its
                      first candidate file that has one, else the \`pr\` unit.
                      Absent or malformed ⇒ no spec obligation, named in degraded[]
  --out <file>        where units.json goes      (default: <dir>/units.json)
  --max-chars <n>     per-request budget in characters (default 100000). Over it:
                      trim neighbours, then drop them, then split the unit into
                      overlapping passes — each step marks the unit \`truncated\`
                      and names itself in degraded[]
  --max-units <n>     units per document, i.e. model calls (default 150). Past
                      it the lowest-priority units are dropped — named in
                      degraded[], their obligations moved to the \`pr\` unit
  --family-split-lines <n>
                      a unit owning more changed lines than this (default 40)
                      is surveyed once PER FAMILY — one unit per asked family,
                      each carrying only that family's obligations
  --prior <file>      the prior review's units (default: <dir>/prior-review.json
                      when it exists). Each unit gets a \`delta\` against it —
                      new / changed / affected / unchanged — and the re-review
                      scopes its sites to everything but \`unchanged\`
  --risk-rules <f>    {"rules":[{glob,tier}]} — the repo's then the operator's
                      risk rules, matched before the built-in ones. Each unit
                      gets a \`risk\` tier (low/medium/high/critical)
  --never-fail        exit 0 whatever happened; the document says what did
  Exit 0 = full, or nothing to survey (\`coverage: "none"\`, said why). 3 =
  degraded. 2 = an input is missing — a \`coverage: "none"\` document is still
  written, naming it.

\`units-ingest\` options:
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --never-fail        exit 0 whatever happened; units/ingest.json says what did
  Exit 0 = every unit answered and every family's \`discharge\` gate passes on
  the ingested rows. 3 = something was unanswered (its rows still written). 2 =
  units.json unreadable (rows still written for every obligation).

\`probe-plan\` options:
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --max-probes <n>    select at most this many (default: no cap). The rest are
                      recorded as deferred and reach adjudication unprobed
  --never-fail        exit 0 whatever happened. Without a plan file every reader
                      falls back to the pre-plan owed set, so a failure here
                      costs the cap, never a probe
  Exit 0 = plan written. 2 = it could not be written.

\`probes\` options (a near-existence gate, not a validator — it reads a
transcript's FIRST LINE and nothing else):
  --dir <dir>         the .lastlight/pr-review directory
                      (default: .lastlight/pr-review)
  --repo <dir>        what a transcript path is relative to (default: cwd)
  A \`reproduced\`/\`corroborated\`/\`refuted\` verdict must name a \`command\` and a
  transcript that exists and opens with that command — \`"command": "code
  inspection"\` over a page of prose is \`unexecuted\`, not evidence. A
  \`reproduced\` whose every command only READS code (grep/rg/cat/…, a facts
  query) against a claim whose evidence records a consequence at head is
  \`read-not-reproduction\`: record it \`corroborated\`, or run something.
  \`unprobed\` needs nothing and always closes the gate.
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
                      non-deletion. Run it on the LAST iteration. It then
                      DERIVES every hypothesis-derived finding's severity from
                      the evidence record and probe strength, keeping the
                      written value as \`declaredSeverity\`.
  \`--repair\` is required: the grading gate went with the adjudicator it gated.

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
  --max-obligations <n>  TOTAL backstop (default 48). Truncation is per-FAMILY
                      first — contract 12, enforcement 12, state 8, security 8,
                      tests 8 — because each family feeds one survey branch, so
                      the cost is per branch and one family's excess must never
                      unask another's questions. This bound is applied after
                      those ceilings and, at the default (their sum), cannot
                      bind. Every drop is counted in the document, naming the
                      ceiling or the backstop — never silent.
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
  --family-caps <spec>  override the per-family ceilings, as a comma-list of
                      \`<family>=<n>\` (or \`=none\` for uncapped), e.g.
                      \`contract=25,security=none\`. A MEASUREMENT seam, not an
                      operator knob: there is no config key for it, and the
                      ceilings' own rationale says the table is untuned and
                      expects to move — so "what is in the tail this ceiling
                      refused, and would any of it have reached gold?" needs to
                      be askable without editing a constant. Families not named
                      keep their shipped ceiling. An unknown family, a negative
                      or a non-numeric value exits 2, unclamped and undefaulted.

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
  --stage-diff        ALSO write the diff to disk once — an index plus one
                      unified patch per changed file, under
                      .lastlight/pr-review/diff/. No network. The f1 lever: five
                      survey branches re-derived ONE fixed merge-base range ~30
                      times across ~93 bash calls per case, and every
                      re-derivation is a fresh chance to spell it two-dot.
                      Failing to stage is DEGRADED at most — never a failed run
  --stage-diff-dir <d>  where those patches go (default .lastlight/pr-review/diff)
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
  // `--stage-diff` takes no value — its directory is `--stage-diff-dir`. Without
  // this it would swallow the next token, so `--stage-diff --out x` would stage
  // into a directory called `--out`… except it wouldn't, because the parser
  // refuses a `-`-prefixed next token; what it WOULD swallow is
  // `--stage-diff all`, silently.
  "stage-diff",
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
  // `discharge --ledger` takes no value. Declaring it keeps `--ledger` from
  // swallowing the next token as one.
  "ledger",
  "ungraded",
  // `sites`' mode switches. `--check` is the one that takes a value (the slot id).
  "plan",
  "pair",
  "merge",
  "finalize",
  "check-select",
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
    const pkg = JSON.parse(
      readFileSync(join(packageRoot(), "package.json"), "utf8"),
    ) as {
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
        {
          manifest: loadManifest(),
          resolved: toolchainStamp(Object.keys(loadManifest().binaries)),
        },
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
    const dir = stringFlag(flags.dir) ?? ".lastlight/pr-review";
    // The GATE (not `--ledger`, which a survey runs mid-branch) is the moment a
    // branch is finished: write the canonical ids into the file before anything
    // downstream reads it. See `normalizeFamilyIds`.
    if (flags.ledger !== true) normalizeFamilyIds(dir, family);

    // `--ungraded`: a family whose obligations are not on disk to grade — `spec`,
    // built harness-side from the PR body and linked issues and delivered in
    // the prompt, never written to obligations.json (where `discharge` would
    // otherwise refuse it as an unknown family). It gets the same id rewrite
    // above and exactly the floor it always had: the file is non-empty.
    if (flags.ungraded === true && flags.ledger !== true) {
      const path = join(dir, "hypotheses", `${family}.jsonl`);
      const ok = existsSync(path) && statSync(path).size > 0;
      io.out(`discharge[${family}]: ungraded — obligations are not on disk; ${ok ? "file present" : `${path} is missing or empty`}`);
      return ok ? EXIT_OK : EXIT_DEGRADED;
    }
    const result = checkDischarge({ dir, family, log });

    // `--ledger` is the CHECKLIST mode and its caller is the SURVEY ITSELF
    // rather than the harness, so it **always exits 0** — the gate's non-zero
    // "iterate again" would read inside an agent's own bash tool as a tool
    // failure. Same reading of the same files, two audiences, two exit
    // contracts. It writes nothing; the gate mode writes only the canonical ids
    // (`normalizeFamilyIds`, above), never a verdict.
    if (flags.ledger === true) {
      io.out(renderDischargeLedger(result));
      return EXIT_OK;
    }

    io.out(renderDischargeCheck(result));
    return dischargeExitCode(result);
  }

  if (command === "units") {
    // A deterministic phase like `facts` and `seed`, so the same §D12 contract:
    // a missing input still writes a document that SAYS so, and `--never-fail`
    // turns every outcome into exit 0.
    const neverFail = flags["never-fail"] === true;
    const dir = stringFlag(flags.dir) ?? ".lastlight/pr-review";
    const out = stringFlag(flags.out) ?? join(dir, "units.json");
    try {
      const result = buildUnitsOrEmpty({
        dir,
        repo: stringFlag(flags.repo) ?? process.cwd(),
        factsPath: stringFlag(flags.facts),
        obligationsPath: stringFlag(flags.obligations),
        specPath: stringFlag(flags.spec),
        maxRequestChars: numberFlag(flags["max-chars"]),
        maxUnits: numberFlag(flags["max-units"]),
        familySplitLines: numberFlag(flags["family-split-lines"]),
        priorPath: stringFlag(flags.prior),
        riskRulesPath: stringFlag(flags["risk-rules"]),
        log,
      });
      writeDocument(out, result.document);
      const doc = result.document;
      const deltas = doc.prior ? countBy(doc.units.map((u) => u.delta ?? "?")) : null;
      io.out(
        `units: ${doc.units.length} unit(s), coverage ${doc.coverage}, ${doc.units.filter((u) => u.truncated).length} truncated → ${out}` +
          (deltas ? `\n  re-review against ${doc.prior!.head?.slice(0, 8) ?? "a prior review"}: ${deltas}` : "") +
          doc.degraded.map((d) => `\n  degraded: ${d.reason}`).join(""),
      );
      return neverFail ? EXIT_OK : result.exitCode;
    } catch (err) {
      if (!neverFail) throw err;
      const reason = `units failed: ${err instanceof Error ? err.message : String(err)}`;
      try {
        writeDocument(out, emptyUnitsDocument(reason));
      } catch {
        // Nothing left to write with; the log line is the record.
      }
      io.err(reason);
      return EXIT_OK;
    }
  }

  if (command === "units-ingest") {
    const neverFail = flags["never-fail"] === true;
    try {
      const result = ingestUnits({ dir: stringFlag(flags.dir) ?? ".lastlight/pr-review", log });
      io.out(renderIngest(result.document));
      return neverFail ? EXIT_OK : result.exitCode;
    } catch (err) {
      if (!neverFail) throw err;
      io.err(`units-ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_OK;
    }
  }

  if (command === "sites") {
    const dir = stringFlag(flags.dir) ?? ".lastlight/pr-review";
    const repo = stringFlag(flags.repo) ?? ".";
    const neverFail = flags["never-fail"] === true;
    // The two GATES (`--check`, `--check-select`) are loop conditions, like
    // `probes` and `findings`: non-zero means "iterate again", so they are not
    // wrapped by `--never-fail`. The three steps are inputs, never gates, and
    // `--never-fail` keeps a crash in one from failing the phase.
    const check = stringFlag(flags.check);
    if (check) {
      const result = checkSiteSlot({ dir, repo, siteId: check });
      io.out(renderSiteCheck(check, result));
      return result.satisfied ? EXIT_OK : EXIT_DEGRADED;
    }
    if (flags["check-select"] === true) {
      const result = checkSelection({ dir });
      io.out(renderSelectionCheck(result));
      return result.satisfied ? EXIT_OK : EXIT_DEGRADED;
    }
    try {
      if (flags.plan === true) {
        io.out(
          renderSitePlanSummary(
            writeSitePlan(dir, {
              ...(numberFlag(flags.top) !== undefined ? { top: numberFlag(flags.top) } : {}),
              ...(numberFlag(flags.window) !== undefined ? { window: numberFlag(flags.window) } : {}),
              ...(flags.pair === true ? { pair: true } : {}),
            }),
          ),
        );
        return EXIT_OK;
      }
      if (flags.merge === true) {
        io.out(renderSiteMerge(writeSiteMerge(dir, repo)));
        return EXIT_OK;
      }
      if (flags.finalize === true) {
        io.out(renderFinalize(finalizeSiteFindings({ dir, repo })));
        return EXIT_OK;
      }
    } catch (err) {
      io.err(`sites failed: ${err instanceof Error ? err.message : String(err)}`);
      return neverFail ? EXIT_OK : EXIT_UNAVAILABLE;
    }
    io.err("sites: pass one of --plan, --check <site-id>, --merge, --check-select, --finalize");
    return EXIT_UNAVAILABLE;
  }

  if (command === "probe-plan") {
    const neverFail = flags["never-fail"] === true;
    try {
      const { plan } = writeProbePlan(stringFlag(flags.dir) ?? ".lastlight/pr-review", {
        maxProbes: numberFlag(flags["max-probes"]) ?? null,
      });
      io.out(renderProbePlanSummary(plan));
      return EXIT_OK;
    } catch (err) {
      io.err(`probe-plan failed: ${err instanceof Error ? err.message : String(err)}`);
      return neverFail ? EXIT_OK : EXIT_UNAVAILABLE;
    }
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

    // Only the §D12 floor (`reconcile`) is left: the grading mode was the
    // adjudicate loop's `until_bash`, and went with it.
    if (flags.repair !== true) {
      io.err("findings: pass --repair — the grading gate was removed with the adjudicator");
      return EXIT_UNAVAILABLE;
    }
    const result = checkFindings({
      dir,
      repo: stringFlag(flags.repo),
      repair: true,
      log,
    });
    io.out(renderFindingsCheck(result));
    // Issue #405: the floor is also where a finding's severity is DERIVED.
    // Never fails the floor: an unreadable document is reported and left as
    // it is.
    io.out(renderStampSeverity(stampDerivedSeverity({ dir, repo: stringFlag(flags.repo), log })));
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
      const tokens = (spec ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (tokens.length === 0) {
        io.err(
          `--mint needs at least one of all-in-diff | registrations (comma-separated)`,
        );
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

    // `--family-caps` is the MEASUREMENT seam onto FAMILY_CAPS, and it is
    // validated exactly as the two above and before the document is read. The
    // table's own docblock says it is untuned and expects to move; nothing could
    // vary it without editing a module constant, so "what is in the tail this
    // ceiling refused?" was unanswerable offline. Deliberately CLI-only — there
    // is no config key, and `review.analysis.maxObligations` stays the only
    // bound an operator sets.
    const familyCaps: Partial<Record<SeedFamily, number>> = {};
    if (flags["family-caps"] !== undefined) {
      const spec = stringFlag(flags["family-caps"]);
      const tokens = (spec ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (tokens.length === 0) {
        io.err(
          `--family-caps needs at least one <family>=<n> pair (comma-separated)`,
        );
        return EXIT_UNAVAILABLE;
      }
      for (const token of tokens) {
        const [family, raw] = token.split("=", 2);
        if (!(SEEDABLE_FAMILIES as readonly string[]).includes(family)) {
          io.err(
            `--family-caps must name one of ${SEEDABLE_FAMILIES.join(" | ")} (got "${family}")`,
          );
          return EXIT_UNAVAILABLE;
        }
        // `none` is the uncapped arm, spelled so a shell never has to quote
        // `Infinity`. A negative or non-numeric ceiling is refused rather than
        // clamped: a cap of -1 silently truncating every family to nothing is
        // the typo'd-control-arm failure again.
        const value = raw === "none" ? Infinity : Number(raw);
        if (!Number.isFinite(value) && value !== Infinity) {
          io.err(
            `--family-caps ${family}= must be a non-negative integer or \`none\` (got "${raw}")`,
          );
          return EXIT_UNAVAILABLE;
        }
        if (value < 0) {
          io.err(`--family-caps ${family}=${raw} is negative`);
          return EXIT_UNAVAILABLE;
        }
        familyCaps[family as SeedFamily] = value;
      }
    }

    let document: AllDocument;
    try {
      document = AllDocumentSchema.parse(
        JSON.parse(readFileSync(factsPath, "utf8")),
      );
    } catch (err) {
      // A malformed or absent envelope is EXIT_UNAVAILABLE, never an empty
      // obligation set: "nobody looked" and "looked and found none" must stay
      // distinguishable at every layer, and this is the layer where an empty
      // file would be read as the second.
      io.err(
        `could not read a valid \`all\` document from ${factsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return EXIT_UNAVAILABLE;
    }

    const obligations = seedObligations(document, {
      maxObligations: numberFlag(flags["max-obligations"]),
      contract: contractFlag,
      mint,
      familyCaps: Object.keys(familyCaps).length > 0 ? familyCaps : undefined,
      log,
    });

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
      `unknown command "${command}". One of: ${EXTRACTORS.join(", ")}, seed, prepare, discharge, probe-plan, probes, findings, units, units-ingest, toolchain`,
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
    stageDiff: flags["stage-diff"] === true,
    diffStageDir: stringFlag(flags["stage-diff-dir"]),
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
    return (
      import.meta.url === new URL(`file://${entry}`).href ||
      entry.endsWith("cli.js")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  void (async () => {
    let code: number;
    try {
      code = runCli(process.argv.slice(2), {
        out: (s) => process.stdout.write(`${s}\n`),
        err: (s) => process.stderr.write(`${s}\n`),
      });
    } catch (err) {
      // Reached only WITHOUT --never-fail, where a non-zero exit is the right
      // signal — a human or a test is reading it.
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      code = EXIT_UNAVAILABLE;
    }
    process.exitCode = code;
  })();
}

/** `new 2, changed 1, unchanged 9` — a one-line tally in first-seen order. */
function countBy(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${n}`).join(", ");
}
