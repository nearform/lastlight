/**
 * Host-local `lastlight skills …` — install the Last Light Claude Code skills
 * into a local Claude Code instance.
 *
 * The skills live in this package's `plugins/lastlight/` tree (shipped via the
 * package `files` allowlist) and are also published as a Claude Code marketplace
 * via `.claude-plugin/marketplace.json` at the public `nearform/lastlight` repo
 * root (mirrored into this package for offline use). Two install paths:
 *
 *  1. **Marketplace** (preferred when the `claude` CLI is present): register the
 *     marketplace and install the plugin. By default the marketplace source is
 *     the remote GitHub repo (`nearform/lastlight`) so the installed skills stay
 *     current — `claude plugin update` (and Claude Code's own refresh) pulls new
 *     versions straight from git rather than being pinned to this CLI's bundled
 *     copy. `--local` (or an unreachable remote) falls back to the bundled path,
 *     which is version-matched to this CLI and works offline.
 *  2. **Copy fallback** (no `claude` CLI): copy each `skills/<name>/` directory
 *     into the scope's skills dir (`~/.claude/skills` for user,
 *     `<cwd>/.claude/skills` for project), which Claude Code auto-discovers with
 *     no marketplace at all.
 *
 * Like `lastlight fork` / `lastlight server`, this operates on local files — not
 * over HTTP.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import chalk from "chalk";

/** Marketplace + plugin identifiers — must match `.claude-plugin/marketplace.json`. */
const MARKETPLACE_NAME = "lastlight-skills";
const PLUGIN_NAME = "lastlight";
/**
 * Remote marketplace source — the public GitHub repo whose root holds
 * `.claude-plugin/marketplace.json`. Registering this (rather than the bundled
 * local path) lets Claude Code clone + auto-update the skills from git.
 */
const MARKETPLACE_SOURCE = "nearform/lastlight";

export type SkillScope = "user" | "project";

export interface SkillsOpts {
  /** Install scope — `user` (~/.claude) or `project` (<cwd>/.claude). Default `user`. */
  scope?: SkillScope;
  /** Skip the `claude` marketplace path and always copy skill dirs directly. */
  noMarketplace?: boolean;
  /** Register the bundled local marketplace instead of the remote GitHub source. */
  local?: boolean;
}

// ── bundle resolution ────────────────────────────────────────────────────────

/**
 * Package root that holds `.claude-plugin/marketplace.json` and
 * `plugins/<plugin>/`. Resolves for both dev (`src/skills-install.ts` → repo
 * root) and compiled/installed (`dist/skills-install.js` → package root).
 */
export function bundleRoot(): string {
  // The compiled entry sits at `dist/skills-install.js` — one level below the
  // CLI package root (which holds `plugins/` + `.claude-plugin/`). In dev the
  // source sits at `src/skills-install.ts`, also one level down. So `..` from
  // this file's dir resolves the package root in both modes (locked decision 12).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function pluginDir(): string {
  return path.join(bundleRoot(), "plugins", PLUGIN_NAME);
}

function skillsSrcDir(): string {
  return path.join(pluginDir(), "skills");
}

