#!/usr/bin/env node
/**
 * Eval runner (a measurement, not a test).
 *
 * Drives the REAL production workflows (issue-triage / build / …) against a
 * fake GitHub for each model under test, grades deterministically, and prints
 * a model-comparison scorecard + writes SWE-bench-compatible artifacts. It
 * exits non-zero only if the HARNESS itself errors — never because a model
 * scored poorly (that's the signal we're measuring).
 *
 * Run:
 *   npm run eval                       # triage tier, default model
 *   npm run eval -- code-fix           # code-fix tier
 *   npm run eval -- triage code-fix    # both
 *   EVAL_MODELS="openai/gpt-5.5,openai/gpt-5.4-mini" npm run eval
 *
 * The deterministic, AI-free plumbing is covered separately by
 * `evals/mechanism.test.ts` in the normal `npm test` suite.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import * as p from "@clack/prompts";
import chalk from "chalk";

import { loadDotEnv, hasProviderKey, evalModels, compareModels, modelLabels, resolveModel, setModelsPath } from "./env.js";
import { runInstance, applyEvalEnv, slug } from "./run-instance.js";
import { modelsArm, configArm, releaseOverlayGuard, type Arm } from "./arm.js";
import { mapPool } from "./pool.js";
import {
  summarize,
  writeArtifacts,
  writeScorecard,
  aggregateTrials,
  loadMartianSidecar,
  computeMartianRanking,
  type RunMeta,
  type RunProvenance,
  type PendingCase,
  type Scorecard,
  type MartianSidecar,
} from "./report.js";
import type { SweBenchInstance, InstanceResult, TrialSession } from "./schema.js";
import { bootstrapAssets, describeCore } from "./bootstrap.js";
import { discoverTiers, loadInstances, workflowFor, type Tier } from "./discovery.js";
import {
  builtinDatasetsRoot,
  tierResultsDir,
  makeRunId,
  assignRunIds,
  gitShortSha,
  resultsRoot,
  dashboardDistRoot,
  packageRoot,
  harnessVersion,
  resolveFactsBin,
  factsToolchainStamp,
} from "./paths.js";
import { defaultJudgeModel } from "./judge.js";
import { defaultBeta } from "./grade.js";
import { startServer, type RunningServer } from "./serve.js";
import { runInit } from "./init.js";
import { runAddCase } from "./add-case.js";
import { runClean } from "./clean.js";
import { preflightSandbox } from "./sandbox-preflight.js";
import { ensureRepoCache, ensurePrCommitsInCache, isRealSha } from "./seed.js";

/** Minimal subset of the clack spinner we use. */
interface Spinner {
  start: (msg?: string) => void;
  message: (msg?: string) => void;
  stop: (msg?: string) => void;
}

/**
 * A clack spinner in a TTY; in non-TTY (CI / piped / agent) a quiet stub that
 * drops the animation frames — which redraw dozens of times and shred piped logs
 * — and emits only the final `stop()` line. The plan note already prints what's
 * about to run, so dropping the in-progress frames loses nothing in automation.
 */
function makeSpinner(): Spinner {
  if (process.stdout.isTTY) return p.spinner() as Spinner;
  return {
    start: () => {},
    message: () => {},
    stop: (msg?: string) => {
      if (msg) p.log.message(msg);
    },
  };
}

/** Open a URL in the OS default browser (best-effort, never throws). */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* headless / no browser — the path is printed anyway */
  }
}

/**
 * Run `fn` with `console.*` captured into a buffer so the deep workflow chatter
 * (`[executor] …`, octokit deprecation warnings) doesn't shred the clack
 * spinner — which writes via `process.stdout.write`, a different channel. The
 * captured logs are returned so we can replay them only when a run errors.
 */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const buf: string[] = [];
  const cap =
    (orig: (...a: unknown[]) => void) =>
    (...a: unknown[]) => {
      buf.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
      void orig;
    };
  const { log, warn, error, info } = console;
  console.log = cap(log);
  console.warn = cap(warn);
  console.error = cap(error);
  console.info = cap(info);
  try {
    return { value: await fn(), logs: buf.join("\n") };
  } finally {
    Object.assign(console, { log, warn, error, info });
  }
}

function fmtMs(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

/** Friendly provider-family name from an env-key (OPENAI_API_KEY → "openai"). */
function familyLabel(envKey: string): string {
  return envKey.replace(/_API_KEY$/i, "").toLowerCase() || "default";
}

/** Attach run metadata to a scorecard (mutate-and-return; `summarize` hands back
 * a fresh object each call, so this is safe). */
function withMeta(card: Scorecard, meta: RunMeta): Scorecard {
  card.meta = meta;
  return card;
}

/**
 * Silence `console.*` for the whole batch (parallel mode). The per-run
 * `quiet()` swap saves/restores console and would corrupt under concurrent
 * runs (nested swaps), so parallel mode drops console output once instead.
 * The clack spinner is untouched — it writes via `process.stdout.write`.
 */
function silenceConsole(): () => void {
  const { log, warn, error, info } = console;
  const sink = () => {};
  Object.assign(console, { log: sink, warn: sink, error: sink, info: sink });
  return () => Object.assign(console, { log, warn, error, info });
}

/** Colored one-line verdict for a finished run (with N/N pass count if N>1). */
function verdictLine(tierName: string, inst: SweBenchInstance, r: InstanceResult): string {
  const head = `${chalk.cyan(tierName)}/${inst.instance_id}`;
  if (r.error) return `${head}  ${chalk.red("harness error")}`;
  if (r.blocked) return `${head}  ${chalk.yellow("blocked")} ${chalk.dim("(workflow gate)")}`;
  const count = (pass?: number) => (pass !== undefined && r.trials ? chalk.dim(` ${pass}/${r.trials}`) : "");
  const parts: string[] = [];
  if (r.resolved !== undefined)
    parts.push((r.resolved ? chalk.green("resolved") : chalk.red("unresolved")) + count(r.resolvedPass));
  if (r.behavioral)
    parts.push((r.behavioral.ok ? chalk.green("behavioral ✓") : chalk.red("behavioral ✗")) + count(r.behavioralPass));
  parts.push(chalk.dim(`$${r.costUsd.toFixed(4)}`));
  parts.push(chalk.dim(fmtMs(r.durationMs)));
  return `${head}  ${parts.join("  ")}`;
}

/** Parse an integer CLI flag (`--name N` or `--name=N`) or `EVAL_NAME` env. */
function intFlag(name: string, def: number): number {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      const n = parseInt(argv[i + 1] ?? "", 10);
      if (n > 0) return n;
    }
    const m = argv[i].match(new RegExp(`^--${name}=(\\d+)$`));
    if (m) return parseInt(m[1], 10);
  }
  const env = parseInt(process.env[`EVAL_${name.toUpperCase()}`] ?? "", 10);
  return env > 0 ? env : def;
}

/** Parse a string CLI flag (`--name V` or `--name=V`) or `EVAL_NAME` env. */
function strFlag(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) return argv[i + 1];
    const m = argv[i].match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1];
  }
  return process.env[`EVAL_${name.toUpperCase()}`];
}

/** Collect ALL occurrences of a repeatable string flag (`--name a --name b` or
 * `--name=a`). Used by `--overlay`, which may repeat in `config` mode to compare
 * one arm per overlay. */
function strFlagAll(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) {
      out.push(argv[i + 1]);
      i++;
      continue;
    }
    const m = argv[i].match(new RegExp(`^--${name}=(.+)$`));
    if (m) out.push(m[1]);
  }
  return out;
}

/** CLI flags that take a following value (so it isn't read as a tier name). */
const VALUE_FLAGS = new Set(["--runs", "--repeats", "--model", "--models", "--mode", "--overlay", "--datasets", "--models-file", "--instance", "--limit", "--f-beta", "--sandbox", "--concurrency", "--repeat-concurrency"]);

