/**
 * Host-local `lastlight fork <target>` — copy a built-in workflow (plus every
 * prompt and skill its phases reference) or the agent-context files
 * (`soul.md` and friends) into the deployment overlay so they can be edited
 * per-deployment.
 *
 * Like `lastlight server …`, this operates on files in a working directory —
 * not over HTTP. The overlay wins by logical name at startup (see
 * `src/workflows/loader.ts`), so a forked copy under `instance/` transparently
 * shadows the built-in once the agent restarts.
 *
 *   lastlight fork build              # build.yaml + its prompts + skills → instance/
 *   lastlight fork agent-context      # soul.md / rules.md / security.md → instance/
 *   lastlight fork agent-context soul.md   # just one context file (explicit)
 *   lastlight fork                    # list forkable targets (and what's already forked)
 *
 * Targets are explicit: a bare name is a workflow, agent-context is forked only
 * via the literal `agent-context` target — never guessed from a filename.
 *
 * Importing `./workflows/loader.js` + `./workflows/schema.js` is safe here:
 * both are pure (fs + yaml); their only `../config.js` import is type-only and
 * erased at runtime, so no harness/DB is pulled into the CLI.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import {
  configureWorkflowAssets,
  getWorkflow,
  getWorkflowOrigin,
  listAgentWorkflows,
  resolveSkillPaths,
} from "../workflows/loader.js";
import { phaseSkillNames } from "../workflows/schema.js";
import { resolveServerHome } from "./cli-config.js";
import { enumerateOverlayAssets } from "../config/overlay-assets.js";

export interface ForkOpts {
  /** `--home <dir>` override for the working directory (the core checkout). */
  home?: string;
  /** `--force` — overwrite assets that already exist in the overlay. */
  force?: boolean;
}

// ── path resolution ────────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A directory that ships the built-in assets we fork *from*. */
function hasBuiltins(dir: string): boolean {
  return isDir(path.join(dir, "workflows")) && isDir(path.join(dir, "skills"));
}

/**
 * Assets bundled with this CLI. The npm package ships `workflows/`, `skills/`,
 * `agent-context/` and `config/` at its root, so a globally-installed
 * `lastlight` can fork from itself with no git checkout in sight. Resolves for
 * both compiled (`dist/cli/fork-cli.js` → `../..` = package root) and dev
 * (`src/cli/fork-cli.ts` → repo root) layouts — same trick as
 * `skills-install.ts`'s `bundleRoot()`.
 */
function bundledAssetRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * Pick the first candidate that actually ships built-ins, else the assets
 * bundled with the CLI. This is what lets fork work from an overlay-only or
 * evals workspace — the core no longer has to be a colocated checkout.
 */
function resolveCoreRoot(...candidates: string[]): string {
  for (const c of candidates) if (c && hasBuiltins(c)) return c;
  return bundledAssetRoot();
}

/** A directory that looks like a deployment overlay (config + secrets), not a
 *  core checkout (which keeps config under config/default.yaml, no secrets/). */
function looksLikeOverlay(dir: string): boolean {
  return (
    !hasBuiltins(dir) &&
    (fs.existsSync(path.join(dir, "config.yaml")) || isDir(path.join(dir, "secrets")))
  );
}

export interface ForkTarget {
  /** Source of the built-in assets (the lastlight checkout root). */
  coreRoot: string;
  /** Overlay destination root (the instance/ folder). */
  instanceDir: string;
}

/**
 * Resolve where to read built-ins from and where to write the fork.
 *
 * Built-ins (`coreRoot`) are read from the first available of: a colocated core
 * checkout, the saved server home (if it's a checkout), else the assets bundled
 * with the CLI itself — so `fork` works from a CLI install with no checkout
 * anywhere (the common case for overlay + evals workspaces).
 *
 * The overlay destination (`instanceDir`) is:
 * - An explicit `--home` → `<home>/instance`.
 * - Standing inside an overlay (e.g. `instance/` itself) → write here.
 * - Standing in a core checkout → `<checkout>/instance`.
 * - Standing in a workspace that *contains* an overlay (an evals workspace:
 *   `instance/` + `evals/`) → that `instance/`.
 * - Otherwise → `LASTLIGHT_HOME` / the saved / default server home + `/instance`.
 */
