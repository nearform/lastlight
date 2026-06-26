/**
 * Shared bootstrap for the private deployment overlay (`instance/`).
 *
 * The overlay is a separate, private folder (typically its own GitHub repo)
 * holding this deployment's `config.yaml` + `secrets/` + optional asset
 * overrides. It's mounted read-only at `/app/instance` and selected via
 * `LASTLIGHT_OVERLAY_DIR`. On a clean server there's nothing to clone yet — so
 * this module can *create* one from scratch:
 *
 *  - {@link scaffoldOverlayFiles} — write the default files into a fresh overlay
 *    (never overwriting anything that already exists).
 *  - {@link detectGh} — probe the GitHub CLI for install + auth status.
 *  - {@link bootstrapOverlayRepo} — `git init` + initial commit, then offer to
 *    create + push a private GitHub repo (via `gh` when authed, otherwise print
 *    the exact git/GitHub commands to run by hand).
 *
 * Used by both setup entry points: the `lastlight setup` wizard (`src/setup.ts`)
 * and host-local `lastlight server setup` (`src/cli-server.ts`).
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";

const exec = promisify(execFile);
const dim = chalk.dim;
const teal = chalk.hex("#1A7A8A");

// ── templates ────────────────────────────────────────────────────────────────

/** `.gitignore` for the overlay so it can be its own private repo without
 *  leaking secrets. Everything under `secrets/` is ignored except the template. */
export const OVERLAY_GITIGNORE = [
  "# Host-only secrets — never commit. Everything under secrets/ is ignored",
  "# except the template.",
  "secrets/*",
  "!secrets/.env.example",
  ".env",
  "*.pem",
  "",
].join("\n");

/** Placeholder `config.yaml` for a fresh overlay (no managed repos yet). */
export const OVERLAY_CONFIG_PLACEHOLDER = [
  "# Last Light — private deployment overlay config",
  "# Merged over the public config/default.yaml at startup; arrays replace,",
  "# maps deep-merge, env vars override. Restart the agent to apply:",
  "#   docker compose restart agent  (or: lastlight server restart agent)",
  "",
  "managedRepos:",
  "  []  # add owner/repo entries — the bot ignores repos not listed here",
  "",
].join("\n");

/** Template `secrets/.env.example` — the only tracked file under `secrets/`.
 *  Mirrors the keys `npx lastlight setup` writes into `secrets/.env`. */
export const OVERLAY_ENV_EXAMPLE = [
  "# ── Last Light — environment template ───────────────────────────",
  "# Copy to secrets/.env and fill in. The whole instance/ folder is mounted",
  "# read-only at /app/instance; the entrypoint reads secrets from",
  "# /app/instance/secrets. secrets/.env and *.pem are gitignored.",
  "",
  "# ── Overlay (this deployment's private config + assets) ──",
  "LASTLIGHT_OVERLAY_DIR=/app/instance",
  "",
  "# ── GitHub App (required) ────────────────────────────────",
  "GITHUB_APP_ID=",
  "# PEM lives at instance/secrets/app.pem; the entrypoint symlinks it to /app/app.pem.",
  "GITHUB_APP_PRIVATE_KEY_PATH=./app.pem",
  "GITHUB_APP_INSTALLATION_ID=",
  "",
  "# ── Webhook (required) — must match the GitHub App webhook secret ──",
  "WEBHOOK_SECRET=",
  "",
  "# ── Domain (used by Caddy for TLS) ───────────────────────",
  "DOMAIN=localhost",
  "",
  "# ── Model + provider API key ─────────────────────────────",
  "LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6",
  "# Set whichever matches your LASTLIGHT_MODEL (anthropic/…, openai/…, or openrouter/…).",
  "# ANTHROPIC_API_KEY=",
  "# OPENAI_API_KEY=",
  "# OPENROUTER_API_KEY=",
  "",
  "# ── Admin dashboard ──────────────────────────────────────",
  "ADMIN_SECRET=",
  "# ADMIN_PASSWORD=",
  "",
  "# ── Slack (optional) ─────────────────────────────────────",
  "# SLACK_BOT_TOKEN=",
  "# SLACK_APP_TOKEN=",
  "# SLACK_DELIVERY_CHANNEL=",
  "# SLACK_ALLOWED_USERS=",
  "",
].join("\n");