async function runEval(): Promise<number> {
  loadDotEnv();
  p.intro(chalk.bold(`Last Light ${chalk.yellow("·")} eval`));

  // Run type — the comparison axis:
  //   `models` — compare N models, each FORCED across every workflow step.
  //   `config` — run an overlay's REAL per-step model config (what ships); the
  //              arm is the config/overlay, compared across runs (or N overlays
  //              side-by-side). `--mode` wins; an explicit `--model`/`--compare`
  //              implies `models`; otherwise ask in a TTY (default `models`).
  const modeFlag = strFlag("mode");
  const modelArg = strFlag("model") ?? strFlag("models");
  const compare = process.argv.includes("--compare");
  let runType: "models" | "config";
  if (modeFlag === "config") runType = "config";
  else if (modeFlag === "models" || modelArg || compare) runType = "models";
  else if (process.stdin.isTTY) {
    const picked = await p.select({
      message: "What do you want to eval?",
      options: [
        { value: "models", label: "compare models", hint: "force each model across every workflow step" },
        { value: "config", label: "eval config", hint: "an overlay's real per-step model config (what ships)" },
      ],
      initialValue: "models",
    });
    if (p.isCancel(picked)) {
      p.cancel("aborted");
      return 1;
    }
    runType = picked as "models" | "config";
  } else runType = "models";

  // Asset roots FIRST — before any getWorkflow/runWorkflow. `--overlay` (or
  // LASTLIGHT_OVERLAY_DIR) layers a deployment's own workflows/skills over the
  // built-ins, and also contributes its `evals/datasets/` (see discovery).
  // With neither set, auto-detect a local `./instance/` overlay checkout — the
  // Separate layout `init --clone` produces — so a bare run "just works".
  // `--overlay` may REPEAT in config mode (one arm per overlay).
  const autoInstance = join(process.cwd(), "instance");
  const autoOverlay = existsSync(join(autoInstance, "config.yaml")) ? autoInstance : undefined;
  const overlayFlags = strFlagAll("overlay");
  let overlays: string[] = overlayFlags.length
    ? overlayFlags
    : [process.env.LASTLIGHT_OVERLAY_DIR ?? autoOverlay].filter((d): d is string => !!d);
  // In a config-mode TTY with no overlay given, ask for one (blank ⇒ core defaults).
  if (runType === "config" && !overlayFlags.length && process.stdin.isTTY) {
    const ans = await p.text({
      message: "Overlay dir whose config.yaml drives per-step models (blank = core defaults):",
      placeholder: overlays[0] ?? autoInstance,
      initialValue: overlays[0] ?? "",
    });
    if (p.isCancel(ans)) {
      p.cancel("aborted");
      return 1;
    }
    const dir = ans.trim();
    overlays = dir ? [dir] : [];
  }
  // The primary overlay wires discovery + the initial asset bootstrap. Config
  // arms re-bootstrap their own overlay before running (the asset root is a
  // process global — see the serial loop below).
  const overlayDir: string | undefined = overlays[0];
  if (overlayDir && overlayDir === autoOverlay) p.log.info(`overlay → ${chalk.cyan("./instance")} ${chalk.dim("(auto-detected)")}`);
  const { builtInRoot } = bootstrapAssets({ overlayDir });

  // Say WHICH core is about to run, at the top, every time. A published core and
  // a working tree can report the same version, so an arm measuring unreleased
  // engine work would otherwise look identical to one that never loaded it —
  // and every gate in the review-evidence-pipeline plan is a delta against a
  // stored baseline, where that reads as a real negative result.
  const core = describeCore(builtInRoot);
  p.log.info(
    `core → ${chalk.cyan(core.version)} ${core.published ? chalk.yellow("(published package)") : chalk.green("(working tree)")} ${chalk.dim(core.root)}`,
  );

  // A user/overlay can ship its own model registry too: explicit --models-file
  // wins, else an overlay's `evals/models.json` if present, else the built-in.
  const overlayModels = overlayDir ? join(overlayDir, "evals", "models.json") : undefined;
  const modelsFile = strFlag("models-file") ?? (overlayModels && existsSync(overlayModels) ? overlayModels : undefined);
  if (modelsFile) setModelsPath(modelsFile);

  // Discover tiers across built-in + user (--datasets) + overlay roots. With no
  // explicit `--datasets`, default to the workspace's own `./evals/datasets`
  // (what `init` seeds) so editing/adding tiers there is picked up automatically.
  const autoDatasets = join(process.cwd(), "evals", "datasets");
  const userDatasetsDir =
    strFlag("datasets") ?? process.env.LASTLIGHT_EVALS_DATASETS ?? (existsSync(autoDatasets) ? autoDatasets : undefined);
  const discovered = discoverTiers({
    builtinRoot: builtinDatasetsRoot(),
    userDatasetsDir,
    overlayDir,
  });

  if (!hasProviderKey()) {
    p.log.error(
      "No provider key found. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY)\n" +
        "in your environment or .env, then re-run `npm run eval`.",
    );
    p.outro(chalk.red("aborted"));
    return 1;
  }

  // `--repeats N` — run the WHOLE arm N times, as N sibling runs, so a result can
  // be reported as a band rather than a point. Three identical runs of one arm
  // measured micro-recall 0.320 / 0.080 / 0.200 (union 0.440, intersection 0.040
  // — 1 of 25 gold findings found by all three), and `diff-runs` returned KEEP on
  // one and REVERT on the other two FROM ONE CONFIGURATION. A single arm is not
  // a measurement of that arm.
  //
  // Emphatically NOT `--runs N`, which repeats each CASE and folds the trials
  // into one worst-case result with mean metrics (`aggregateTrials`): that
  // destroys the per-trial hit vectors, so it can never produce a band. The two
  // compose (`--repeats 3 --runs 2` = 3 bands of 2-trial cases), they do not
  // substitute.
  const repeats = intFlag("repeats", 1);
  // A repeat loop must never leave a dashboard server behind: `run` holds one open
  // FOREVER at the end (see the server-hold block), and on 2026-08-23 seven leaked
  // servers had accumulated overnight from ordinary single runs. N of them would be
  // worse, and the band is read afterwards anyway — so `--repeats` implies
  // `--no-open` and prints the standalone `serve` command once instead.
  const noOpen = process.argv.includes("--no-open") || !!process.env.CI || repeats > 1;
  const runs = intFlag("runs", 1);

  // Positional tier names — skip flags AND the values that follow value-flags.
  const argv = process.argv.slice(2);
  const requested: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) {
      i++; // its value isn't a tier
      continue;
    }
    if (!argv[i].startsWith("-")) requested.push(argv[i]);
  }

  const known = [...discovered.keys()];
  if (!known.length) {
    p.log.error(
      "No datasets found. The package ships `triage`/`code-fix`; add your own via\n" +
        "--datasets <dir> (or LASTLIGHT_EVALS_DATASETS), or --overlay <repo> with an\n" +
        "`evals/datasets/` folder.",
    );
    p.outro(chalk.red("aborted"));
    return 1;
  }
  const defaultTier = known.includes("triage") ? "triage" : known[0];

  // Tiers come from argv when given; otherwise ask interactively (one or all).
  // Non-interactive (CI / piped stdin) falls back to the cheapest default
  // so automation never blocks on a prompt.
  let chosen: string[];
  if (requested.length) {
    chosen = requested;
  } else if (process.stdin.isTTY) {
    const picked = await p.multiselect({
      message: "Which tiers to run?",
      options: known.map((name) => ({
        value: name,
        label: name + (discovered.get(name)!.source !== "builtin" ? chalk.dim(` (${discovered.get(name)!.source})`) : ""),
        hint: discovered.get(name)!.description,
      })),
      initialValues: [defaultTier],
      required: true,
    });
    if (p.isCancel(picked)) {
      p.cancel("aborted");
      return 1;
    }
    chosen = picked as string[];
  } else {
    chosen = [defaultTier];
  }

  // Stable display order (discovery order) regardless of pick order.
  const tiers = known.filter((t) => chosen.includes(t));
  for (const t of chosen) {
    if (!discovered.has(t)) p.log.warn(`Unknown tier "${t}". Known: ${known.join(", ")}`);
  }

  // An "arm" is one column of the comparison, behind the `Arm` seam (src/arm.ts):
  // `models` runs build one `modelsArm` per model (forced across every step);
  // `config` runs build one `configArm` per overlay (its merged per-step config
  // drives selection). Both flow through the same work-list → scorecard →
  // dashboard, keyed on the arm's `label`. run.ts owns *which* arms exist (the
  // flag + registry resolution below); the adapters own *how* to build one.
  //
  // The model-selection sub-mode (only meaningful for `models` runs) is shown in
  // the plan note; `config` runs report their arm count instead.
  const mode = runType === "config" ? "config" : modelArg ? "select" : compare ? "compare" : "single";
  let arms: Arm[];
  if (runType === "config") {
    // One arm per overlay (or a single core-defaults arm when none). `--model`
    // resolves to an id that overrides each merged config's `default` for quick
    // what-if runs (the override is applied inside configArm).
    const configOverlays = overlays.length ? overlays : [overlayDir];
    const defaultOverride = modelArg ? resolveModel(modelArg).id : undefined;
    arms = configOverlays.map((dir) => configArm(builtInRoot, dir, defaultOverride));
  } else {
    // Model selection precedence:
    //   1. --model / --models (or EVAL_MODEL[S]) — an explicit list, fuzzy-matched.
    //   2. --compare — the full cross-vendor set (key-gated).
    //   3. default single model from models.json.
    const entries = modelArg
      ? modelArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((tok) => {
            const r = resolveModel(tok);
            return { id: r.id, family: r.family };
          })
      : compare
        ? compareModels().map((m) => ({ id: m.id, family: m.envKey ?? m.provider ?? "default" }))
        : evalModels().map((id) => ({ id, family: "default" }));
    // The overlay goes in even though the model is forced: it also carries the
    // arm's `review:` policy (`review.analysis.enabled` — the review evidence
    // pipeline switch), which is a deployment fact a `--model` flag says nothing
    // about. Same overlay `bootstrapAssets` already wired above.
    arms = entries.map((e) => modelsArm(e.id, e.family, overlayDir));
  }
  if (!arms.length) {
    p.log.error(
      "No comparison models available — set provider keys (OPENAI_API_KEY / ANTHROPIC_API_KEY /\n" +
        "FIREWORKS_API_KEY …) for the entries in evals/models.json.",
    );
    p.outro(chalk.red("aborted"));
    return 1;
  }
  const labels = modelLabels();

  interface WorkItem {
    tierName: string;
    defaultWorkflow: string;
    datasetDir: string;
    /** The comparison arm — carries the axis label (`arm.label`, recorded as
     * InstanceResult.model), the family grouping, and all model selection.
     * Arm data is typed ONCE here, not re-flattened onto the work item. */
    arm: Arm;
    inst: SweBenchInstance;
  }

  // Optional instance filter: `--instance <id[,id2]>` or the `EVAL_INSTANCE` env
  // (the authoring docs point users at the latter to smoke-test a single new
  // case). Comma-separated, exact `instance_id` match.
  const instanceFilter = (strFlag("instance") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Optional `--limit N`: cap each tier to its first N instances (in file order),
  // applied AFTER `--instance`. For controlled/cheap runs — e.g. clone + grade
  // only the first few cases of a heavy tier. `--instance` selects *which* cases;
  // `--limit` bounds *how many*. Ignored when absent or non-positive.
  const limitRaw = strFlag("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    p.log.error(`--limit must be a positive integer, got "${limitRaw}".`);
    return 1;
  }

  // pr-review judge knobs (flags; `EVAL_F_BETA` env still honored as a fallback):
  //   --f-beta <n>       the F-beta β (1 = F1 default, 0.5 = precision 2×).
  //   --judge-with-diff  feed the PR diff to the judge (higher fidelity, off by
  //                      default — Martian's offline judge is diff-blind).
  const fBetaRaw = strFlag("f-beta");
  const fBeta = fBetaRaw !== undefined ? Number(fBetaRaw) : undefined;
  if (fBeta !== undefined && (!Number.isFinite(fBeta) || fBeta <= 0)) {
    p.log.error(`--f-beta must be a positive number, got "${fBetaRaw}".`);
    return 1;
  }
  const judge = { beta: fBeta, withDiff: process.argv.includes("--judge-with-diff") };

  // Repo-context injection (pr-review): a synthetic AGENTS.md/CLAUDE.md is dropped
  // into the seeded checkout from `<overlay>/repo-context/` (generic, every repo) +
  // `<datasetDir>/context/<id>/` (per-repo) so the reviewing agent reads it — see
  // run-instance's injection step. ON by default; `--no-inject-context` (or
  // `EVAL_INJECT_CONTEXT=0`) forces a clean control run for an A/B.
  const injectContext = !process.argv.includes("--no-inject-context") && process.env.EVAL_INJECT_CONTEXT !== "0";

  // Keep each trial's workspace instead of deleting it (`runInstance`'s
  // `finally`). The evidence pipeline's deliverable is files —
  // `.lastlight/pr-review/{facts.json,obligations/,hypotheses/,probes/}` — and
  // without this flag the only way to read one was to catch a live run
  // mid-flight, which is not an instrument. OFF by default: a kept workspace is
  // a full checkout, plus `node_modules` once `prepare` installs.
  //
  // `--repeats` forces it on: when the repeats disagree, the question is always
  // *which* evidence each one produced, and a previous repeat was already lost
  // for want of the flag. A band you cannot open is a band you cannot explain.
  const keepWorkspace = process.argv.includes("--keep-workspace") || repeats > 1;

  // Execution sandbox backend (or EVAL_SANDBOX). Default `none` (in-process, no
  // QEMU dependency — the fast/CI path). `gondolin` isolates the agent's tools
  // in a QEMU micro-VM so it can't read host gold data, while keeping the fake
  // GitHub mock (github_* stays in-process). `docker`/`smol` are accepted by the
  // type but break the mock as wired today — reject them here with guidance.
  const SANDBOX_BACKENDS = ["none", "gondolin", "docker", "smol"] as const;
  const sandbox = (strFlag("sandbox") ?? "none") as (typeof SANDBOX_BACKENDS)[number];
  if (!SANDBOX_BACKENDS.includes(sandbox)) {
    p.log.error(`--sandbox must be one of ${SANDBOX_BACKENDS.join("|")}, got "${sandbox}".`);
    return 1;
  }
  if (sandbox === "docker" || sandbox === "smol") {
    p.log.error(
      `--sandbox ${sandbox} isn't supported yet: it runs the whole agent inside the ` +
        `container/VM, where the in-process fake GitHub (githubApiBaseUrl) isn't reachable. ` +
        `Use --sandbox gondolin for isolation (keeps the mock), or --sandbox none.`,
    );
    return 1;
  }
  if (sandbox === "gondolin") {
    const probe = preflightSandbox(sandbox);
    if (!probe.ok) {
      p.log.error(probe.message);
      return 1;
    }
  }

  // `--concurrency N`: how many CASES of ONE arm run at once. Default 1, so an
  // invocation without the flag takes the exact serial path it always did.
  //
  // Within-arm serialism was never a correctness constraint — it is the
  // rate-limit choice recorded above `byFamily` below. Everything that makes
  // in-process concurrency safe is already true per case: a fresh `mkdtemp`
  // stateDir, its own fake-GitHub port, a threaded per-run `cwd` with no
  // `process.chdir`, and the eval env hoisted once for the whole batch. What is
  // NOT safe is two ARMS at once — see the overlay note where the pool is driven.
  const concurrencyRaw = strFlag("concurrency");
  let concurrency = concurrencyRaw !== undefined ? Number(concurrencyRaw) : 1;
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency < 1) {
    p.log.error(`--concurrency must be a positive integer, got "${concurrencyRaw}".`);
    return 1;
  }
  // gondolin boots a QEMU micro-VM per case. Clamp rather than error: the flag is
  // about throughput and the right answer on this backend is "one", not "refuse".
  if (sandbox === "gondolin" && concurrency > 1) {
    p.log.warn(`--concurrency ${concurrency} ignored: --sandbox gondolin runs a QEMU micro-VM per case. Using 1.`);
    concurrency = 1;
  }

  // `--repeat-concurrency N`: how many of the `--repeats` REPEATS run at once.
  // Default 1 = today's strictly-sequential repeat loop, untouched. With N>1 the
  // repeats of the arm overlap — safe because every repeat runs the SAME arm(s)
  // over ONE overlay, so the process-global asset-root guard (ADR 0001) is taken
  // once for the whole batch, exactly as `--concurrency` holds it per arm.
  //
  // What overlap costs is the LATENCY instrument: concurrent repeats contend for
  // CPU/network, so per-phase `durationMs`/`agentMs` on such runs are
  // contaminated. That trade is accepted and made legible — each repeat's
  // `meta.repeat.concurrency` records it so latency reads can be discounted.
  // Verdicts, cost, and recall/precision are unaffected.
  //
  // Composes with `--concurrency` (case-level): total in-flight cases =
  // repeatConcurrency × concurrency. No cap — size the product against the
  // provider's rate limit.
  const repeatConcurrencyRaw = strFlag("repeat-concurrency");
  let repeatConcurrency = repeatConcurrencyRaw !== undefined ? Number(repeatConcurrencyRaw) : 1;
  if (!Number.isFinite(repeatConcurrency) || !Number.isInteger(repeatConcurrency) || repeatConcurrency < 1) {
    p.log.error(`--repeat-concurrency must be a positive integer, got "${repeatConcurrencyRaw}".`);
    return 1;
  }
  // Same clamp-not-refuse policy as --concurrency: one QEMU micro-VM at a time.
  if (sandbox === "gondolin" && repeatConcurrency > 1) {
    p.log.warn(`--repeat-concurrency ${repeatConcurrency} ignored: --sandbox gondolin runs a QEMU micro-VM per case. Using 1.`);
    repeatConcurrency = 1;
  }
  // A multi-overlay `config` run switches the process-global asset root between
  // arms, so its repeats cannot overlap: two repeats in different arms would be
  // two overlays at once (the guard would throw — ADR 0001). One overlay per
  // batch is the invariant the concurrent branch is built on.
  if (runType === "config" && arms.length > 1 && repeatConcurrency > 1) {
    p.log.warn(
      `--repeat-concurrency ${repeatConcurrency} ignored: a multi-overlay config run switches the ` +
        `process-global asset root between arms (ADR 0001), so repeats must stay sequential. Using 1.`,
    );
    repeatConcurrency = 1;
  }
  if (repeats === 1 && repeatConcurrency > 1) {
    p.log.warn(`--repeat-concurrency ${repeatConcurrency} has nothing to overlap without --repeats N>1 — ignored.`);
    repeatConcurrency = 1;
  }
  /** True when the repeat loop actually overlaps (the concurrent branch below). */
  const repeatsConcurrent = repeats > 1 && repeatConcurrency > 1;

  // Instances per tier, resolved ONCE — the case set is identical across arms
  // (arms vary only the model selection / assets, never the cases).
  const tierInstances = new Map<string, SweBenchInstance[]>();
  for (const tierName of tiers) {
    const tier: Tier = discovered.get(tierName)!;
    const all = loadInstances(tier);
    const filtered = instanceFilter.length ? all.filter((i) => instanceFilter.includes(i.instance_id)) : all;
    const instances = limit !== undefined ? filtered.slice(0, limit) : filtered;
    if (!instances.length) {
      const why = instanceFilter.length ? ` matching --instance ${instanceFilter.join(",")}` : ` at ${tier.instancesPath}`;
      p.log.warn(`tier "${tierName}": no instances${why} — skipping`);
      continue;
    }
    if (limit !== undefined && filtered.length > instances.length) {
      p.log.info(`tier "${tierName}": limited to first ${instances.length} of ${filtered.length} instances (--limit ${limit})`);
    }
    tierInstances.set(tierName, instances);
  }
  if (instanceFilter.length && tierInstances.size === 0) {
    p.log.error(`No instances matched --instance ${instanceFilter.join(",")} in tier(s) ${tiers.join(", ")}.`);
    return 1;
  }

  // Resolve the work-list up front so we can show deterministic progress. Arms
  // are the OUTER loop so a `config` run's per-arm overlay switches at most once
  // (the serial loop re-bootstraps on arm change; see below).
  const work: WorkItem[] = [];
  for (const arm of arms) {
    for (const [tierName, instances] of tierInstances) {
      const tier: Tier = discovered.get(tierName)!;
      for (const inst of instances) {
        // Per-instance workflow wins, else the tier's defaultWorkflow (throws if
        // neither is set — surfaced as a harness error for that case).
        work.push({
          tierName,
          defaultWorkflow: workflowFor(tier, inst),
          datasetDir: tier.root,
          arm,
          inst,
        });
      }
    }
  }

  if (!work.length) {
    p.log.error("Nothing to run — no datasets matched the requested tiers.");
    p.outro(chalk.red("aborted"));
    return 1;
  }

  // Prefetch git-source repos + pr-review checkouts into the repo-local cache,
  // SERIALLY and once per repo / (repo, PR), BEFORE the (possibly parallel) batch —
  // concurrent clones of the same repo race, and after this each per-run checkout is
  // fully offline. A vendored `repos/<id>/` fixture skips the clone (not a
  // git-source case); pr-review fetches `refs/pull/<n>/head` for squash/rebase-merged
  // PRs. Returns false (after printing the failure) on a cache error so the caller
  // aborts. DEFERRED until AFTER the dashboard server is up (below): a cold clone can
  // take minutes, and gating the browser open behind it makes the dashboard look
  // hung — this way it opens immediately and shows the plan + pending cases while
  // the prefetch runs.
  const prefetchSources = (): boolean => {
    const gitRepos = new Map<string, string>(); // repo -> a base sha to verify
    for (const w of work) {
      const fixture = join(w.datasetDir, "repos", w.inst.instance_id);
      if (existsSync(fixture)) continue;
      if (isRealSha(w.inst.base_commit) && /^[^/]+\/[^/]+$/.test(w.inst.repo) && !gitRepos.has(w.inst.repo)) {
        gitRepos.set(w.inst.repo, w.inst.base_commit);
      }
    }
    if (gitRepos.size) {
      const s = p.spinner();
      s.start(`Caching ${gitRepos.size} git-source repo(s)…`);
      try {
        for (const [repo, baseCommit] of gitRepos) {
          s.message(`Caching ${repo}…`);
          ensureRepoCache({ repo, baseCommit });
        }
        s.stop(`Cached ${gitRepos.size} git-source repo(s).`);
      } catch (err) {
        s.stop(chalk.red(`Failed to cache a git-source repo: ${(err as Error).message}`));
        return false;
      }
    }

    const seenPr = new Set<string>();
    const prToFetch = work.filter((w) => {
      if (!w.inst.pr || !/^[^/]+\/[^/]+$/.test(w.inst.repo)) return false;
      // Only a case that will actually be CHECKED OUT from git needs its PR
      // commits mirrored. A synthetic PR — the dependency-merge tier states its
      // diff in the fixture and never clones anything — carries placeholder
      // SHAs, and trying to fetch them aborts the whole run on a repo that does
      // not exist. `isRealSha` rejects the all-zero placeholder, which is the
      // same discriminator `run-instance.ts` seeds by.
      if (!isRealSha(w.inst.pr.base_commit) || !isRealSha(w.inst.pr.head_commit)) return false;
      const k = `${w.inst.repo}#${w.inst.pr.number}`;
      if (seenPr.has(k)) return false;
      seenPr.add(k);
      return true;
    });
    if (prToFetch.length) {
      const s = p.spinner();
      s.start(`Caching ${prToFetch.length} PR checkout(s)…`);
      try {
        for (const w of prToFetch) {
          s.message(`Caching ${w.inst.repo}#${w.inst.pr!.number}…`);
          ensurePrCommitsInCache({
            repo: w.inst.repo,
            pullNumber: w.inst.pr!.number,
            baseCommit: w.inst.pr!.base_commit,
            headCommit: w.inst.pr!.head_commit,
          });
        }
        s.stop(`Cached ${prToFetch.length} PR checkout(s).`);
      } catch (err) {
        s.stop(chalk.red(`Failed to cache a PR checkout: ${(err as Error).message}`));
        return false;
      }
    }
    return true;
  };

  // Group work by provider family. Families run CONCURRENTLY (independent
  // provider keys / rate limits); within a family runs stay serial. Force
  // serial with --serial or when there's only one family.
  const byFamily = new Map<string, WorkItem[]>();
  for (const w of work) {
    const arr = byFamily.get(w.arm.family);
    if (arr) arr.push(w);
    else byFamily.set(w.arm.family, [w]);
  }
  // `config` runs stay SERIAL: arms may carry distinct overlays and the asset
  // root is a process global, so the serial loop re-bootstraps per arm (below).
  const parallel = runType === "models" && !process.argv.includes("--serial") && byFamily.size > 1;

  // Each tier writes its OWN folder + scorecard (all sharing this run's id), so
  // tiers stay separate in the dashboard instead of collapsing into one combined
  // `<a+b>` entry. A single invocation appears as the same run under each tier it
  // touched. The `-compare` suffix keeps cross-vendor runs on their own trend
  // line, distinct from single-model runs of the same tier. The dashboard server
  // indexes the whole tree; each tier dir is a `tierKey` segment the SPA routes on.
  // `-compare` keeps cross-vendor runs on their own trend line; `-config` keeps
  // config-eval runs on theirs — so the three run shapes never collapse together.
  const gitSha = gitShortSha();
  const tierKeyFor = (tier: string) => `${tier}${runType === "config" ? "-config" : compare ? "-compare" : ""}`;
  // One shared runId, checked free in the first tier's dir (collisions in the
  // same second across runs are what the suffix guards — rare, one dir suffices).
  //
  // `let`, not `const`, and reassigned once per `--repeats` iteration. Every
  // closure below that names a run directory — `resultsDirFor`, `baseMetaFor`,
  // the session paths built from them — reads `runId` at CALL time, so a single
  // reassignment repoints all of them with no code movement. Repeats are SIBLING
  // dirs (`<tierKey>/<runId>/`, a fresh id each time): `indexTier` and `clean`
  // both walk exactly two levels, so a nested `<runId>/rep-2/` would be invisible
  // to the dashboard AND uncleanable. `makeRunId`'s existing `-2`/`-3` suffix
  // already handles two repeats finishing inside the same second.
  //
  // CONCURRENT repeats (`--repeat-concurrency N>1`) can't assign lazily — N
  // launches inside one second would all resolve the same id, because the ids
  // exist nowhere on disk yet for `makeRunId` to dedupe against. So the whole
  // band's ids are PRE-ASSIGNED here (`assignRunIds` bumps the second per id,
  // keeping every id `<timestamp>-<sha>`-shaped with a batch-unique stamp) and
  // each repeat's state carries its own. The sequential path keeps lazy
  // assignment, one fresh id per repeat, exactly as before.
  const preassignedRunIds = repeatsConcurrent
    ? assignRunIds(repeats, new Date(), gitSha, tierResultsDir(tierKeyFor(tiers[0])))
    : undefined;
  let runId = preassignedRunIds?.[0] ?? makeRunId(new Date(), gitSha, tierResultsDir(tierKeyFor(tiers[0])));
  /** The band's id = the FIRST repeat's runId (see `RepeatRef`) — pre-assigned
   * before any repeat launches, so the group label never depends on run order. */
  const repeatGroup = runId;
  /** 1-based position in the band; bumped by the (sequential) repeat loop. */
  let repeatIndex = 1;
  const resultsDirFor = (tier: string, rid: string = runId) => join(tierResultsDir(tierKeyFor(tier)), rid);
  // Each case's session logs live under `sessions/<id>__<model>/trial-<N>/`
  // (relative to the tier run dir) — the model is in the name since several
  // models share a run dir; per-trial keeps every `--runs N` trial. `full.jsonl`
  // is the consolidated live-followable transcript; `NN-<phase>.jsonl` are the
  // per-phase splits written when the trial finishes.
  const caseRelFor = (instanceId: string, model: string) => `sessions/${slug(instanceId)}__${slug(model)}`;
  const trialRelFor = (instanceId: string, model: string, trial: number) =>
    `${caseRelFor(instanceId, model)}/trial-${trial}`;
  // Per-tier run metadata stamped into every scorecard write (the dashboard reads
  // identity, labels, and live state straight off disk). `live`/`progress`/
  // `pending`/`generatedAt` are layered on per write; `tiers` is the single tier.
  const armLabels = arms.map((a) => labels[a.label] ?? a.label);

  // The invocation, recorded beside the numbers it produced (see `RunProvenance`).
  // Resolved ONCE — none of it varies per repeat, and the facts-toolchain probe
  // spawns a process. `judgeModel`/`factsBin` are what this run WOULD use, which
  // is the point: an arm reporting `coverage: "none"` is explained by a null
  // `factsBin`, and a scorecard whose judge silently changed between two runs is
  // otherwise indistinguishable from one where the models changed.
  const factsBin = resolveFactsBin();
  let judgeModel: string | undefined;
  try {
    judgeModel = defaultJudgeModel();
  } catch {
    judgeModel = undefined; // no provider key resolves one; already fatal above for models
  }
  const provenance: RunProvenance = {
    overlay: overlayDir,
    overlays: overlays.length ? overlays : undefined,
    datasets: userDatasetsDir,
    sandbox,
    fBeta: fBeta ?? defaultBeta(),
    judgeWithDiff: judge.withDiff,
    injectContext,
    keepWorkspace,
    instances: instanceFilter.length ? instanceFilter : undefined,
    limit,
    repeats: repeats > 1 ? repeats : undefined,
    judgeModel,
    factsBin,
    toolchain: factsToolchainStamp(factsBin),
    harness: { version: harnessVersion(), root: packageRoot() },
    argv: process.argv.slice(2),
  };

  // `rid`/`idx` default to the sequential loop's shared `runId`/`repeatIndex`;
  // a CONCURRENT repeat passes its own (two repeats in flight cannot share one).
  const baseMetaFor = (tier: string, rid: string = runId, idx: number = repeatIndex): Omit<RunMeta, "generatedAt"> => ({
    // Flat on `meta`, exactly like `gitSha`/`concurrency`/`core`.
    ...provenance,
    runId: rid,
    runType,
    tiers: [tier],
    models: armLabels,
    runs,
    concurrency,
    // A band of one is not a band — an ordinary run's meta stays exactly as it
    // was, and `undefined` reads as "not repeated" rather than "repeated once".
    // `repeat.concurrency` is stamped only when the repeats actually overlapped
    // (`--repeat-concurrency N>1`) — the flag that contaminates per-phase
    // latency, recorded so `durationMs`/`agentMs` reads can be discounted.
    repeat:
      repeats > 1
        ? {
            group: repeatGroup,
            index: idx,
            of: repeats,
            ...(repeatsConcurrent ? { concurrency: repeatConcurrency } : {}),
          }
        : undefined,
    gitSha,
    labels,
    core: describeCore(builtInRoot),
  });

  // pr-review: load each tier's Martian leaderboard sidecar ONCE. Lets every
  // scorecard carry "where would we rank" over the PRs it covered (recomputed per
  // write so it fills in live). Tiers that ship no sidecar just get `undefined`.
  const martianSidecars = new Map<string, MartianSidecar | undefined>();
  for (const tier of tiers) {
    const root = discovered.get(tier)?.root;
    martianSidecars.set(tier, root ? loadMartianSidecar(root) : undefined);
  }
  const martianFor = (tier: string, tierResults: InstanceResult[]) => {
    const sc = martianSidecars.get(tier);
    return sc ? computeMartianRanking(tierResults, sc) : undefined;
  };

  // In `config` runs the axis is the config(s); show the merged per-step model
  // map for a single-arm run so the plan is legible.
  const axisLine =
    runType === "config"
      ? `${chalk.bold("configs")} ${armLabels.join(", ")}`
      : `${chalk.bold("models")}  ${armLabels.join(", ")}`;
  // For a single-arm run, show the per-step model map (config arms) so the plan
  // is legible. `describe()` returns the summary for config arms, undefined for
  // models arms — the reach into the arm's config map stays behind the seam.
  const armSummary = arms.length === 1 ? arms[0].describe() : undefined;
  const phaseMapLine = armSummary ? `\n${chalk.bold("models")}  ${chalk.dim(armSummary)}` : "";
  p.note(
    `${chalk.bold("mode")}    ${mode}${
      parallel ? chalk.dim(` (parallel · ${byFamily.size} families)`) : ""
    }\n` +
      `${axisLine}${phaseMapLine}\n` +
      `${chalk.bold("tiers")}   ${tiers.join(", ")}\n` +
      `${chalk.bold("cases")}   ${work.length}${
        runs > 1
          ? chalk.dim(` × ${runs} trials = ${work.length * runs} runs · worst-case verdict, mean cost`)
          : ""
      }${
        repeats > 1
          ? `\n${chalk.bold("repeats")} ${repeats}${chalk.dim(
              ` × the whole arm, ${
                repeatsConcurrent
                  ? `up to ${repeatConcurrency} at once (per-phase latency contends — stamped meta.repeat.concurrency)`
                  : "sequentially"
              } · ${repeats} sibling runs, read as a band (implies --keep-workspace, --no-open)`,
            )}`
          : ""
      }`,
    "plan",
  );

  // `total` counts individual trials so live progress advances per model call.
  const total = work.length * runs;

  // Seed an empty live scorecard per tier so the dashboard has something to poll.
  // Called once per repeat, AFTER `runId` has been repointed, so each sibling run
  // dir exists from the moment its repeat starts rather than only when it ends.
  const seedScorecards = (rid: string = runId, idx: number = repeatIndex) => {
    for (const tier of tiers) {
      writeScorecard(
        resultsDirFor(tier, rid),
        withMeta(summarize([]), {
          ...baseMetaFor(tier, rid, idx),
          generatedAt: new Date().toISOString(),
          live: true,
          pid: process.pid,
          heartbeat: new Date().toISOString(),
          progress: `0/${total}`,
        }),
      );
    }
  };
  // Repeat 1's seed lands BEFORE the server starts (the SPA must have something
  // to poll the instant it opens deep-linked at this run) and before the possibly
  // slow prefetch.
  seedScorecards();
  let server: RunningServer | undefined;
  if (!noOpen) {
    try {
      server = await startServer({ resultsRoot: resultsRoot(), dashboardRoot: dashboardDistRoot() });
      const runUrl = `${server.url}/#/${encodeURIComponent(tierKeyFor(tiers[0]))}/${encodeURIComponent(runId)}`;
      openInBrowser(runUrl);
      p.log.info(`Live dashboard → ${chalk.cyan(runUrl)}`);
    } catch (err) {
      p.log.warn(`Couldn't start the dashboard server (${(err as Error).message}) — writing JSON only.`);
    }
  }

  // With the dashboard already open above, do the (possibly slow) source prefetch —
  // a cold clone now shows as pending in the dashboard instead of a blank wait. On
  // failure, tear the server down so the open listening socket doesn't keep the
  // process alive past the abort.
  if (!prefetchSources()) {
    if (server) await server.close();
    p.outro(chalk.red("aborted"));
    return 1;
  }

  // The per-repeat accumulators. Declared ONCE, outside the repeat loop, because
  // `refresh`/`runItem` close over them — the loop RESETS them in place rather
  // than rebinding, so every closure keeps pointing at the live objects.
  const all: InstanceResult[] = [];
  let harnessErrors = 0;
  let completed = 0;
  /** Harness errors across ALL repeats — what the exit code is read from. A band
   * whose first repeat blew up and whose last was clean is not a clean run. */
  let totalHarnessErrors = 0;
  /** Trials + cases summed over every repeat, for the closing line. */
  let totalCompleted = 0;
  let totalCases = 0;

  // Track in-flight cases so the live report can show running / queued rows.
  const caseKey = (tier: string, model: string, id: string) => `${tier}|${model}|${id}`;
  const running = new Set<string>();
  // Current trial number per running case, so the live "follow" link points at
  // the right `trial-<N>/full.jsonl` (matters only for `--runs N>1`).
  const trialOf = new Map<string, number>();

  /**
   * One CONCURRENT repeat's private accumulators (`--repeat-concurrency N>1`).
   * The sequential path keeps using the module-of-`runEval` accumulators above
   * — `refresh()`/`runItem()` fall back to them when no state is passed, so the
   * default `--repeat-concurrency 1` run takes the exact code path it always
   * did. Each concurrent repeat carries its own state instead: two repeats in
   * flight cannot share one `all`/`running`/`completed` without writing each
   * other's scorecards.
   */
  interface RepeatState {
    /** This repeat's pre-assigned sibling runId (see `assignRunIds`). */
    runId: string;
    /** 1-based position in the band (`meta.repeat.index`). */
    index: number;
    all: InstanceResult[];
    harnessErrors: number;
    completed: number;
    running: Set<string>;
    trialOf: Map<string, number>;
  }
  /** The concurrent repeats currently in flight — what the heartbeat re-stamps. */
  const activeStates = new Set<RepeatState>();

  // writeScorecard/summarize/all.push run synchronously to completion inside one
  // event-loop turn, so even with concurrent families they never interleave; the
  // temp-file+rename keeps a polling dashboard from reading a half-written file.
  const refresh = (st?: RepeatState) => {
    // A concurrent repeat's own accumulators, else the sequential shared ones.
    const results = st?.all ?? all;
    const inFlight = st?.running ?? running;
    const trialNo = st?.trialOf ?? trialOf;
    const done = new Set(results.map((r) => caseKey(r.tier ?? "", r.model, r.instance_id)));
    const now = new Date().toISOString();
    for (const tier of tiers) {
      const tierResults = results.filter((r) => (r.tier ?? "") === tier);
      const pending: PendingCase[] = work
        .filter((w) => w.tierName === tier)
        .map((w) => ({ w, k: caseKey(w.tierName, w.arm.label, w.inst.instance_id) }))
        .filter(({ k }) => !done.has(k))
        .map(({ w, k }) => ({
          tier: w.tierName,
          model: w.arm.label,
          instance_id: w.inst.instance_id,
          status: inFlight.has(k) ? "running" : "pending",
          // Only a running case has a (live-updating) transcript to follow —
          // point at the current trial's consolidated `full.jsonl`.
          sessionLog: inFlight.has(k)
            ? `${trialRelFor(w.inst.instance_id, w.arm.label, trialNo.get(k) ?? 1)}/full.jsonl`
            : undefined,
        }));
      // Per-tier progress (cases), not the global trial count — each tier's
      // scorecard stands alone, so "0/5" across both tiers was misleading.
      const tierCases = work.filter((w) => w.tierName === tier).length;
      writeScorecard(
        resultsDirFor(tier, st?.runId),
        withMeta(summarize(tierResults), {
          ...baseMetaFor(tier, st?.runId, st?.index),
          generatedAt: now,
          live: true,
          // Liveness signals: a `live` run whose heartbeat goes stale (writer
          // killed/crashed) is shown as interrupted, not running. The ticker
          // below refreshes this even during a long single phase.
          pid: process.pid,
          heartbeat: now,
          progress: `${tierResults.length}/${tierCases}`,
          pending,
          martian: martianFor(tier, tierResults),
        }),
      );
    }
  };

  // NOT reset between repeats: its only consumer is the end-of-run summary, and
  // the whole reason `--repeats` forces `--keep-workspace` is that you need to
  // open EVERY repeat's evidence when they disagree. A per-repeat reset would
  // print only the last one's paths and silently orphan the rest.
  const keptWorkspaces: { id: string; trial: number; repeat: number; path: string }[] = [];

  // Run one case `runs` times and fold the trials into a single result
  // (worst-case verdict, mean metrics). `onTrial` ticks per model call. `st` is
  // a concurrent repeat's own state (`--repeat-concurrency N>1`); absent, the
  // sequential shared accumulators are used, unchanged.
  const runItem = async (w: WorkItem, onTrial: () => void, st?: RepeatState): Promise<InstanceResult> => {
    const k = caseKey(w.tierName, w.arm.label, w.inst.instance_id);
    const trials: InstanceResult[] = [];
    // Collected per TRIAL, not off the aggregate: `aggregateTrials` carries
    // trial 1's fields through, so with `--runs 3` the other two workspaces
    // would still be on disk and named nowhere.
    for (let t = 1; t <= runs; t++) {
      (st?.trialOf ?? trialOf).set(k, t); // so the live "follow" link targets this trial
      const trialRel = trialRelFor(w.inst.instance_id, w.arm.label, t);
      const r = await runInstance(w.inst, {
        // The arm carries all model selection (forced model / merged config) +
        // the axis label; runInstance calls its prepare()/recordPhaseModel().
        arm: w.arm,
        datasetDir: w.datasetDir,
        // Generic repo-context lives in the (primary) overlay; per-repo context in
        // the tier dataset. In config mode with per-arm overlays this uses the
        // primary — generic injection is aimed at the models-mode improvement loop.
        overlayDir,
        injectContext,
        defaultWorkflow: w.defaultWorkflow,
        manageEnv: false,
        // Per-trial dir: `full.jsonl` (consolidated, live) + `NN-<phase>.jsonl`.
        sessionTrialDir: join(resultsDirFor(w.tierName, st?.runId), trialRel),
        sessionTrialRel: trialRel,
        trial: t,
        judge,
        sandbox,
        keepWorkspace,
      });
      r.tier = w.tierName;
      if (r.workspaceDir)
        keptWorkspaces.push({ id: w.inst.instance_id, trial: t, repeat: st?.index ?? repeatIndex, path: r.workspaceDir });
      trials.push(r);
      if (st) st.completed++;
      else completed++;
      onTrial();
    }
    const agg = aggregateTrials(trials);
    // Keep every trial's per-phase sessions on the aggregate (aggregateTrials
    // only carries trial 0's fields through).
    agg.sessions = trials.map((r) => r.sessionTrial).filter((s): s is TrialSession => !!s);
    return agg;
  };

  // Install the eval's static-token env ONCE for the whole batch so concurrent
  // runs share one stable baseline (manageEnv:false on every runInstance).
  const restoreEvalEnv = applyEvalEnv();
  // Heartbeat: re-stamp the live scorecard every 20s so a long-running single
  // phase keeps its `heartbeat` fresh; if the process dies the stamp goes stale
  // and the index reclassifies the run as interrupted. `unref` so the timer
  // never keeps the process alive on its own. With concurrent repeats each
  // in-flight repeat's OWN scorecard is re-stamped (never the shared one — its
  // accumulators are unused there, and a shared refresh would overwrite repeat
  // 1's card with an empty live one).
  const heartbeat = setInterval(() => {
    if (repeatsConcurrent) for (const st of activeStates) refresh(st);
    else refresh();
  }, 20_000);
  heartbeat.unref?.();
  /** Every repeat's per-tier artifact dirs, for the closing summary. */
  const repeatDirs: string[] = [];
  try {
    if (repeatsConcurrent) {
      // ── `--repeat-concurrency N>1`: up to N whole-arm repeats in flight ──
      //
      // Everything the repeats share is BATCH-scoped, the same shape as the
      // case-concurrent branch below, widened to span the repeats:
      //
      //  - ONE overlay for the whole batch. Every repeat runs the same arm
      //    list, so the process-global asset root (ADR 0001) is activated once
      //    here and released once in the finally — the guard window covers the
      //    entire batch. (Multi-overlay config runs clamped the flag to 1 up
      //    top: they have no single overlay for the window to hold.
      //    `activate()` is a no-op for models arms.)
      //  - Console is silenced ONCE (the per-run `quiet()` swap is not
      //    concurrency-safe) and one spinner reports every repeat — the same
      //    trade the parallel branches below make.
      //  - RunIds were pre-assigned (`preassignedRunIds`), so simultaneous
      //    launches cannot collide on the second; each repeat's `RepeatState`
      //    carries its own id, index, and accumulators.
      //
      // Within a repeat, cases run through the same arms-outer work list with
      // `--concurrency` bounding cases in flight — so the total is
      // repeatConcurrency × concurrency. In models mode several arms' cases
      // interleave here (no overlay is at stake, only the provider rate limit);
      // the per-family grouping of the parallel branch is deliberately not
      // reproduced — repeat-level parallelism is the throughput lever.
      const states: RepeatState[] = preassignedRunIds!.map((rid, i) => ({
        runId: rid,
        index: i + 1,
        all: [],
        harnessErrors: 0,
        completed: 0,
        running: new Set<string>(),
        trialOf: new Map<string, number>(),
      }));
      p.log.step(
        `${chalk.bold(`repeats ×${repeats}, up to ${repeatConcurrency} at once`)}\n` +
          chalk.dim(states.map((st) => `  ${st.index}/${repeats} ${st.runId}`).join("\n")),
      );
      for (const arm of arms) arm.activate();
      const grandTotal = total * repeats;
      const grand = () => states.reduce((n, st) => n + st.completed, 0);
      const s = makeSpinner();
      const status = () =>
        `${chalk.dim(`${grand()}/${grandTotal}`)}  ${states
          .map((st) => {
            const seg = `r${st.index} ${st.completed}/${total}`;
            return st.completed === total ? chalk.green(seg) : seg;
          })
          .join(chalk.dim(" · "))}`;
      s.start(status());
      const restoreConsole = silenceConsole();
      const verdicts: string[] = [];
      try {
        await mapPool(states, repeatConcurrency, async (st) => {
          // Repeat 1's live scorecard was seeded before the server started /
          // the prefetch ran, like any run's; a later repeat seeds its sibling
          // dir the moment it LAUNCHES here, so the dashboard sees it live.
          if (st.index > 1) seedScorecards(st.runId, st.index);
          activeStates.add(st);
          try {
            await mapPool(work, concurrency, async (w) => {
              const k = caseKey(w.tierName, w.arm.label, w.inst.instance_id);
              st.running.add(k);
              refresh(st);
              const result = await runItem(
                w,
                () => {
                  s.message(status());
                  refresh(st);
                },
                st,
              );
              st.running.delete(k);
              st.all.push(result);
              if (result.error) st.harnessErrors++;
              const mark = result.error ? chalk.red("✗") : result.blocked ? chalk.yellow("■") : chalk.green("✓");
              verdicts.push(`${mark} ${chalk.dim(`r${st.index}/${repeats}`)}  ${verdictLine(w.tierName, w.inst, result)}`);
              s.message(status());
              refresh(st);
            });
          } finally {
            activeStates.delete(st);
          }
          // Finalize THIS repeat as it lands — its siblings may still be running.
          const generatedAt = new Date().toISOString();
          for (const tier of tiers) {
            const tierResults = st.all.filter((r) => (r.tier ?? "") === tier);
            writeArtifacts(
              resultsDirFor(tier, st.runId),
              withMeta(summarize(tierResults), {
                ...baseMetaFor(tier, st.runId, st.index),
                generatedAt,
                live: false,
                martian: martianFor(tier, tierResults),
              }),
            );
            repeatDirs.push(resultsDirFor(tier, st.runId));
          }
          totalHarnessErrors += st.harnessErrors;
          totalCompleted += st.completed;
          totalCases += st.all.length;
        });
      } finally {
        restoreConsole();
        // The batch-wide overlay window closes exactly once, whatever happened.
        releaseOverlayGuard();
      }
      s.stop(`${chalk.dim(`${grand()}/${grandTotal}`)} ${chalk.green("done")}`);
      p.log.message(verdicts.join("\n"));
    } else
    // `--repeats N` (sequential, the default): the WHOLE arm, N times, one
    // after another. Overlapping is opt-in (`--repeat-concurrency`, the branch
    // above) because concurrent repeats contend for CPU/network and the same
    // provider rate limit — which contaminates the per-phase latency this
    // sequential path keeps clean.
    for (repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
      if (repeatIndex > 1) {
        // A fresh SIBLING run id. Every closure that names a run dir reads
        // `runId` at call time, so this one assignment repoints all of them.
        // `makeRunId`'s `-2`/`-3` suffix covers two repeats landing in the same
        // second (a `--limit 1` smoke run can).
        runId = makeRunId(new Date(), gitSha, tierResultsDir(tierKeyFor(tiers[0])));
        // Reset the accumulators IN PLACE — `refresh`/`runItem` closed over these
        // objects, so rebinding them would leave the closures on the old ones.
        // `keptWorkspaces` is deliberately NOT reset (see its declaration).
        all.length = 0;
        harnessErrors = 0;
        completed = 0;
        running.clear();
        trialOf.clear();
        seedScorecards();
        p.log.step(`${chalk.bold(`repeat ${repeatIndex}/${repeats}`)} ${chalk.dim(runId)}`);
      }
      try {
        if (parallel) {
          // Per-family progress for the aggregate spinner line.
          const fam = new Map<string, { done: number; total: number }>();
          for (const [f, items] of byFamily) fam.set(f, { done: 0, total: items.length * runs });
          const status = () => {
            const segs = [...fam].map(([f, c]) => {
              const done = c.done === c.total ? chalk.green(`${c.done}/${c.total}`) : `${c.done}/${c.total}`;
              return `${familyLabel(f)} ${done}`;
            });
            return `${chalk.dim(`${completed}/${total}`)}  ${segs.join(chalk.dim(" · "))}`;
          };
          const s = makeSpinner();
          s.start(status());
          const restoreConsole = silenceConsole();
          const verdicts: string[] = [];
          try {
            await Promise.all(
              [...byFamily].map(async ([f, items]) => {
                // Within a family, `--concurrency` bounds how many of its cases are
                // in flight. `models` arms never switch overlays (`activate()` is a
                // no-op for them), which is why this branch needs no arm grouping —
                // see the `config`/overlay note in the serial branch below.
                await mapPool(items, concurrency, async (w) => {
                  const k = caseKey(w.tierName, w.arm.label, w.inst.instance_id);
                  running.add(k);
                  refresh();
                  const result = await runItem(w, () => {
                    fam.get(f)!.done++;
                    s.message(status());
                    refresh();
                  });
                  running.delete(k);
                  all.push(result);
                  if (result.error) harnessErrors++;
                  const mark = result.error ? chalk.red("✗") : result.blocked ? chalk.yellow("■") : chalk.green("✓");
                  verdicts.push(`${mark} ${chalk.dim(familyLabel(f))}  ${verdictLine(w.tierName, w.inst, result)}`);
                  refresh();
                });
              }),
            );
          } finally {
            restoreConsole();
          }
          s.stop(`${chalk.dim(`${completed}/${total}`)} ${chalk.green("done")}`);
          p.log.message(verdicts.join("\n"));
        } else if (concurrency > 1) {
          // Concurrent WITHIN one arm, strictly serial ACROSS arms.
          //
          // The asset root core resolves workflows/skills/prompts from is a module
          // GLOBAL (ADR 0001), so two overlays can never be live at once — which is
          // what `activateOverlay`/`releaseOverlayGuard` enforce by throwing. Running
          // arms concurrently would therefore either throw or, worse, measure one
          // arm's cases against another arm's prompts. So the pool is opened and
          // closed inside each arm's overlay window, never across it.
          //
          // Cases within one arm have nothing global between them: per-run `mkdtemp`
          // stateDir, per-run fake-GitHub port, a threaded `cwd` (never
          // `process.chdir`), and the static-token env installed once for the batch.
          const groups: { arm: Arm; items: WorkItem[] }[] = [];
          for (const w of work) {
            const tail = groups[groups.length - 1];
            if (tail && tail.arm === w.arm) tail.items.push(w);
            else groups.push({ arm: w.arm, items: [w] });
          }

          const s = makeSpinner();
          const status = () => `${chalk.dim(`${completed}/${total}`)}  ${chalk.dim(`×${concurrency}`)}`;
          s.start(status());
          // The per-case `quiet()` swap saves/restores `console` and is NOT
          // re-entrant, so concurrency drops console for the batch instead — the
          // same trade the family-parallel branch makes.
          const restoreConsole = silenceConsole();
          const verdicts: string[] = [];
          try {
            for (const g of groups) {
              g.arm.activate();
              try {
                await mapPool(g.items, concurrency, async (w) => {
                  // The invariant this whole branch is built on, asserted rather
                  // than assumed: one overlay is live and it is this arm's.
                  if (w.arm !== g.arm) throw new Error(`concurrency crossed an arm boundary: ${w.arm.label} in ${g.arm.label}`);
                  const k = caseKey(w.tierName, w.arm.label, w.inst.instance_id);
                  running.add(k);
                  refresh();
                  const result = await runItem(w, () => {
                    s.message(status());
                    refresh();
                  });
                  running.delete(k);
                  all.push(result);
                  if (result.error) harnessErrors++;
                  const mark = result.error ? chalk.red("✗") : result.blocked ? chalk.yellow("■") : chalk.green("✓");
                  verdicts.push(
                    `${mark} ${chalk.dim(labels[w.arm.label] ?? w.arm.label)}  ${verdictLine(w.tierName, w.inst, result)}`,
                  );
                  s.message(status());
                  refresh();
                });
              } finally {
                // Release before the next arm activates, or the guard reads the
                // switch as a second concurrent overlay and throws.
                releaseOverlayGuard();
              }
            }
          } finally {
            restoreConsole();
          }
          s.stop(`${chalk.dim(`${completed}/${total}`)} ${chalk.green("done")}`);
          p.log.message(verdicts.join("\n"));
        } else {
          // Serial: one spinner per case (updates per trial) + a verdict line. On
          // each arm change `arm.activate()` repoints the (process-global) asset root
          // to that arm's overlay (a no-op for models arms); work is arms-outer, so
          // it fires at most once per arm. `releaseOverlayGuard()` lets the next arm
          // switch overlays — without it the guard treats the switch as a concurrent
          // overlay and throws (ADR 0001).
          let currentArm: Arm | undefined;
          for (let i = 0; i < work.length; i++) {
            const w = work[i];
            if (w.arm !== currentArm) {
              if (currentArm) releaseOverlayGuard();
              w.arm.activate();
              currentArm = w.arm;
            }
            const s = makeSpinner();
            const head = `${chalk.dim(`[${i + 1}/${work.length}]`)} ${chalk.cyan(w.tierName)}/${w.inst.instance_id}  ${chalk.dim(labels[w.arm.label] ?? w.arm.label)}`;
            s.start(head);

            const k = caseKey(w.tierName, w.arm.label, w.inst.instance_id);
            running.add(k);
            refresh();
            let t = 0;
            const { value: result, logs } = await quiet(() =>
              runItem(w, () => {
                t++;
                if (runs > 1) s.message(`${head}  ${chalk.dim(`trial ${t}/${runs}`)}`);
                refresh();
              }),
            );
            running.delete(k);
            all.push(result);
            if (result.error) harnessErrors++;

            const mark = result.error ? chalk.red("✗") : result.blocked ? chalk.yellow("■") : chalk.green("✓");
            s.stop(`${chalk.dim(`[${i + 1}/${work.length}]`)} ${mark} ${verdictLine(w.tierName, w.inst, result)}`);
            if (result.error) {
              p.log.error(chalk.dim(result.error));
              const tail = logs.split("\n").filter(Boolean).slice(-12).join("\n");
              if (tail) p.log.message(chalk.dim(tail));
            }
            refresh();
          }
        }
      } finally {
        // Release the overlay guard at the END OF EVERY REPEAT, not just on an
        // arm change. The serial branch above declares `currentArm` inside itself
        // and only releases when the arm CHANGES (never after the last one), so
        // repeat 2 would call `w.arm.activate()` while repeat 1's overlay is
        // still marked active and `activateOverlay` would THROW (arm.ts). The
        // concurrent branch already releases per arm in its own `finally`, and a
        // second release is a harmless no-op — the guard is two booleans.
        releaseOverlayGuard();
      }

      // Final, static scorecard + machine artifacts FOR THIS REPEAT. The
      // run-level metadata is persisted into scorecard.json so the dashboard can
      // label, order, and (no longer) live-poll the run without re-deriving from
      // the current config.
      const generatedAt = new Date().toISOString();
      for (const tier of tiers) {
        const tierResults = all.filter((r) => (r.tier ?? "") === tier);
        writeArtifacts(resultsDirFor(tier), withMeta(summarize(tierResults), { ...baseMetaFor(tier), generatedAt, live: false, martian: martianFor(tier, tierResults) }));
        repeatDirs.push(resultsDirFor(tier));
      }
      totalHarnessErrors += harnessErrors;
      totalCompleted += completed;
      totalCases += all.length;
    }
  } finally {
    clearInterval(heartbeat);
    restoreEvalEnv();
  }

  p.log.success(
    `Artifacts → ${chalk.cyan(repeatDirs.join("\n             "))}\n             /{scorecard.json,predictions.jsonl,sessions/}`,
  );

  // `--keep-workspace` is only useful if you can find what it kept. The paths
  // are on every result too (`workspaceDir`); this is the line that stops a
  // kept batch from being N anonymous temp dirs, and the reminder that nothing
  // else will ever delete them.
  if (keptWorkspaces.length) {
    p.log.warn(
      `Kept ${keptWorkspaces.length} workspace${keptWorkspaces.length === 1 ? "" : "s"} (--keep-workspace) — nothing else will remove them:\n` +
        keptWorkspaces
          .map(
            (w) =>
              `  ${w.id}${repeats > 1 ? ` (repeat ${w.repeat})` : ""}${runs > 1 ? ` (trial ${w.trial})` : ""} · ${chalk.cyan(w.path)}`,
          )
          .join("\n"),
    );
  }

  // `--repeats` suppressed the auto-served dashboard (see the flag's note), so
  // say — once, at the end — how to bring one up over the whole band instead of
  // leaving N servers running for the length of the run.
  if (repeats > 1) {
    p.log.info(
      `${repeats} repeats written as sibling runs (band ${chalk.cyan(repeatGroup)}). Browse the band:\n` +
        `  ${chalk.cyan(`cd apps/evals && LASTLIGHT_EVALS_OUT=${resultsRoot()} npx tsx src/run.ts serve --port 4400`)}`,
    );
  }

  const ran = runs > 1 ? `${totalCompleted} runs (${totalCases} cases × ${runs})` : `${totalCases} runs`;

  // Keep the dashboard server alive so the just-finished run stays viewable —
  // until the user stops it (Ctrl-C, or `kill`/stop for a detached run). The
  // dashboard is opt-in already (`--no-open`, or CI, ⇒ no server was started), so
  // the server merely existing means "the user wants the report up." We hold it
  // open even for non-TTY/background runs — that's exactly when you want to come
  // back to the report after the run has detached — so a finished background run
  // stays serving until explicitly killed instead of vanishing on completion.
  if (server) {
    const runUrl = `${server.url}/#/${encodeURIComponent(tierKeyFor(tiers[0]))}/${encodeURIComponent(runId)}`;
    p.log.success(`Dashboard → ${chalk.cyan(runUrl)} ${chalk.dim("(serving · Ctrl-C or kill to stop)")}`);
    const tail = totalHarnessErrors > 0 ? chalk.yellow(`done — ${ran}, ${totalHarnessErrors} harness error${totalHarnessErrors === 1 ? "" : "s"} (see above)`) : chalk.green(`done — ${ran}`);
    p.outro(tail);
    await waitForSigint();
    await server.close();
  } else {
    if (totalHarnessErrors > 0) {
      p.outro(chalk.yellow(`done — ${ran}, ${totalHarnessErrors} harness error${totalHarnessErrors === 1 ? "" : "s"} (see above)`));
    } else {
      p.outro(chalk.green(`done — ${ran}`));
    }
  }

  // Non-zero ONLY on harness failure — model quality is the measurement. Summed
  // over every repeat: a band whose middle repeat blew up did not run clean.
  return totalHarnessErrors > 0 ? 1 : 0;
}