export function resolveForkTarget(opts: ForkOpts): ForkTarget {
  // An explicit flag is unambiguous intent — it overrides cwd auto-detection.
  if (opts.home) {
    const home = path.resolve(opts.home);
    return { coreRoot: resolveCoreRoot(home), instanceDir: path.join(home, "instance") };
  }

  const cwd = process.cwd();

  // Inside an overlay (instance/ itself) → fork here.
  if (looksLikeOverlay(cwd)) {
    return { coreRoot: resolveCoreRoot(path.dirname(cwd), resolveServerHome(opts.home)), instanceDir: cwd };
  }
  // In a core checkout → fork into its instance/.
  if (hasBuiltins(cwd)) {
    return { coreRoot: cwd, instanceDir: path.join(cwd, "instance") };
  }
  // A workspace that contains an overlay (e.g. an evals workspace) → its instance/.
  const localInstance = path.join(cwd, "instance");
  if (looksLikeOverlay(localInstance)) {
    return { coreRoot: resolveCoreRoot(cwd), instanceDir: localInstance };
  }
  // Fall back to the saved/default server home.
  const home = resolveServerHome(opts.home);
  return { coreRoot: resolveCoreRoot(home), instanceDir: path.join(home, "instance") };
}

// ── copy helpers ───────────────────────────────────────────────────────────

type Action = "copied" | "skipped" | "overwritten";
interface CopyResult {
  /** Overlay-relative path of the asset. */
  rel: string;
  action: Action;
}

/** Copy a single file, honouring skip-existing / `--force`. */
function copyFile(src: string, destAbs: string, rel: string, force: boolean): CopyResult {
  const exists = fs.existsSync(destAbs);
  if (exists && !force) return { rel, action: "skipped" };
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(src, destAbs);
  return { rel, action: exists ? "overwritten" : "copied" };
}

/** Copy a directory tree, honouring skip-existing / `--force`. */
function copyDir(src: string, destAbs: string, rel: string, force: boolean): CopyResult {
  const exists = fs.existsSync(destAbs);
  if (exists && !force) return { rel, action: "skipped" };
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(src, destAbs, { recursive: true, force: true });
  return { rel, action: exists ? "overwritten" : "copied" };
}

// ── fork actions ───────────────────────────────────────────────────────────

/** Copy a workflow YAML + every prompt and skill its phases reference. */
function forkWorkflow(t: ForkTarget, name: string, force: boolean): CopyResult[] {
  const def = getWorkflow(name); // throws if unknown — caller lists + exits
  const origin = getWorkflowOrigin(name);
  const results: CopyResult[] = [];

  // The workflow YAML itself (origin handles .yaml vs .yml).
  if (origin) {
    const file = path.basename(origin.filePath);
    results.push(copyFile(origin.filePath, path.join(t.instanceDir, "workflows", file), `workflows/${file}`, force));
  }

  // Prompt templates referenced by phases (skip empties + templated refs).
  const prompts = new Set<string>();
  const skillNames = new Set<string>();
  for (const phase of def.phases) {
    for (const ref of [phase.prompt, phase.loop?.on_request_changes.fix_prompt, phase.loop?.on_request_changes.re_review_prompt]) {
      if (typeof ref === "string" && ref.length > 0 && !ref.includes("{{")) prompts.add(ref);
    }
    for (const s of phaseSkillNames(phase)) {
      if (!s.includes("{{")) skillNames.add(s);
    }
  }

  for (const rel of [...prompts].sort()) {
    const src = path.join(t.coreRoot, "workflows", rel);
    if (!fs.existsSync(src)) continue; // overlay-only prompt, nothing to fork
    results.push(copyFile(src, path.join(t.instanceDir, "workflows", rel), `workflows/${rel}`, force));
  }

  for (const skill of [...skillNames].sort()) {
    let src: string;
    try {
      src = resolveSkillPaths([skill])[0];
    } catch {
      continue; // overlay-only or missing skill
    }
    results.push(copyDir(src, path.join(t.instanceDir, "skills", skill), `skills/${skill}/`, force));
  }

  return results;
}

