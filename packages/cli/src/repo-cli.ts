/**
 * `lastlight repo …` — the per-repository config layer (issue #180) from the
 * *repo's* side.
 *
 * A managed repo may commit a `.lastlight/` directory that overrides a bounded
 * subset of Last Light's config for runs against itself. Its on-disk shape
 * mirrors a deployment overlay exactly — which is why this file leans on
 * `fork-cli.ts` for the copying rather than reimplementing it:
 *
 *   .lastlight/
 *     lastlight.yml                # the config override
 *     workflows/prompts/*.md       # prompt overrides — NEVER workflow YAML
 *     skills/<name>/SKILL.md       # skill overrides
 *     agent-context/*.md           # additive persona/rules files
 *
 *   lastlight repo fork [target]        Scaffold overridable assets into ./.lastlight/
 *   lastlight repo config validate      Check ./.lastlight/ offline, exactly as the server would
 *   lastlight repo config show <o/r>    Ask a connected server for the effective config
 *
 * Two deliberate differences from `lastlight fork`:
 *
 *  1. **The destination is never guessed.** `fork` falls back to the server
 *     home's `instance/` when cwd isn't an overlay; here that would silently
 *     write a repo's config into a deployment overlay (or vice versa). So the
 *     destination is always `<git repo root>/.lastlight`, and we refuse to run
 *     outside a git repo rather than pick something.
 *  2. **The workflow YAML never travels.** A workflow defines phases, skills
 *     and permission profiles — the operator's call, not the repo's. Forking a
 *     workflow here copies only the prompts and skills its phases reference,
 *     and says so.
 *
 * `validate` is offline on purpose: it runs the SAME pure validators the server
 * runs (`lastlight-shared/repo-config-schema`), so a repo can see what will be
 * accepted before pushing to its default branch — which is the only ref the
 * server ever reads the layer from.
 */
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  configureWorkflowAssets,
  listAgentWorkflows,
  resolveSkillPaths,
  DEFAULT_REPO_CONFIG_ALLOW_KEYS,
  REPO_CONFIG_FILE,
  defaultRepoConfigPolicy,
  parseRepoConfigYaml,
  repoLayerPathKind,
  sanitizeRepoConfigLayer,
  sanitizeRepoFiles,
  type ConfigSource,
  type RepoConfigBase,
  type RepoConfigWarning,
  type RepoLayerFile,
} from "lastlight-shared";
import {
  CLASSIFIER_PROMPTS,
  builtinAgentContext,
  copyDir,
  copyFile,
  hasBuiltins,
  isDir,
  resolveCoreRoot,
  workflowAssetRefs,
  type Action,
  type CopyResult,
} from "./fork-cli.js";
import { resolveServerHome } from "./cli-config.js";

/** The layer directory a repo commits, relative to its root. */
const LAYER_DIR = ".lastlight";

export interface RepoOpts {
  /** `--home <dir>` — where to read the BUILT-IN assets from (a core checkout). */
  home?: string;
  /** `--force` — overwrite files that already exist in `.lastlight/`. */
  force?: boolean;
  /** `--json` — machine output (config show / validate). */
  json?: boolean;
  /** `--refresh` — make the server bypass its 60s repo-layer TTL (config show). */
  refresh?: boolean;
  /**
   * The repo root to operate on. Defaults to the git repo containing cwd;
   * tests pass it explicitly. Never falls back to a server home — see the
   * module doc.
   */
  dir?: string;
  /** Admin-API reader, injected by `cli.ts` so this module owns no auth/HTTP. */
  apiGet?: (path: string) => Promise<unknown>;
}

// ── repo root ──────────────────────────────────────────────────────────────

/**
 * Walk up from `start` to the nearest git repo root. `.git` is a directory in a
 * normal clone and a *file* in a worktree/submodule, so both count.
 */
function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The repo whose `.lastlight/` we operate on. Explicit `--dir` wins; otherwise
 * the git repo containing cwd. Refusing outside a git repo is the point: the
 * server only ever reads this layer from a repo's default branch, so writing it
 * somewhere unversioned would be a silent no-op.
 */