/** Resolve on the first SIGINT (Ctrl-C) so `run`/`serve` can keep a server up
 * for browsing and shut it down cleanly when the user is done. */
function waitForSigint(): Promise<void> {
  return new Promise((resolve) => {
    const onSig = () => {
      process.off("SIGINT", onSig);
      resolve();
    };
    process.on("SIGINT", onSig);
  });
}

/**
 * `serve` — start the dashboard server over `eval-results/` and open it in the
 * browser to browse every past run (no models run). The same server `run` uses
 * for the live report; blocks until Ctrl-C. There is no HTML to regenerate any
 * more — the SPA reads the JSON directly.
 */
async function runServe(): Promise<number> {
  loadDotEnv();
  const noOpen = process.argv.includes("--no-open");
  const port = intFlag("port", 0) || undefined;
  let server: RunningServer;
  try {
    server = await startServer({ resultsRoot: resultsRoot(), dashboardRoot: dashboardDistRoot(), port });
  } catch (err) {
    console.error(`Couldn't start the dashboard server: ${(err as Error).message}`);
    return 1;
  }
  console.log(`Dashboard → ${server.url}  (serving ${resultsRoot()} · Ctrl-C to stop)`);
  if (!noOpen) openInBrowser(server.url);
  await waitForSigint();
  await server.close();
  return 0;
}

