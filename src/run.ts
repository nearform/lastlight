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
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

import * as p from "@clack/prompts";
import chalk from "chalk";

import { loadDotEnv, hasProviderKey, evalModels, compareModels, modelLabels, resolveModel, setModelsPath } from "./env.js";
import { runInstance, applyEvalEnv, slug } from "./run-instance.js";
import { loadMergedConfig, type ModelConfig, type VariantConfig } from "./config.js";
import {
  summarize,
  writeArtifacts,
  writeScorecard,
  aggregateTrials,
  type RunMeta,
  type PendingCase,
  type Scorecard,
} from "./report.js";
import type { SweBenchInstance, InstanceResult, TrialSession } from "./schema.js";
import { bootstrapAssets } from "./bootstrap.js";
import { discoverTiers, loadInstances, workflowFor, type Tier } from "./discovery.js";
import { builtinDatasetsRoot, tierResultsDir, makeRunId, gitShortSha, resultsRoot, dashboardDistRoot } from "./paths.js";
import { startServer, type RunningServer } from "./serve.js";
import { runInit } from "./init.js";

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
const VALUE_FLAGS = new Set(["--runs", "--model", "--models", "--mode", "--overlay", "--datasets", "--models-file"]);

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

  const noOpen = process.argv.includes("--no-open") || !!process.env.CI;
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

  // An "arm" is one column of the comparison. `models` runs have one arm per
  // model (forced across every step); `config` runs have one arm per overlay
  // (its merged per-step config drives selection). Both flow through the same
  // work-list → scorecard → dashboard, keyed on the arm's `label`.
  interface Arm {
    /** Axis label (model id in `models` runs; overlay/config name in `config`). */
    label: string;
    /** Parallel-grouping key: provider env-key in `models`; arm id in `config`. */
    family: string;
    /** `config` runs: the merged per-step model/variant maps + which overlay's
     * assets to bootstrap. Absent in `models` runs (one forced model = label). */
    modelConfig?: ModelConfig;
    variantConfig?: VariantConfig;
    overlayDir?: string;
  }

  // The model-selection sub-mode (only meaningful for `models` runs); shown in
  // the plan note. `config` runs report their arm count instead.
  const mode = runType === "config" ? "config" : modelArg ? "select" : compare ? "compare" : "single";
  let arms: Arm[];
  if (runType === "config") {
    // One arm per overlay (or a single core-defaults arm when none). `--model`
    // overrides each merged config's `default` key for quick what-if runs.
    const configOverlays = overlays.length ? overlays : [overlayDir];
    arms = configOverlays.map((dir) => {
      const merged = loadMergedConfig(builtInRoot, dir);
      if (modelArg) merged.models.default = resolveModel(modelArg).id;
      const label = dir ? basename(dir) : "config";
      return { label, family: label, modelConfig: merged.models, variantConfig: merged.variants, overlayDir: dir };
    });
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
    arms = entries.map((e) => ({ label: e.id, family: e.family }));
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
    /** The arm's axis label (= {@link Arm.label}); recorded as InstanceResult.model. */
    model: string;
    family: string;
    /** `config` arms only: threaded to runInstance to drive per-step selection. */
    modelConfig?: ModelConfig;
    variantConfig?: VariantConfig;
    /** `config` arms only: which overlay's assets to bootstrap before this arm. */
    overlayDir?: string;
    inst: SweBenchInstance;
  }

  // Instances per tier, resolved ONCE — the case set is identical across arms
  // (arms vary only the model selection / assets, never the cases).
  const tierInstances = new Map<string, SweBenchInstance[]>();
  for (const tierName of tiers) {
    const tier: Tier = discovered.get(tierName)!;
    const instances = loadInstances(tier);
    if (!instances.length) {
      p.log.warn(`tier "${tierName}": no instances at ${tier.instancesPath} — skipping`);
      continue;
    }
    tierInstances.set(tierName, instances);
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
          model: arm.label,
          family: arm.family,
          modelConfig: arm.modelConfig,
          variantConfig: arm.variantConfig,
          overlayDir: arm.overlayDir,
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

  // Group work by provider family. Families run CONCURRENTLY (independent
  // provider keys / rate limits); within a family runs stay serial. Force
  // serial with --serial or when there's only one family.
  const byFamily = new Map<string, WorkItem[]>();
  for (const w of work) {
    const arr = byFamily.get(w.family);
    if (arr) arr.push(w);
    else byFamily.set(w.family, [w]);
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
  const runId = makeRunId(new Date(), gitSha, tierResultsDir(tierKeyFor(tiers[0])));
  const resultsDirFor = (tier: string) => join(tierResultsDir(tierKeyFor(tier)), runId);
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
  const baseMetaFor = (tier: string): Omit<RunMeta, "generatedAt"> => ({
    runId,
    runType,
    tiers: [tier],
    models: armLabels,
    runs,
    gitSha,
    labels,
  });

  // In `config` runs the axis is the config(s); show the merged per-step model
  // map for a single-arm run so the plan is legible.
  const axisLine =
    runType === "config"
      ? `${chalk.bold("configs")} ${armLabels.join(", ")}`
      : `${chalk.bold("models")}  ${armLabels.join(", ")}`;
  const phaseMapLine =
    runType === "config" && arms.length === 1 && arms[0].modelConfig
      ? `\n${chalk.bold("models")}  ${chalk.dim(
          Object.entries(arms[0].modelConfig)
            .map(([k, v]) => `${k}→${v}`)
            .join("  "),
        )}`
      : "";
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
      }`,
    "plan",
  );

  // `total` counts individual trials so live progress advances per model call.
  const total = work.length * runs;

  // Seed an empty live scorecard per tier so the dashboard has something to poll,
  // then start the server and open the SPA deep-linked at this run. The server is
  // skipped entirely when not opening (CI / --no-open) — we only write JSON.
  for (const tier of tiers) {
    writeScorecard(
      resultsDirFor(tier),
      withMeta(summarize([]), { ...baseMetaFor(tier), generatedAt: new Date().toISOString(), live: true, progress: `0/${total}` }),
    );
  }
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

  const all: InstanceResult[] = [];
  let harnessErrors = 0;
  let completed = 0;

  // Track in-flight cases so the live report can show running / queued rows.
  const caseKey = (tier: string, model: string, id: string) => `${tier}|${model}|${id}`;
  const running = new Set<string>();
  // Current trial number per running case, so the live "follow" link points at
  // the right `trial-<N>/full.jsonl` (matters only for `--runs N>1`).
  const trialOf = new Map<string, number>();

  // writeScorecard/summarize/all.push run synchronously to completion inside one
  // event-loop turn, so even with concurrent families they never interleave; the
  // temp-file+rename keeps a polling dashboard from reading a half-written file.
  const refresh = () => {
    const done = new Set(all.map((r) => caseKey(r.tier ?? "", r.model, r.instance_id)));
    const now = new Date().toISOString();
    for (const tier of tiers) {
      const tierResults = all.filter((r) => (r.tier ?? "") === tier);
      const pending: PendingCase[] = work
        .filter((w) => w.tierName === tier)
        .map((w) => ({ w, k: caseKey(w.tierName, w.model, w.inst.instance_id) }))
        .filter(({ k }) => !done.has(k))
        .map(({ w, k }) => ({
          tier: w.tierName,
          model: w.model,
          instance_id: w.inst.instance_id,
          status: running.has(k) ? "running" : "pending",
          // Only a running case has a (live-updating) transcript to follow —
          // point at the current trial's consolidated `full.jsonl`.
          sessionLog: running.has(k)
            ? `${trialRelFor(w.inst.instance_id, w.model, trialOf.get(k) ?? 1)}/full.jsonl`
            : undefined,
        }));
      // Per-tier progress (cases), not the global trial count — each tier's
      // scorecard stands alone, so "0/5" across both tiers was misleading.
      const tierCases = work.filter((w) => w.tierName === tier).length;
      writeScorecard(
        resultsDirFor(tier),
        withMeta(summarize(tierResults), {
          ...baseMetaFor(tier),
          generatedAt: now,
          live: true,
          progress: `${tierResults.length}/${tierCases}`,
          pending,
        }),
      );
    }
  };

  // Run one case `runs` times and fold the trials into a single result
  // (worst-case verdict, mean metrics). `onTrial` ticks per model call.
  const runItem = async (w: WorkItem, onTrial: () => void): Promise<InstanceResult> => {
    const k = caseKey(w.tierName, w.model, w.inst.instance_id);
    const trials: InstanceResult[] = [];
    for (let t = 1; t <= runs; t++) {
      trialOf.set(k, t); // so the live "follow" link targets this trial
      const trialRel = trialRelFor(w.inst.instance_id, w.model, t);
      const r = await runInstance(w.inst, {
        model: w.model,
        // `config` arms carry the merged per-step maps; `models` arms leave
        // these undefined so the workflow forces `w.model` on every step.
        modelConfig: w.modelConfig,
        variantConfig: w.variantConfig,
        datasetDir: w.datasetDir,
        defaultWorkflow: w.defaultWorkflow,
        manageEnv: false,
        // Per-trial dir: `full.jsonl` (consolidated, live) + `NN-<phase>.jsonl`.
        sessionTrialDir: join(resultsDirFor(w.tierName), trialRel),
        sessionTrialRel: trialRel,
        trial: t,
      });
      r.tier = w.tierName;
      trials.push(r);
      completed++;
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
            for (const w of items) {
              const k = caseKey(w.tierName, w.model, w.inst.instance_id);
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
            }
          }),
        );
      } finally {
        restoreConsole();
      }
      s.stop(`${chalk.dim(`${completed}/${total}`)} ${chalk.green("done")}`);
      p.log.message(verdicts.join("\n"));
    } else {
      // Serial: one spinner per case (updates per trial) + a verdict line.
      // `config` runs repoint the (process-global) asset root when the arm's
      // overlay changes — work is arms-outer, so this fires at most once per arm.
      let currentOverlay: string | undefined = overlayDir;
      for (let i = 0; i < work.length; i++) {
        const w = work[i];
        if (runType === "config" && w.overlayDir !== currentOverlay) {
          bootstrapAssets({ overlayDir: w.overlayDir });
          currentOverlay = w.overlayDir;
        }
        const s = makeSpinner();
        const head = `${chalk.dim(`[${i + 1}/${work.length}]`)} ${chalk.cyan(w.tierName)}/${w.inst.instance_id}  ${chalk.dim(labels[w.model] ?? w.model)}`;
        s.start(head);

        const k = caseKey(w.tierName, w.model, w.inst.instance_id);
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
    restoreEvalEnv();
  }

  // Final, static scorecard + machine artifacts. The run-level metadata is
  // persisted into scorecard.json so the dashboard can label, order, and (no
  // longer) live-poll the run without re-deriving from the current config.
  const generatedAt = new Date().toISOString();
  for (const tier of tiers) {
    const tierResults = all.filter((r) => (r.tier ?? "") === tier);
    writeArtifacts(resultsDirFor(tier), withMeta(summarize(tierResults), { ...baseMetaFor(tier), generatedAt, live: false }));
  }

  p.log.success(
    `Artifacts → ${chalk.cyan(tiers.map((t) => resultsDirFor(t)).join("\n             "))}\n             /{scorecard.json,predictions.jsonl,sessions/}`,
  );

  const ran = runs > 1 ? `${completed} runs (${all.length} cases × ${runs})` : `${all.length} runs`;

  // Keep the dashboard server alive so the just-finished run stays viewable.
  // Only block in an interactive terminal — piped/non-TTY callers exit cleanly.
  if (server && process.stdout.isTTY) {
    const runUrl = `${server.url}/#/${encodeURIComponent(tierKeyFor(tiers[0]))}/${encodeURIComponent(runId)}`;
    p.log.success(`Dashboard → ${chalk.cyan(runUrl)} ${chalk.dim("(serving · Ctrl-C to stop)")}`);
    const tail = harnessErrors > 0 ? chalk.yellow(`done — ${ran}, ${harnessErrors} harness error${harnessErrors === 1 ? "" : "s"} (see above)`) : chalk.green(`done — ${ran}`);
    p.outro(tail);
    await waitForSigint();
    await server.close();
  } else {
    if (server) await server.close();
    if (harnessErrors > 0) {
      p.outro(chalk.yellow(`done — ${ran}, ${harnessErrors} harness error${harnessErrors === 1 ? "" : "s"} (see above)`));
    } else {
      p.outro(chalk.green(`done — ${ran}`));
    }
  }

  // Non-zero ONLY on harness failure — model quality is the measurement.
  return harnessErrors > 0 ? 1 : 0;
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