/** README dropped into a freshly scaffolded overlay. */
export const OVERLAY_README = [
  "# lastlight-instance",
  "",
  "Private deployment overlay for [Last Light](https://github.com/cliftonc/lastlight).",
  "Keeps deployment-specific config and secrets out of the public repo.",
  "",
  "Cloned into `instance/` next to the lastlight checkout's `docker-compose.yml`,",
  "mounted read-only at `/app/instance`, selected via `LASTLIGHT_OVERLAY_DIR=/app/instance`.",
  "",
  "## Layout",
  "",
  "```",
  "config.yaml            # overlay config — merged over public config/default.yaml",
  "agent-context/*.md     # (optional) persona/rules overrides, merged by filename",
  "workflows/*.yaml       # (optional) add or replace workflows by logical name",
  "workflows/prompts/*.md # (optional) prompt overrides",
  "skills/<name>/SKILL.md # (optional) skill overrides",
  "secrets/               # host-only, gitignored: .env + GitHub App *.pem",
  "  .env.example         # template (the only tracked file under secrets/)",
  "```",
  "",
  "## First-time secrets",
  "",
  "```bash",
  "cp secrets/.env.example secrets/.env   # then fill in keys, DOMAIN, etc.",
  "cp /path/to/app.pem secrets/app.pem    # GitHub App private key",
  "```",
  "",
  "Editing the overlay is **restart-only** (no image rebuild):",
  "`git pull` then `lastlight server restart agent`.",
  "",
].join("\n");

// ── gh detection ───────────────────────────────────────────────────────────────

export interface GhStatus {
  /** `gh` is on PATH. */
  installed: boolean;
  /** `gh auth status` succeeded — we can create repos. */
  authed: boolean;
  /** Authenticated GitHub login, when resolvable. */
  login?: string;
}

/** Probe the GitHub CLI. Never throws — a missing/unauthed `gh` resolves to a
 *  status the callers fall back from (print manual commands instead). */
export async function detectGh(): Promise<GhStatus> {
  try {
    await exec("gh", ["--version"], { timeout: 10_000 });
  } catch {
    return { installed: false, authed: false };
  }
  let authed = false;
  try {
    await exec("gh", ["auth", "status"], { timeout: 10_000 });
    authed = true;
  } catch {
    return { installed: true, authed: false };
  }
  let login: string | undefined;
  try {
    const { stdout } = await exec("gh", ["api", "user", "--jq", ".login"], { timeout: 10_000 });
    login = stdout.trim() || undefined;
  } catch {
    /* authed but couldn't read login — leave undefined */
  }
  return { installed: true, authed, login };
}

// ── scaffolding ────────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  /** Repo-relative paths of files this call created (existing files untouched). */
  created: string[];
}

/**
 * Write the default overlay files into `instanceDir`, creating only what's
 * missing — never overwriting an existing file. Returns the relative paths
 * created so callers can report them.
 */
export function scaffoldOverlayFiles(instanceDir: string): ScaffoldResult {
  const created: string[] = [];
  const secretsDir = path.join(instanceDir, "secrets");
  fs.mkdirSync(secretsDir, { recursive: true });

  const writeIfMissing = (rel: string, content: string): void => {
    const abs = path.join(instanceDir, rel);
    if (fs.existsSync(abs)) return;
    fs.writeFileSync(abs, content, { encoding: "utf8" });
    created.push(rel);
  };

  writeIfMissing("config.yaml", OVERLAY_CONFIG_PLACEHOLDER);
  writeIfMissing(".gitignore", OVERLAY_GITIGNORE);
  writeIfMissing("README.md", OVERLAY_README);
  writeIfMissing(path.join("secrets", ".env.example"), OVERLAY_ENV_EXAMPLE);

  return { created };
}

// ── repo bootstrap ─────────────────────────────────────────────────────────────

export interface BootstrapOpts {
  /** Pre-probed gh status (call {@link detectGh} once and pass it in). */
  gh: GhStatus;
  /** Non-interactive — skip prompts, just print the manual commands. */
  yes?: boolean;
}