/** This package's version + the resolved `lastlight-core` version, on one line,
 * e.g. `lastlight-evals 0.7.1 (lastlight-core 0.16.0)`. Both are read from the actual
 * installed `package.json`s (core resolved the same way `bootstrap.ts` does), so
 * the line is always truthful about what's running. Missing/unresolvable → `?`. */
function versionLine(): string {
  const require = createRequire(import.meta.url);
  const read = (spec: string): string => {
    try {
      return (require(spec) as { version?: string }).version ?? "?";
    } catch {
      return "?";
    }
  };
  return `lastlight-evals ${read("../package.json")} (lastlight-core ${read("lastlight-core/package.json")})`;
}

const USAGE = `lastlight-evals — eval harness for Last Light workflows

Usage:
  lastlight-evals [run] [tiers...] [options]   Run evals (default command)
  lastlight-evals init [dir] [options]         Scaffold an overlay+evals workspace
  lastlight-evals add-case --pr|--issue <url>  Author an eval case from a GitHub PR/issue
  lastlight-evals serve [options]              Browse past runs in the dashboard (no models run)
  lastlight-evals clean [options]              Finalize killed/crashed runs stuck showing "running"
  lastlight-evals --version                    Print the evals + lastlight versions

Run options:
  --mode <models|config>  Comparison axis. models (default): force each --model
                          across every step. config: run an overlay's real
                          per-step model config (its config.yaml). No flags in a
                          TTY ⇒ asks.
  --overlay <dir>      Layer a deployment's workflows/skills + evals/ over built-ins.
                       Repeatable in --mode config (one arm per overlay).
  --model <m[,m2]>     models: model(s) to run (fuzzy-matched against models.json).
                       config: override each config's default model.
  --compare            Cross-vendor set (only models whose provider key is present)
  --instance <id[,id]> Only run these instance_id(s) (or set EVAL_INSTANCE). Exact match.
  --limit <n>          Run only the first n instances per tier (after --instance).
  --runs <n>           Repeat each CASE n× (worst-case verdict, mean metrics).
                       Folds the trials into one result — no per-trial detail.
  --repeats <n>        Repeat the whole ARM n×, sequentially, as n SIBLING runs,
                       so a result reads as a band instead of a point. Three
                       identical arms measured 0.320/0.080/0.200 micro-recall, so
                       one arm is not a measurement of that arm. Each repeat is a
                       normal run (its own runId + scorecard) tagged with
                       meta.repeat={group,index,of}; scripts/band.ts and the
                       dashboard roll them up into a band (mean/min/max + union
                       and intersection recall). Implies --keep-workspace (you will
                       want each repeat's evidence) and --no-open (a run holds a
                       dashboard server open forever; n of them leak). Or
                       EVAL_REPEATS.
  --repeat-concurrency <n>  Run up to n of the --repeats repeats at once
                       (default 1 = sequential, the exact path above). RunIds are
                       pre-assigned so simultaneous launches never collide; each
                       repeat stays a normal sibling run. Repeats share ONE
                       overlay, so multi-overlay --mode config runs clamp to 1
                       (as does --sandbox gondolin). Composes with --concurrency:
                       total in-flight cases = repeat-concurrency × concurrency
                       (no cap — size the product against your rate limit).
                       CAVEAT: concurrent repeats contend for CPU/network, so
                       per-phase durationMs/agentMs are contaminated; each
                       repeat's meta.repeat.concurrency records n so latency
                       reads can be discounted. Verdicts/cost/recall unaffected.
  --f-beta <n>         pr-review F-beta β (default 1 = F1; 0.5 = precision 2×). Or EVAL_F_BETA.
  --judge-with-diff    pr-review: feed the PR diff to the judge (higher fidelity,
                       off by default — Martian's offline judge is diff-blind)
  --no-inject-context  pr-review: DON'T inject synthetic repo-context (an AGENTS.md
                       from <overlay>/repo-context/ + <datasets>/<tier>/context/<id>/)
                       into the checkout. On by default; off for a clean A/B control.
                       Or EVAL_INJECT_CONTEXT=0.
  --sandbox <backend>  Agent execution sandbox: none (default) | gondolin. none is
                       in-process (fast, CI). gondolin isolates the agent's tools
                       in a QEMU micro-VM so it can't read host gold data (needs
                       QEMU natively — brew install qemu). Or EVAL_SANDBOX.
  --keep-workspace     Don't delete each trial's workspace. Keeps the evidence
                       pipeline's artifacts (.lastlight/pr-review/facts.json,
                       obligations/, hypotheses/, probes/) readable after the run;
                       the path lands on each result as workspaceDir. Costs disk.
  --concurrency <n>    Run n cases of the SAME arm at once (default 1 = serial).
                       Arms always stay serial (one overlay at a time, ADR 0001);
                       --runs trials within a case stay serial too. Bounded by the
                       provider's rate limit, not by correctness. Forced to 1 on
                       --sandbox gondolin (a QEMU micro-VM per case).
  --serial             Force serial execution across provider families
  --datasets <dir>     Extra datasets root to discover tiers from
  --models-file <f>    Use an explicit models.json
  --no-open            Don't open / auto-serve the dashboard (also implied by CI=1)

Serve options:
  --port <n>           Preferred port for the dashboard server (default 4319)
  --no-open            Start the server but don't open a browser

Run \`lastlight-evals init --help\` / \`lastlight-evals add-case --help\` for those flags.
GitHub is mocked end-to-end when running evals — no GitHub token needed, only a
provider key. (\`add-case\` is the exception: it reads real PRs/issues via \`gh\`.)`;