/**
 * Fork *everything* — every agent workflow (and the prompts + skills each
 * references) plus all agent-context files. Shared assets (a skill or prompt
 * used by several workflows) are physically copied once; the per-`rel` dedup
 * here keeps the report from listing them N times as "skipped".
 */
function forkAll(t: ForkTarget, force: boolean): CopyResult[] {
  const byRel = new Map<string, CopyResult>();
  const add = (r: CopyResult): void => {
    const prev = byRel.get(r.rel);
    // Prefer the most informative action: a real write beats a later skip.
    if (!prev || (prev.action === "skipped" && r.action !== "skipped")) byRel.set(r.rel, r);
  };
  for (const def of [...listAgentWorkflows()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const r of forkWorkflow(t, def.name, force)) add(r);
  }
  for (const r of forkAgentContext(t, builtinAgentContext(t.coreRoot), force)) add(r);
  for (const r of forkClassifier(t, force)) add(r);
  return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Copy one or more agent-context files (soul.md / rules.md / security.md). */
function forkAgentContext(t: ForkTarget, files: string[], force: boolean): CopyResult[] {
  return files.map((file) => {
    const src = path.join(t.coreRoot, "agent-context", file);
    return copyFile(src, path.join(t.instanceDir, "agent-context", file), `agent-context/${file}`, force);
  });
}

/**
 * The base classifier prompt files (issue #164) — the framing/disambiguation
 * template the intent classifier composes per-workflow categories into, plus
 * the re-triage novelty gate. Each workflow's own category text lives in its
 * YAML, so it already travels with `fork <workflow>`; these are the standalone
 * base prompts a deployment forks to retune the router's classification.
 */
const CLASSIFIER_PROMPTS = ["prompts/classifier.md", "prompts/classify-adds-info.md"];

/** Copy the base classifier prompt files into the overlay (skip any absent from core). */
function forkClassifier(t: ForkTarget, force: boolean): CopyResult[] {
  const results: CopyResult[] = [];
  for (const rel of CLASSIFIER_PROMPTS) {
    const src = path.join(t.coreRoot, "workflows", rel);
    if (!fs.existsSync(src)) continue;
    results.push(copyFile(src, path.join(t.instanceDir, "workflows", rel), `workflows/${rel}`, force));
  }
  return results;
}

/** Built-in agent-context filenames (e.g. soul.md, rules.md, security.md). */
function builtinAgentContext(coreRoot: string): string[] {
  const dir = path.join(coreRoot, "agent-context");
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
}

// ── reporting ──────────────────────────────────────────────────────────────

function printSummary(t: ForkTarget, results: CopyResult[]): void {
  const sym: Record<Action, string> = {
    copied: chalk.green("＋ copied"),
    overwritten: chalk.yellow("↻ overwritten"),
    skipped: chalk.dim("• skipped (exists)"),
  };
  console.log(chalk.bold(`Forked into ${t.instanceDir}\n`));
  for (const r of results) {
    console.log(`  ${sym[r.action]}  ${r.rel}`);
  }
  const copied = results.filter((r) => r.action !== "skipped").length;
  const skipped = results.length - copied;
  console.log(
    chalk.dim(
      `\n${copied} written, ${skipped} skipped.` +
        (skipped ? "  Re-run with --force to overwrite." : ""),
    ),
  );
  console.log(
    chalk.dim("\nNext: edit the files in instance/, commit the overlay, then ") +
      chalk.cyan("lastlight server restart agent") +
      chalk.dim("."),
  );
}

/** `lastlight fork` with no target — list forkable workflows + context files. */
function listForkable(t: ForkTarget): void {
  configureWorkflowAssets({ builtInRoot: t.coreRoot });
  const forked = new Set(
    enumerateOverlayAssets({ coreRoot: t.coreRoot, overlayRoot: t.instanceDir }).map((a) => `${a.type}:${a.name}`),
  );
  const mark = (key: string): string => (forked.has(key) ? chalk.green(" (forked)") : "");

  console.log(chalk.bold("Forkable workflows") + chalk.dim(`  →  ${t.instanceDir}\n`));
  for (const def of [...listAgentWorkflows()].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${def.name}${mark(`workflow:${def.name}`)}`);
  }
  const context = builtinAgentContext(t.coreRoot);
  if (context.length) {
    console.log(chalk.bold("\nForkable agent-context") + chalk.dim("  (lastlight fork agent-context)\n"));
    for (const file of context) console.log(`  ${file}${mark(`agent-context:${file}`)}`);
  }
  console.log(chalk.bold("\nForkable classifier") + chalk.dim("  (lastlight fork classifier)\n"));
  for (const rel of CLASSIFIER_PROMPTS) {
    console.log(`  ${rel}${mark(`prompt:${path.basename(rel)}`)}`);
  }
  console.log(chalk.dim("\nFork one with: ") + chalk.cyan("lastlight fork <name>"));
  console.log(chalk.dim("Fork everything with: ") + chalk.cyan("lastlight fork all"));
}

// ── entry point ────────────────────────────────────────────────────────────

/**
 * `lastlight fork [target] [sub]` — dispatch on an explicit target.
 *   - (none)                       → list forkable targets
 *   - "all"                        → every workflow (+ prompts & skills) + context + classifier
 *   - "agent-context" [file]       → all context files, or one named file
 *   - "classifier"                 → the base intent-classifier prompt files
 *   - "<workflow>"                 → workflow + its prompts + skills
 * Agent-context is never inferred from a bare filename — it's only reached via
 * the literal `agent-context` target.
 */
export async function fork(args: string[], opts: ForkOpts): Promise<void> {
  const [target, sub] = args;
  const t = resolveForkTarget(opts);
  if (!hasBuiltins(t.coreRoot)) {
    // resolveCoreRoot falls back to the CLI's bundled assets, so this only
    // fires if the install itself is missing workflows/ + skills/ (corrupt
    // package) — not for a plain "no checkout here" situation any more.
    console.error(
      chalk.red(`No built-in assets found at ${t.coreRoot} (expected workflows/ + skills/).`) +
        chalk.dim(`\n  The lastlight install looks incomplete — try reinstalling, or pass --home <checkout>.`),
    );
    process.exit(1);
  }

  if (!target) {
    listForkable(t);
    return;
  }

  configureWorkflowAssets({ builtInRoot: t.coreRoot });

  // `fork all` — every workflow (+ its prompts & skills) plus all agent-context.
  if (target === "all") {
    printSummary(t, forkAll(t, opts.force ?? false));
    return;
  }

  // agent-context — `fork agent-context [file]`. All files, or one named file.
  if (target === "agent-context") {
    const available = builtinAgentContext(t.coreRoot);
    if (!available.length) { console.error(chalk.red("No agent-context files found.")); process.exit(1); }
    let files = available;
    if (sub) {
      const file = sub.endsWith(".md") ? sub : `${sub}.md`;
      if (!available.includes(file)) {
        console.error(chalk.red(`Unknown agent-context file: ${sub}`) + chalk.dim(`\n  Available: ${available.join(", ")}`));
        process.exit(1);
      }
      files = [file];
    }
    printSummary(t, forkAgentContext(t, files, opts.force ?? false));
    return;
  }

  // classifier — the base intent-classifier prompts (issue #164).
  if (target === "classifier") {
    printSummary(t, forkClassifier(t, opts.force ?? false));
    return;
  }

  // Otherwise treat it as a workflow name.
  try {
    getWorkflow(target);
  } catch {
    const names = listAgentWorkflows().map((d) => d.name).sort();
    console.error(
      chalk.red(`Unknown fork target: ${target}`) +
        chalk.dim(`\n  Workflows: ${names.join(", ")}`) +
        chalk.dim(`\n  Agent-context: "agent-context" (optionally a file, e.g. agent-context soul.md).`) +
        chalk.dim(`\n  Classifier: "classifier".`) +
        chalk.dim(`\n  Everything: "all".`),
    );
    process.exit(1);
  }
  printSummary(t, forkWorkflow(t, target, opts.force ?? false));
}