const USAGE = `lastlight-evals — eval harness for Last Light workflows

Usage:
  lastlight-evals [run] [tiers...] [options]   Run evals (default command)
  lastlight-evals init [dir] [options]         Scaffold an overlay+evals workspace
  lastlight-evals serve [options]              Browse past runs in the dashboard (no models run)

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
  --runs <n>           Repeat each case n× (worst-case verdict, mean metrics)
  --serial             Force serial execution across provider families
  --datasets <dir>     Extra datasets root to discover tiers from
  --models-file <f>    Use an explicit models.json
  --no-open            Don't open / auto-serve the dashboard (also implied by CI=1)

Serve options:
  --port <n>           Preferred port for the dashboard server (default 4319)
  --no-open            Start the server but don't open a browser

Run \`lastlight-evals init --help\` for init-specific flags.
GitHub is mocked end-to-end — no real GitHub token is needed, only a provider key.`;

/** Top-level subcommand dispatcher: `run` (default) | `init` | `serve`. */
async function main(): Promise<number> {
  const sub = process.argv[2];
  // Top-level help — only when it's not standing in for a `run` tier name.
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (sub === "init") {
    // `init [dir] [flags]` — scaffold a fresh overlay+evals repo.
    return runInit(process.argv.slice(3));
  }
  if (sub === "serve") {
    // `serve` — browse past runs; the live dashboard server, standalone.
    return runServe();
  }
  // `run` is the default; allow an explicit leading `run` token too.
  if (sub === "run") process.argv.splice(2, 1);
  return runEval();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