function resolveRepoRoot(opts: RepoOpts): string {
  const explicit = opts.dir ? path.resolve(opts.dir) : undefined;
  const root = explicit ?? findGitRoot(process.cwd());
  if (!root) {
    throw new Error(
      "lastlight repo must run inside a git repository — the .lastlight/ layer is read from the repo's " +
        "default branch, so it has to be committed. cd into your repo (or pass --dir <repo>).",
    );
  }
  if (explicit && !fs.existsSync(path.join(root, ".git"))) {
    throw new Error(`${root} is not a git repository (no .git). The .lastlight/ layer must be committed.`);
  }
  return root;
}

/** Where the built-in assets are read FROM (never where we write). */
function resolveBuiltInRoot(opts: RepoOpts): string {
  // An explicit --home is unambiguous intent; otherwise try the directory we're
  // standing in (a core checkout) before the saved/default server home.
  if (opts.home) return resolveCoreRoot(path.resolve(opts.home));
  return resolveCoreRoot(process.cwd(), resolveServerHome());
}

// ── repo fork ──────────────────────────────────────────────────────────────

/**
 * Copy the prompts + skills one workflow references into `.lastlight/`.
 *
 * NOT the workflow YAML: a repo may retune what an agent is told, never which
 * phases run, with which skills, under which permission profile.
 */
function forkWorkflowAssets(coreRoot: string, layerDir: string, name: string, force: boolean): CopyResult[] {
  const { prompts, skills } = workflowAssetRefs(name);
  const results: CopyResult[] = [];

  for (const rel of prompts) {
    const src = path.join(coreRoot, "workflows", rel);
    if (!fs.existsSync(src)) continue; // overlay-only prompt, nothing to fork
    results.push(copyFile(src, path.join(layerDir, "workflows", rel), `workflows/${rel}`, force));
  }
  for (const skill of skills) {
    let src: string;
    try {
      src = resolveSkillPaths([skill])[0];
    } catch {
      continue; // overlay-only or missing skill
    }
    results.push(copyDir(src, path.join(layerDir, "skills", skill), `skills/${skill}/`, force));
  }
  return results;
}

/** Copy the base intent-classifier prompts (skip any absent from core). */
function forkClassifierPrompts(coreRoot: string, layerDir: string, force: boolean): CopyResult[] {
  const results: CopyResult[] = [];
  for (const rel of CLASSIFIER_PROMPTS) {
    const src = path.join(coreRoot, "workflows", rel);
    if (!fs.existsSync(src)) continue;
    results.push(copyFile(src, path.join(layerDir, "workflows", rel), `workflows/${rel}`, force));
  }
  return results;
}

/** Copy agent-context files as a starting point. Additive-only at runtime — see {@link agentContextNote}. */
function forkAgentContext(coreRoot: string, layerDir: string, files: string[], force: boolean): CopyResult[] {
  return files.map((file) =>
    copyFile(
      path.join(coreRoot, "agent-context", file),
      path.join(layerDir, "agent-context", file),
      `agent-context/${file}`,
      force,
    ),
  );
}