/** Top-level subcommand dispatcher: `run` (default) | `init` | `add-case` | `serve`. */
async function main(): Promise<number> {
  const sub = process.argv[2];
  // `--version` / `-v`: just the versions (machine-friendly — one line, nothing else).
  if (sub === "--version" || sub === "-v" || sub === "version") {
    console.log(versionLine());
    return 0;
  }
  // Bare invocation or explicit help → version banner + usage. (A bare run with
  // tiers/flags still works — only the zero-arg case shows help instead of running.)
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(versionLine());
    console.log();
    console.log(USAGE);
    return 0;
  }
  if (sub === "init") {
    // `init [dir] [flags]` — scaffold a fresh overlay+evals repo.
    return runInit(process.argv.slice(3));
  }
  if (sub === "add-case") {
    // `add-case --pr|--issue <url> [flags]` — scaffold an instance from GitHub.
    return runAddCase(process.argv.slice(3));
  }
  if (sub === "clean") {
    // `clean [--delete] [--older-than] [--dry-run]` — finalize killed/crashed runs.
    return runClean(process.argv.slice(3));
  }
  // `--help`/`-h` ANYWHERE must print usage and run nothing. The early check above
  // only catches it as the first token; `run --help` / `serve --help` / `<tier>
  // --help` reach here, so guard the run/serve paths too. (`init`/`add-case` print
  // their own, more specific help internally.)
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  if (sub === "serve") {
    // `serve` — browse past runs; the live dashboard server, standalone.
    if (wantsHelp) {
      console.log(USAGE);
      return 0;
    }
    return runServe();
  }
  // `run` is the default; allow an explicit leading `run` token too.
  if (sub === "run") process.argv.splice(2, 1);
  if (wantsHelp) {
    console.log(versionLine());
    console.log();
    console.log(USAGE);
    return 0;
  }
  return runEval();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