/** Names of the bundled skill directories (each holding a SKILL.md). */
function bundledSkillNames(): string[] {
  const dir = skillsSrcDir();
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function assertBundlePresent(): void {
  if (bundledSkillNames().length === 0) {
    throw new Error(
      `No bundled skills found under ${skillsSrcDir()} — the package may be built without the plugins/ assets.`,
    );
  }
}

// ── scope paths ──────────────────────────────────────────────────────────────

function scopeSkillsDir(scope: SkillScope): string {
  const base = scope === "project" ? process.cwd() : os.homedir();
  return path.join(base, ".claude", "skills");
}

// ── claude CLI detection ─────────────────────────────────────────────────────

function hasClaudeCli(): boolean {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/** Run a `claude` subcommand, inheriting stdio so the user sees progress. */
function claude(args: string[]): boolean {
  const res = spawnSync("claude", args, { stdio: "inherit" });
  return res.status === 0;
}

/** One entry from `claude plugin marketplace list --json`. */
interface MarketplaceEntry {
  name: string;
  /** `"github"`, `"directory"`, `"git"`, … */
  source?: string;
  /** Present when source is `github` — e.g. `"nearform/lastlight"`. */
  repo?: string;
  /** Present when source is `directory` — the local path it was added from. */
  path?: string;
}

/** The currently-registered `lastlight-skills` marketplace, if any. */
function currentMarketplace(): MarketplaceEntry | undefined {
  const res = spawnSync("claude", ["plugin", "marketplace", "list", "--json"], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return undefined;
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return undefined;
    return (parsed as MarketplaceEntry[]).find((m) => m?.name === MARKETPLACE_NAME);
  } catch {
    return undefined;
  }
}

/** Whether a registered marketplace already points at the source we're about to add. */
function marketplaceMatches(entry: MarketplaceEntry, remote: boolean): boolean {
  return remote
    ? entry.source === "github" && entry.repo === MARKETPLACE_SOURCE
    : entry.source === "directory" && entry.path === bundleRoot();
}

// ── copy fallback ────────────────────────────────────────────────────────────

function copySkills(scope: SkillScope): string[] {
  const destRoot = scopeSkillsDir(scope);
  fs.mkdirSync(destRoot, { recursive: true });
  const installed: string[] = [];
  for (const name of bundledSkillNames()) {
    const src = path.join(skillsSrcDir(), name);
    const dest = path.join(destRoot, name);
    // Bundle skills are managed artifacts — replace any existing copy so it
    // tracks this CLI version.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    installed.push(name);
  }
  return installed;
}

// ── commands ─────────────────────────────────────────────────────────────────

export async function skillsInstall(opts: SkillsOpts): Promise<void> {
  assertBundlePresent();
  const scope = opts.scope ?? "user";
  const names = bundledSkillNames();

  // Preferred: register the marketplace + install via the claude CLI. Default to
  // the remote GitHub source so the skills auto-update from git; `--local` (or an
  // unreachable remote) uses the bundled copy that ships with this CLI.
  if (!opts.noMarketplace && hasClaudeCli()) {
    const remote = !opts.local;
    const source = remote ? MARKETPLACE_SOURCE : bundleRoot();
    console.log(chalk.dim(`Using the claude CLI (marketplace: ${source})`));
    // A same-named marketplace from a different source shadows our `add`, so
    // remove any mismatched one first. This migrates users of older CLIs (which
    // registered `lastlight-skills` from a bundled local path) onto the remote
    // auto-updating source — and lets `--local` switch back the other way.
    const existing = currentMarketplace();
    if (existing && !marketplaceMatches(existing, remote)) {
      console.log(chalk.dim(`Re-pointing the ${MARKETPLACE_NAME} marketplace at ${source}…`));
      claude(["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    }
    // `marketplace add` may report "already added" — non-fatal; ignore its status.
    claude(["plugin", "marketplace", "add", source]);
    let ok = claude(["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--scope", scope]);
    // If the remote source didn't take (e.g. offline / no git), retry with the
    // bundled marketplace so a first install still succeeds.
    if (!ok && remote) {
      console.log(
        chalk.yellow(`Install from ${MARKETPLACE_SOURCE} failed — retrying with the bundled marketplace.`),
      );
      claude(["plugin", "marketplace", "add", bundleRoot()]);
      ok = claude(["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--scope", scope]);
    }
    if (ok) {
      console.log(
        chalk.green(`✓ Installed ${PLUGIN_NAME}@${MARKETPLACE_NAME}`) +
          chalk.dim(` (${scope} scope) — ${names.length} skills`),
      );
      if (remote) {
        console.log(
          chalk.dim(`  Sourced from ${MARKETPLACE_SOURCE} — run \`claude plugin update\` to pull newer versions.`),
        );
      }
      console.log(chalk.dim("  Start a new Claude Code session to use them."));
      return;
    }
    console.log(chalk.yellow("claude plugin install failed — falling back to copying skills."));
  }

  // Fallback: copy skill dirs into the scope's skills directory.
  const installed = copySkills(scope);
  const destRoot = scopeSkillsDir(scope);
  console.log(
    chalk.green(`✓ Copied ${installed.length} skills`) +
      chalk.dim(` → ${destRoot}`),
  );
  for (const n of installed) console.log(chalk.dim(`  • ${n}`));
  console.log(chalk.dim("  Start a new Claude Code session to use them."));
}

export async function skillsList(opts: SkillsOpts): Promise<void> {
  assertBundlePresent();
  const names = bundledSkillNames();
  const userDir = scopeSkillsDir("user");
  const projDir = scopeSkillsDir("project");
  console.log(chalk.bold(`Bundled Last Light skills (${names.length})`));
  for (const n of names) {
    const marks: string[] = [];
    if (fs.existsSync(path.join(userDir, n))) marks.push("user");
    if (fs.existsSync(path.join(projDir, n))) marks.push("project");
    const where = marks.length ? chalk.green(` [installed: ${marks.join(", ")}]`) : chalk.dim(" [not installed]");
    console.log(`  • ${n}${where}`);
  }
  console.log(
    chalk.dim(
      `\nInstall: lastlight skills install [--scope user|project] [--local]\n` +
        `Marketplace: ${PLUGIN_NAME}@${MARKETPLACE_NAME} (${MARKETPLACE_SOURCE}; --local uses ${bundleRoot()})`,
    ),
  );
}

export async function skillsUninstall(opts: SkillsOpts): Promise<void> {
  const scope = opts.scope ?? "user";
  // Best-effort marketplace uninstall if the claude CLI is present.
  if (!opts.noMarketplace && hasClaudeCli()) {
    claude(["plugin", "uninstall", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--scope", scope]);
  }
  // Remove any copied skill dirs in this scope.
  const destRoot = scopeSkillsDir(scope);
  let removed = 0;
  for (const n of bundledSkillNames()) {
    const dest = path.join(destRoot, n);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
      removed++;
    }
  }
  console.log(
    chalk.green(`✓ Uninstalled Last Light skills`) +
      chalk.dim(` (${scope} scope${removed ? `, removed ${removed} copied dirs` : ""})`),
  );
}

/** Entry point dispatched from `src/cli.ts` for `lastlight skills …`. */
export async function skills(args: string[], opts: SkillsOpts): Promise<void> {
  const sub = args[0] ?? "install";
  switch (sub) {
    case "install":
      return skillsInstall(opts);
    case "list":
      return skillsList(opts);
    case "uninstall":
    case "remove":
      return skillsUninstall(opts);
    default:
      console.error(
        "Usage:\n" +
          "  lastlight skills install [--scope user|project] [--no-marketplace]\n" +
          "  lastlight skills list\n" +
          "  lastlight skills uninstall [--scope user|project]",
      );
      process.exit(1);
  }
}