/** Everything a repo may contribute, for every workflow, deduped by destination path. */
function forkAllRepoAssets(coreRoot: string, layerDir: string, force: boolean): CopyResult[] {
  const byRel = new Map<string, CopyResult>();
  const add = (r: CopyResult): void => {
    const prev = byRel.get(r.rel);
    // Prefer the most informative action: a real write beats a later skip.
    if (!prev || (prev.action === "skipped" && r.action !== "skipped")) byRel.set(r.rel, r);
  };
  for (const def of [...listAgentWorkflows()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const r of forkWorkflowAssets(coreRoot, layerDir, def.name, force)) add(r);
  }
  for (const r of forkAgentContext(coreRoot, layerDir, builtinAgentContext(coreRoot), force)) add(r);
  for (const r of forkClassifierPrompts(coreRoot, layerDir, force)) add(r);
  return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── repo fork reporting ────────────────────────────────────────────────────

const SYMBOLS: Record<Action, string> = {
  copied: chalk.green("＋ copied"),
  overwritten: chalk.yellow("↻ overwritten"),
  skipped: chalk.dim("• skipped (exists)"),
};

/**
 * The additive-only rule for `agent-context/`, stated where it bites. Built-in
 * context files are concatenated into every session's AGENTS.md; a repo may
 * ADD to that, never replace it — so a repo file whose basename matches a
 * built-in is dropped at runtime. Forking them is still useful (they're the
 * shape to copy), which is exactly why the warning has to be loud.
 */
function agentContextNote(coreRoot: string, results: CopyResult[]): string[] {
  const builtins = new Set(builtinAgentContext(coreRoot));
  const shadowing = results
    .filter((r) => r.rel.startsWith("agent-context/"))
    .map((r) => path.basename(r.rel))
    .filter((name) => builtins.has(name));
  if (shadowing.length === 0) return [];
  return [
    chalk.yellow(`! Repo agent-context is ADDITIVE ONLY.`) +
      chalk.dim(
        ` ${shadowing.join(", ")} share a name with a built-in, so the server will IGNORE them.` +
          ` Rename each to something repo-specific (e.g. project-notes.md) and keep only what you want ADDED.`,
      ),
  ];
}

function printForkSummary(layerDir: string, results: CopyResult[], notes: string[]): void {
  console.log(chalk.bold(`Forked into ${layerDir}\n`));
  for (const r of results) console.log(`  ${SYMBOLS[r.action]}  ${r.rel}`);
  if (results.length === 0) console.log(chalk.dim("  (nothing to copy)"));

  const copied = results.filter((r) => r.action !== "skipped").length;
  const skipped = results.length - copied;
  console.log(
    chalk.dim(`\n${copied} written, ${skipped} skipped.` + (skipped ? "  Re-run with --force to overwrite." : "")),
  );
  for (const note of notes) console.log(`\n${note}`);
  console.log(
    chalk.dim("\nNext: edit the files, then ") +
      chalk.cyan("lastlight repo config validate") +
      chalk.dim(", then commit them to your DEFAULT BRANCH — that is the only ref Last Light reads."),
  );
}

/** `lastlight repo fork` with no target — what a repo may override. */
function listRepoForkable(coreRoot: string, layerDir: string): void {
  const forked = (rel: string): string => (fs.existsSync(path.join(layerDir, rel)) ? chalk.green(" (present)") : "");

  console.log(chalk.bold("Forkable into .lastlight/") + chalk.dim(`  →  ${layerDir}\n`));
  console.log(chalk.bold("Workflows") + chalk.dim("  (prompts + skills only — a repo may not override workflow YAML)\n"));
  for (const def of [...listAgentWorkflows()].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${def.name}`);
  }
  const context = builtinAgentContext(coreRoot);
  if (context.length) {
    console.log(chalk.bold("\nAgent-context") + chalk.dim("  (additive only — rename before committing)\n"));
    for (const file of context) console.log(`  ${file}${forked(`agent-context/${file}`)}`);
  }
  console.log(chalk.bold("\nClassifier") + chalk.dim("  (lastlight repo fork classifier)\n"));
  for (const rel of CLASSIFIER_PROMPTS) console.log(`  ${rel}${forked(path.join("workflows", rel))}`);
  console.log(chalk.dim("\nFork one with: ") + chalk.cyan("lastlight repo fork <name>"));
  console.log(chalk.dim("Fork everything with: ") + chalk.cyan("lastlight repo fork all"));
}

/** `lastlight repo fork [target] [sub]`. */
function repoFork(args: string[], opts: RepoOpts): void {
  const repoRoot = resolveRepoRoot(opts);
  const layerDir = path.join(repoRoot, LAYER_DIR);
  const coreRoot = resolveBuiltInRoot(opts);
  if (!hasBuiltins(coreRoot)) {
    // Defensive — resolveCoreRoot already throws a --home pointer when nothing
    // ships built-ins.
    throw new Error(`No built-in assets found at ${coreRoot} (expected workflows/ + skills/). Pass --home <checkout>.`);
  }
  configureWorkflowAssets({ builtInRoot: coreRoot });

  const [target, sub] = args;
  const force = opts.force ?? false;

  if (!target) return listRepoForkable(coreRoot, layerDir);

  if (target === "all") {
    const results = forkAllRepoAssets(coreRoot, layerDir, force);
    return printForkSummary(layerDir, results, [WORKFLOW_YAML_NOTE, ...agentContextNote(coreRoot, results)]);
  }

  if (target === "agent-context") {
    const available = builtinAgentContext(coreRoot);
    if (!available.length) throw new Error("No agent-context files found in the built-ins.");
    let files = available;
    if (sub) {
      const file = sub.endsWith(".md") ? sub : `${sub}.md`;
      if (!available.includes(file)) {
        throw new Error(`Unknown agent-context file: ${sub}. Available: ${available.join(", ")}`);
      }
      files = [file];
    }
    const results = forkAgentContext(coreRoot, layerDir, files, force);
    return printForkSummary(layerDir, results, agentContextNote(coreRoot, results));
  }

  if (target === "classifier") {
    return printForkSummary(layerDir, forkClassifierPrompts(coreRoot, layerDir, force), []);
  }

  // Otherwise a workflow name — prompts + skills, never the YAML.
  const names = listAgentWorkflows().map((d) => d.name).sort();
  if (!names.includes(target)) {
    throw new Error(
      `Unknown repo fork target: ${target}\n  Workflows: ${names.join(", ")}\n` +
        `  Agent-context: "agent-context" (optionally a file, e.g. agent-context soul.md).\n` +
        `  Classifier: "classifier".  Everything: "all".`,
    );
  }
  printForkSummary(layerDir, forkWorkflowAssets(coreRoot, layerDir, target, force), [WORKFLOW_YAML_NOTE]);
}

const WORKFLOW_YAML_NOTE =
  chalk.yellow("! The workflow YAML was NOT copied.") +
  chalk.dim(
    " A repo may override a workflow's PROMPTS and SKILLS, never its definition" +
      " (phases, permission profiles, approval gates stay the operator's). To change those," +
      " fork the workflow into the deployment overlay instead: lastlight fork <workflow>.",
  );

// ── repo config validate ───────────────────────────────────────────────────

/**
 * Read `.lastlight/` off disk into the same blob shape the server's GitHub
 * fetch produces, so the identical validators run over it.
 *
 * `lstat` (not `stat`) so a symlink is reported as a symlink — the layer
 * rejects those, and following it here would validate the wrong bytes.
 */
function readLayerFiles(layerDir: string): RepoLayerFile[] {
  const out: RepoLayerFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push({ path: rel, mode: "120000", size: 0, content: Buffer.alloc(0) });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.lstatSync(abs);
      const content = fs.readFileSync(abs);
      out.push({ path: rel, mode: stat.mode & 0o111 ? "100755" : "100644", size: content.length, content });
    }
  };
  walk(layerDir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The base the offline validator merges against: empty. It can't know the
 * deployment's own values, and only one rule depends on them — the `approval`
 * add-only check, which needs to know whether the operator had already set a
 * gate. With an empty base every `approval: false` is reported as a no-op
 * rather than a downgrade, which is the same *decision* (dropped) with a
 * slightly gentler code. Reported in the summary so nobody reads more into it.
 */
const OFFLINE_BASE: RepoConfigBase = {
  value: { models: {}, variants: {}, disabled: {}, approval: {} },
  sources: { models: {}, variants: {}, disabled: {}, approval: {} },
};

interface ValidateReport {
  layerDir: string;
  /** Present layer files, classified. */
  accepted: string[];
  /** The bounded config sub-tree the server would actually apply. */
  applied: Record<string, unknown>;
  warnings: RepoConfigWarning[];
}

function validateLayer(layerDir: string): ValidateReport {
  const policy = defaultRepoConfigPolicy();
  const files = readLayerFiles(layerDir);
  const { accepted, warnings } = sanitizeRepoFiles(files, policy);

  const configFile = accepted.find((f) => f.path === REPO_CONFIG_FILE);
  const parsed = configFile ? parseRepoConfigYaml(configFile.content.toString("utf-8")) : { warnings: [] };
  warnings.push(...parsed.warnings);

  const sanitized = sanitizeRepoConfigLayer(
    (parsed as { config?: Record<string, unknown> }).config,
    policy,
    OFFLINE_BASE,
  );
  warnings.push(...sanitized.warnings);

  return { layerDir, accepted: accepted.map((f) => f.path), applied: sanitized.layer, warnings };
}

const WARNING_LABEL: Record<string, string> = {
  "invalid-yaml": "invalid YAML",
  "not-a-mapping": "not a mapping",
  "key-not-allowed": "key not allowed",
  "invalid-value": "invalid value",
  "model-not-allowed": "model not allowed",
  "unknown-provider": "unknown provider",
  "approval-downgrade": "approval downgrade",
  "policy-downgrade": "policy downgrade",
  "path-escape": "path escape",
  symlink: "symlink",
  "size-cap": "size cap",
  "file-count-cap": "file-count cap",
  "workflow-not-allowed": "workflow not allowed",
  "assets-not-allowed": "assets not allowed",
  "unrecognised-asset": "unrecognised asset",
  "fetch-failed": "fetch failed",
};

/** `lastlight repo config validate` — offline, exits non-zero if anything was rejected. */
function repoConfigValidate(opts: RepoOpts): number {
  const repoRoot = resolveRepoRoot(opts);
  const layerDir = path.join(repoRoot, LAYER_DIR);
  if (!isDir(layerDir)) {
    throw new Error(`No ${LAYER_DIR}/ directory in ${repoRoot}. Create one with: lastlight repo fork <workflow>`);
  }

  const report = validateLayer(layerDir);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.warnings.length > 0 ? 1 : 0;
  }

  console.log(chalk.bold(`Validating ${layerDir}\n`));

  // What the layer contributes, by role.
  const byKind = new Map<string, string[]>();
  for (const rel of report.accepted) {
    const kind = repoLayerPathKind(rel) ?? "other";
    byKind.set(kind, [...(byKind.get(kind) ?? []), rel]);
  }
  for (const [kind, paths] of [...byKind].sort()) {
    console.log(`  ${chalk.cyan(kind)}`);
    for (const rel of paths) console.log(`    ${chalk.green("✓")} ${rel}`);
  }
  if (report.accepted.length === 0) console.log(chalk.dim("  (no layer files)"));

  if (Object.keys(report.applied).length > 0) {
    console.log(chalk.bold("\nEffective config overrides"));
    for (const line of flatten(report.applied)) console.log(`  ${line}`);
  } else {
    // "No overrides" is not the same as "nothing accepted": a `crons:` block is
    // a fully supported, fully validated part of the layer that deliberately
    // contributes nothing to the MERGED config — it's read off the raw layer by
    // the scheduler at tick time (see `repoCronPrefs` in core's
    // src/cron/repo-crons.ts). Saying so here stops a clean `crons:`-only layer
    // reading as "my file was ignored".
    console.log(
      chalk.dim(`\nNo config overrides (${REPO_CONFIG_FILE} is absent, empty, or fully rejected).`) +
        chalk.dim(`\nA "crons:" block does not appear here — cron participation is applied separately, at tick time.`),
    );
  }

  if (report.warnings.length > 0) {
    console.log(chalk.bold(chalk.red(`\n${report.warnings.length} rejected`)));
    for (const w of report.warnings) {
      console.log(`  ${chalk.red("✗")} ${chalk.dim(`[${WARNING_LABEL[w.code] ?? w.code}]`)} ${w.path}`);
      console.log(`      ${chalk.dim(w.message)}`);
    }
    console.log(
      chalk.dim(
        `\nChecked against the shipped default bounds (repoConfig.allowKeys: ${DEFAULT_REPO_CONFIG_ALLOW_KEYS.join(", ")}).` +
          `\nA deployment may narrow them further — `,
      ) +
        chalk.cyan("lastlight repo config show <owner/repo>") +
        chalk.dim(" shows what a given server actually applies."),
    );
    return 1;
  }

  console.log(chalk.green("\n✓ Everything in this layer is within the shipped default bounds."));
  console.log(
    chalk.dim(
      `Bounds checked: repoConfig.allowKeys = ${DEFAULT_REPO_CONFIG_ALLOW_KEYS.join(", ")}; a deployment may narrow them.` +
        `\nRemember: only the layer on your DEFAULT BRANCH is ever read.`,
    ),
  );
  return 0;
}

/** Render a nested plain object as `a.b.c = value` lines, sorted. */
function flatten(node: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flatten(value as Record<string, unknown>, dotted));
    } else {
      out.push(`${chalk.cyan(dotted)} = ${JSON.stringify(value)}`);
    }
  }
  return out;
}

// ── repo config show ───────────────────────────────────────────────────────

/** The `GET /admin/api/repos/:owner/:repo/config` payload (src/admin/routes.ts). */
interface RepoConfigShowResponse {
  repo: string;
  merged?: {
    models?: Record<string, string>;
    variants?: Record<string, string>;
    disabled?: Record<string, string[]>;
    approval?: Record<string, boolean>;
    fix?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    review?: Record<string, unknown>;
  };
  sources?: Record<string, Record<string, ConfigSource> | ConfigSource>;
  repoLayer?: Record<string, unknown>;
  warnings?: RepoConfigWarning[];
  assets?: string[];
  fetchedAt?: string | null;
  treeSha?: string | null;
  defaultBranch?: string | null;
}

/** Tag a value with the layer that supplied it — `repo` is the interesting one. */
function sourceTag(source: ConfigSource | undefined): string {
  if (!source) return "";
  return source === "repo" ? chalk.green(`  (repo)`) : chalk.dim(`  (${source})`);
}

function printSection(
  title: string,
  values: Record<string, unknown> | undefined,
  sources: Record<string, ConfigSource> | ConfigSource | undefined,
): void {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return;
  console.log(chalk.bold(`\n${title}`));
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const source = typeof sources === "string" ? sources : sources?.[key];
    console.log(`  ${chalk.cyan(key)} = ${JSON.stringify(value)}${sourceTag(source)}`);
  }
}

/** `lastlight repo config show <owner/repo>` — the server's effective, post-bounds view. */
async function repoConfigShow(ref: string | undefined, opts: RepoOpts): Promise<void> {
  if (!ref || !/^[^/\s]+\/[^/\s]+$/.test(ref)) {
    throw new Error("Usage: lastlight repo config show <owner/repo>");
  }
  if (!opts.apiGet) throw new Error("repo config show needs an admin-API client (run it via the lastlight CLI).");
  const [owner, name] = ref.split("/");

  const data = (await opts.apiGet(
    `/admin/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/config` +
      (opts.refresh ? "?refresh=1" : ""),
  )) as RepoConfigShowResponse;

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(chalk.bold(`Effective config for ${ref}`));
  if (data.defaultBranch) {
    const sha = data.treeSha ? data.treeSha.slice(0, 7) : "—";
    console.log(chalk.dim(`  .lastlight/ from ${data.defaultBranch}@${sha}, fetched ${data.fetchedAt ?? "—"}`));
  } else {
    console.log(chalk.dim("  This repo commits no .lastlight/ — everything below is the instance config."));
  }

  printSection("Models", data.merged?.models, data.sources?.models);
  printSection("Variants", data.merged?.variants, data.sources?.variants);
  printSection("Disabled", data.merged?.disabled, data.sources?.disabled);
  printSection("Approval gates", data.merged?.approval, data.sources?.approval);
  printSection("Fix policy", data.merged?.fix, data.sources?.fix);
  printSection("Dependencies policy", data.merged?.dependencies, data.sources?.dependencies);
  printSection("Review policy", data.merged?.review, data.sources?.review);

  if (data.assets?.length) {
    console.log(chalk.bold("\nRepo assets"));
    for (const asset of data.assets) console.log(`  ${chalk.green("✓")} ${asset}`);
  }

  if (data.warnings?.length) {
    console.log(chalk.bold(chalk.yellow(`\n${data.warnings.length} rejected from this repo's layer`)));
    for (const w of data.warnings) {
      console.log(`  ${chalk.yellow("!")} ${chalk.dim(`[${WARNING_LABEL[w.code] ?? w.code}]`)} ${w.path}`);
      console.log(`      ${chalk.dim(w.message)}`);
    }
  }
  console.log(chalk.dim(`\nValues marked ${chalk.green("(repo)")}${chalk.dim(" came from this repo's .lastlight/.")}`));
}

// ── entry point ────────────────────────────────────────────────────────────

const USAGE = `Usage:
  lastlight repo fork [<workflow>|agent-context [file]|classifier|all]   [--home dir] [--force]
  lastlight repo config validate                                         [--json]
  lastlight repo config show <owner/repo>                                [--refresh] [--json]`;

/**
 * `lastlight repo <fork|config> …`. Returns the process exit code (non-zero
 * when `config validate` rejected something) so `cli.ts` owns `process.exit`.
 */
export async function repoCommand(args: string[], opts: RepoOpts): Promise<number> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "fork":
      repoFork(rest, opts);
      return 0;
    case "config": {
      const action = rest[0];
      if (action === "validate") return repoConfigValidate(opts);
      if (action === "show") {
        await repoConfigShow(rest[1], opts);
        return 0;
      }
      throw new Error(`Unknown "repo config" action: ${action ?? "(none)"}\n${USAGE}`);
    }
    default:
      throw new Error(`Unknown "repo" subcommand: ${sub ?? "(none)"}\n${USAGE}`);
  }
}