/** Run a command with inherited stdio so the user sees native git/gh output. */
function run(label: string, cmd: string, args: string[], cwd?: string): Promise<void> {
  p.log.step(chalk.bold(label));
  console.log(dim(`  $ ${cmd} ${args.join(" ")}`));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code ?? "signal"})`)),
    );
  });
}

async function gitCaptureSoft(args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 20_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** Print the exact commands to version + publish the overlay by hand. */
function printManualHint(instanceDir: string, gh: GhStatus, needsInit: boolean): void {
  const slug = gh.login ? `${gh.login}/lastlight-instance` : "<owner>/lastlight-instance";
  const lines: string[] = ["To version + publish this overlay yourself:"];
  if (needsInit) {
    lines.push(
      `  git -C ${instanceDir} init -b main`,
      `  git -C ${instanceDir} add -A`,
      `  git -C ${instanceDir} commit -m "Initial Last Light overlay"`,
    );
  }
  if (gh.installed) {
    lines.push(`  gh repo create ${slug} --private --source ${instanceDir} --remote origin --push`);
  } else {
    lines.push(
      `  # create a PRIVATE repo on GitHub (e.g. ${slug}), then:`,
      `  git -C ${instanceDir} remote add origin git@github.com:${slug}.git`,
      `  git -C ${instanceDir} push -u origin main`,
    );
  }
  p.log.info(lines.map((l, i) => (i === 0 ? l : dim(l))).join("\n  "));
  p.log.info(
    dim("Secrets (secrets/.env, *.pem) stay gitignored. To match the prod deploy-key style,") +
      "\n  " +
      dim("clone via an SSH host alias, e.g. git@github-instance:<owner>/lastlight-instance.git."),
  );
}

/**
 * Version `instanceDir` as a private git repo and (optionally) create + push a
 * GitHub repo for it. Idempotent: skips `git init` when already a repo, and
 * skips repo creation when an `origin` remote already exists. Falls back to
 * printing the manual commands whenever `gh` is unavailable or the user declines.
 */
export async function bootstrapOverlayRepo(instanceDir: string, opts: BootstrapOpts): Promise<void> {
  let versioned = isGitRepo(instanceDir);

  if (!versioned) {
    if (opts.yes) {
      printManualHint(instanceDir, opts.gh, true);
      return;
    }
    const want = await p.confirm({
      message: "Version instance/ as a private git repo now?",
      initialValue: true,
    });
    if (p.isCancel(want) || !want) {
      printManualHint(instanceDir, opts.gh, true);
      return;
    }
    try {
      await run("git init", "git", ["init", "-b", "main", instanceDir]);
      await run("Stage overlay files", "git", ["-C", instanceDir, "add", "-A"]);
      await run("Initial commit", "git", ["-C", instanceDir, "commit", "-m", "Initial Last Light overlay"]);
      versioned = true;
    } catch (err) {
      p.log.warn(
        `Couldn't auto-create the git repo: ${(err as Error).message}\n` +
          "  (Is git's user.name / user.email configured?)",
      );
      printManualHint(instanceDir, opts.gh, !versioned);
      return;
    }
  }

  // Already (or now) a repo — does it already point somewhere?
  const remotes = await gitCaptureSoft(["remote"], instanceDir);
  if (remotes && remotes.split(/\s+/).includes("origin")) {
    p.log.info("Overlay already has an 'origin' remote — leaving it as-is.");
    return;
  }

  if (opts.gh.authed && !opts.yes) {
    const want = await p.confirm({
      message: "Create a private GitHub repo and push the overlay now?",
      initialValue: true,
    });
    if (!p.isCancel(want) && want) {
      const def = opts.gh.login ? `${opts.gh.login}/lastlight-instance` : "lastlight-instance";
      const slug = await p.text({ message: "Repository (owner/name)", initialValue: def });
      if (!p.isCancel(slug) && slug.trim()) {
        try {
          await run("Create + push private repo", "gh", [
            "repo", "create", slug.trim(),
            "--private", "--source", instanceDir, "--remote", "origin", "--push",
          ]);
          p.log.success(`Pushed overlay to ${teal(slug.trim())} ${dim("(private)")}.`);
          return;
        } catch (err) {
          p.log.warn(`gh repo create failed: ${(err as Error).message}`);
          // fall through to the manual hint
        }
      }
    }
  }

  printManualHint(instanceDir, opts.gh, false);
}
