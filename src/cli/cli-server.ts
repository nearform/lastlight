/**
 * Host-local server lifecycle for the `lastlight` CLI —
 * `server setup | start | stop | restart | update | status`.
 *
 * Unlike the rest of the CLI (a thin HTTP client for a *remote* instance),
 * these commands shell out to `git` and `docker compose` in a **working
 * directory** on the host: a full git checkout of the lastlight repo plus the
 * private `instance/` overlay and the `docker-compose.override.yml` symlink —
 * i.e. the docker build context. The CLI is the control plane; the working dir
 * is what `docker compose` builds and runs. `server update` reproduces the
 * production `deploy.sh` flow (git pull core + overlay → build → up → restart
 * the egress sidecars → health-check) with live progress.
 *
 * The working dir resolves via `resolveServerHome()` (`--home` → `LASTLIGHT_HOME`
 * → saved `serverHome` → `~/lastlight`). All `docker compose` invocations run
 * with `cwd = home` so the override and `instance/secrets/.env` resolve exactly
 * as they do in production.
 */
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { resolveServerHome, saveServerHome, serverHomeSource } from "./cli-config.js";
import { detectGh, scaffoldOverlayFiles, bootstrapOverlayRepo } from "../config/overlay-bootstrap.js";
import { enumerateOverlayAssets, type OverlayAsset } from "../config/overlay-assets.js";

const exec = promisify(execFile);

// ── constants ────────────────────────────────────────────────────────────────

/** SSH clone URL for the public core repo. */
export const CORE_REPO = "git@github.com:nearform/lastlight.git";
/** Default clone URL for the private deployment overlay (see CLAUDE.md). */
export const OVERLAY_REPO_DEFAULT = "git@github-instance:cliftonc/lastlight-instance.git";
/** Compose override the overlay ships; symlinked into the project root. */
export const OVERRIDE_FILE = "docker-compose.override.yml";
/** Egress firewall + collector sidecars force-restarted after an update so they
 *  re-read any regenerated nginx/coredns/collector configs (mirrors deploy.sh). */
export const SIDECARS = [
  "coredns-strict",
  "coredns-open",
  "nginx-egress-strict",
  "nginx-egress-open",
  "otel-collector",
];
/** Loopback health endpoint the harness serves (admin/routes.ts `GET /health`). */
const HEALTH_URL = "http://127.0.0.1:8644/health";

// ── pure argv builders (unit-tested) ─────────────────────────────────────────

/** `docker compose` args for `server start [service]`. */
export function startArgv(service?: string): string[] {
  return service ? ["up", "-d", service] : ["up", "-d"];
}

/** `docker compose` args for `server stop [service]` — `stop` one service, or
 *  bring the whole stack `down` when none is named. */
export function stopArgv(service?: string): string[] {
  return service ? ["stop", service] : ["down"];
}

/** `docker compose` args for `server restart [service]` (default `agent`). */
export function restartArgv(service?: string): string[] {
  return ["restart", service ?? "agent"];
}

/** `docker compose build` args for an update, stamping the core SHA. */
export function buildArgv(gitSha: string): string[] {
  const args = ["build", "agent", "sandbox"];
  if (gitSha) args.push("--build-arg", `GIT_SHA=${gitSha}`);
  return args;
}

/** `docker compose build` args for the browser-QA sandbox image. Built after
 *  the base sandbox (it's FROM lastlight-sandbox:latest) and non-fatally. */
export function buildQaArgv(): string[] {
  return ["build", "sandbox-qa"];
}

/** `docker compose up -d --remove-orphans` for an update. */
export function upArgv(): string[] {
  return ["up", "-d", "--remove-orphans"];
}

/** `docker compose restart <sidecars…>` for an update. */
export function restartSidecarsArgv(): string[] {
  return ["restart", ...SIDECARS];
}

/** First column of `git ls-remote <url> <ref>` output — the SHA, or null. */
export function parseLsRemoteSha(stdout: string): string | null {
  const first = stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{7,40}$/i.test(first) ? first : null;
}

// ── compose detection ────────────────────────────────────────────────────────

let _compose: { cmd: string; pre: string[] } | null = null;
/** Resolve `docker compose` (v2) vs `docker-compose` (v1) once per process. */
function compose(): { cmd: string; pre: string[] } {
  if (_compose) return _compose;
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    _compose = { cmd: "docker", pre: ["compose"] };
  } catch {
    try {
      execFileSync("docker-compose", ["version"], { stdio: "ignore" });
      _compose = { cmd: "docker-compose", pre: [] };
    } catch {
      _compose = { cmd: "docker", pre: ["compose"] }; // fall through; errors clearly
    }
  }
  return _compose;
}

// ── process helpers ──────────────────────────────────────────────────────────

/**
 * Run a command with inherited stdio so the user sees native progress (docker
 * build layers, git transfer). Prints a labelled header + the exact argv first.
 * Rejects with a clear message on non-zero exit.
 */
function runStep(label: string, cmd: string, args: string[], cwd?: string): Promise<void> {
  p.log.step(chalk.bold(label));
  console.log(chalk.dim(`  $ ${cmd} ${args.join(" ")}`));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code ?? "signal"})`)),
    );
  });
}

/** Run a `docker compose` subcommand in `home` with inherited stdio. */
function composeRun(home: string, label: string, args: string[]): Promise<void> {
  const c = compose();
  return runStep(label, c.cmd, [...c.pre, ...args], home);
}

/** Capture a command's trimmed stdout (used for git SHAs); throws on failure. */
async function capture(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd, timeout: 20_000 });
  return stdout.trim();
}

/** Capture stdout, returning null instead of throwing (best-effort lookups). */
async function captureSoft(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    return await capture(cmd, args, cwd);
  } catch {
    return null;
  }
}

// ── filesystem helpers ───────────────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * Ensure `<home>/docker-compose.override.yml` is a symlink to the overlay's
 * `instance/docker-compose.override.yml`, so `docker compose` auto-loads it.
 * No-op when the overlay ships no override, or when a real file already sits
 * there (left untouched).
 */
export function ensureOverrideSymlink(home: string): void {
  const overlayOverride = path.join("instance", OVERRIDE_FILE); // relative to home
  const absOverlay = path.join(home, overlayOverride);
  const link = path.join(home, OVERRIDE_FILE);
  if (!fs.existsSync(absOverlay)) return;
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch {
    /* missing — create below */
  }
  if (existing && !existing.isSymbolicLink()) {
    p.log.warn(`${OVERRIDE_FILE} exists as a regular file — leaving it; not symlinking the overlay override.`);
    return;
  }
  if (existing) fs.unlinkSync(link);
  fs.symlinkSync(overlayOverride, link); // relative target keeps the checkout portable
  p.log.success(chalk.dim(`${OVERRIDE_FILE}`) + " → " + chalk.dim(overlayOverride));
}

// ── version drift (computed locally; host has full git access) ────────────────

export interface RepoDrift {
  current: string | null;
  latest: string | null;
  behind: boolean;
}

/** Short SHA for display. */
function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : chalk.dim("unknown");
}

function compareDrift(current: string | null, latest: string | null): RepoDrift {
  const behind = !!current && !!latest && current !== latest;
  return { current, latest, behind };
}

/** Compute core + overlay drift from the local checkouts under `home`. */
export async function localDrift(home: string): Promise<{ core: RepoDrift; overlay: RepoDrift }> {
  const instance = path.join(home, "instance");
  const [coreCur, coreRemote, ovCur, ovRemote] = await Promise.all([
    captureSoft("git", ["rev-parse", "HEAD"], home),
    captureSoft("git", ["ls-remote", "origin", "HEAD"], home),
    isGitRepo(instance) ? captureSoft("git", ["rev-parse", "HEAD"], instance) : Promise.resolve(null),
    isGitRepo(instance) ? captureSoft("git", ["ls-remote", "origin", "HEAD"], instance) : Promise.resolve(null),
  ]);
  return {
    core: compareDrift(coreCur, coreRemote ? parseLsRemoteSha(coreRemote) : null),
    overlay: compareDrift(ovCur, ovRemote ? parseLsRemoteSha(ovRemote) : null),
  };
}

// ── health check ─────────────────────────────────────────────────────────────

async function healthCheck(retries = 15, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// ── command options ──────────────────────────────────────────────────────────

export interface ServerOpts {
  /** `--home <dir>` override for the working directory. */
  home?: string;
  /** Skip the interactive confirm in `--yes`-style flows. */
  yes?: boolean;
}

export interface UpdateOpts extends ServerOpts {
  /** `--no-core` → don't pull the core repo. */
  core?: boolean;
  /** `--no-overlay` → don't pull the instance overlay. */
  overlay?: boolean;
  /** `--no-build` → skip the docker build (just up + restart). */
  build?: boolean;
}

/** Resolve the working dir and fail clearly if it isn't a checkout yet. */
function requireHome(opts: ServerOpts): string {
  const home = resolveServerHome(opts.home);
  if (!isGitRepo(home)) {
    p.log.error(
      `No lastlight checkout at ${chalk.bold(home)}.\n` +
        `  Run ${chalk.cyan("lastlight server setup")} first, or pass ${chalk.cyan("--home <dir>")}.`,
    );
    process.exit(1);
  }
  return home;
}

// ── commands ─────────────────────────────────────────────────────────────────

/** `lastlight server setup` — scaffold (or adopt) the working directory. */
export async function serverSetup(opts: ServerOpts): Promise<void> {
  p.intro(chalk.bold("lastlight server setup"));
  let home = resolveServerHome(opts.home);
  // A saved serverHome silently wins over the directory you're standing in —
  // the common "it set up somewhere else" surprise. Say so loudly before the
  // prompt (which defaults to it) so it's obvious this is NOT your cwd.
  if (serverHomeSource(opts.home) === "saved") {
    p.log.warn(
      `Defaulting to your saved working directory ${chalk.bold(home)} ` +
        `(not the current folder). Edit the prompt below or pass ${chalk.cyan("--home <dir>")} to change it.`,
    );
  }
  if (!opts.yes) {
    const answer = await p.text({
      message: "Working directory for the server (checkout + overlay)",
      initialValue: home,
    });
    if (p.isCancel(answer)) { p.cancel("Cancelled."); process.exit(1); }
    home = answer;
  }
  home = path.resolve(home);

  // 1. Core checkout — adopt an existing one, else clone.
  if (isGitRepo(home)) {
    p.log.info(`Adopting existing checkout at ${chalk.bold(home)}.`);
  } else {
    fs.mkdirSync(path.dirname(home), { recursive: true });
    await runStep("Clone core repo", "git", ["clone", CORE_REPO, home]);
  }

  // 2. Overlay under instance/ — clone an existing one, create a fresh one, or skip.
  const instance = path.join(home, "instance");
  if (isGitRepo(instance)) {
    p.log.info("Overlay already present at instance/.");
  } else if (opts.yes) {
    // Non-interactive: preserve prior behaviour — clone the default overlay.
    await runStep("Clone overlay", "git", ["clone", OVERLAY_REPO_DEFAULT, instance]);
  } else {
    const choice = await p.select({
      message: "Deployment overlay (instance/) — config + secrets for this server",
      options: [
        { value: "create", label: "Create a fresh overlay", hint: "scaffold defaults + optional private GitHub repo" },
        { value: "clone", label: "Clone an existing overlay repo", hint: "you already have one" },
        { value: "skip", label: "Skip for now", hint: "add config + secrets into instance/ yourself" },
      ],
      initialValue: "create",
    });
    if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(1); }

    if (choice === "clone") {
      const answer = await p.text({
        message: "Overlay (instance) git URL",
        initialValue: OVERLAY_REPO_DEFAULT,
      });
      if (p.isCancel(answer)) { p.cancel("Cancelled."); process.exit(1); }
      const overlayUrl = answer.trim();
      if (overlayUrl) {
        await runStep("Clone overlay", "git", ["clone", overlayUrl, instance]);
      } else {
        p.log.warn("No URL given — skipped overlay clone. Drop config + secrets into instance/ before starting.");
      }
    } else if (choice === "create") {
      const { created } = scaffoldOverlayFiles(instance);
      // Print the ABSOLUTE instance path — the message used to read "in
      // instance/" which looks cwd-relative, but it's <home>/instance and
      // `home` may be a saved serverHome, not the directory you're standing in.
      p.log.success(
        created.length > 0
          ? `Scaffolded ${created.length} file${created.length === 1 ? "" : "s"} in ${chalk.bold(instance)} ` +
              chalk.dim(`(${created.join(", ")})`)
          : `Overlay files already present in ${chalk.bold(instance)}`,
      );
      p.log.warn(
        `Fill in ${chalk.bold(path.join(instance, "secrets", ".env"))} and drop your GitHub App *.pem into ${chalk.bold(path.join(instance, "secrets"))} before starting.`,
      );
      await bootstrapOverlayRepo(instance, { gh: await detectGh() });
    } else {
      p.log.warn("Skipped overlay — drop config + secrets into instance/ before starting.");
    }
  }

  // 3. Override symlink + persist the home.
  ensureOverrideSymlink(home);
  saveServerHome(home);
  p.log.success(`Saved serverHome = ${chalk.bold(home)}`);

  // 4. Offer an initial build + launch.
  const build = opts.yes
    ? true
    : await p.confirm({ message: "Build images and start the stack now?", initialValue: true });
  if (!p.isCancel(build) && build) {
    await serverUpdate({ ...opts, home, core: false, overlay: false, build: true });
  } else {
    p.outro(`Ready. Start it with: ${chalk.cyan("lastlight server start")}`);
  }
}

/** `lastlight server start [service]`. */
export async function serverStart(service: string | undefined, opts: ServerOpts): Promise<void> {
  const home = requireHome(opts);
  // The agent image is built locally (never published), and several services
  // reference the `lastlight-agent` tag. Starting before it exists yields an
  // opaque "pull access denied" from docker — pre-check and point at the build
  // step instead. Only gate the whole-stack start; a single-service start may
  // legitimately target something else.
  if (!service && !(await agentImageExists())) {
    p.log.error(
      `The ${chalk.bold("lastlight-agent")} image isn't built yet.\n` +
        `  Run ${chalk.cyan("lastlight server build")} first (or ${chalk.cyan("lastlight server update")} to build + start).`,
    );
    process.exit(1);
  }
  await composeRun(home, service ? `Start ${service}` : "Start stack", startArgv(service));
  p.log.success("Started.");
}

/** Whether the locally-built `lastlight-agent` image exists. */
async function agentImageExists(): Promise<boolean> {
  return (await captureSoft("docker", ["image", "inspect", "lastlight-agent"])) !== null;
}

/** `lastlight server stop [service]`. */
export async function serverStop(service: string | undefined, opts: ServerOpts): Promise<void> {
  const home = requireHome(opts);
  await composeRun(home, service ? `Stop ${service}` : "Stop stack (down)", stopArgv(service));
  p.log.success("Stopped.");
}

/** `lastlight server restart [service]` (default `agent`). */
export async function serverRestart(service: string | undefined, opts: ServerOpts): Promise<void> {
  const home = requireHome(opts);
  const target = service ?? "agent";
  await composeRun(home, `Restart ${target}`, restartArgv(service));
  p.log.success(`Restarted ${target}.`);
}

/**
 * Build the agent + sandbox images (stamping the core SHA) plus the browser-QA
 * sandbox (non-fatal — a failure just means browser-QA phases skip). Shared by
 * `server build` and `server update`.
 */
async function buildImages(home: string): Promise<void> {
  const sha = (await captureSoft("git", ["rev-parse", "HEAD"], home)) ?? "";
  await composeRun(home, "Build images", buildArgv(sha));
  // Browser-QA sandbox (FROM lastlight-sandbox:latest) — build after the base
  // image, and non-fatally: a failure just means browser-QA phases skip
  // (graceful degradation) rather than blocking the whole deploy.
  try {
    await composeRun(home, "Build browser-QA sandbox", buildQaArgv());
  } catch (err) {
    p.log.warn(`sandbox-qa build failed — browser QA will skip until rebuilt: ${(err as Error).message}`);
  }
}

/**
 * `lastlight server build` — build the docker images without starting anything.
 * The explicit first-run step so `server start` has images to run; `server
 * update` folds this in (pull + build + up). Does not pull git or bring the
 * stack up.
 */
export async function serverBuild(opts: ServerOpts): Promise<void> {
  const home = requireHome(opts);
  await buildImages(home);
  p.log.success(`Built. Start with: ${chalk.cyan("lastlight server start")}`);
}

/** `lastlight server update` — the deploy.sh-equivalent flow. */
export async function serverUpdate(opts: UpdateOpts): Promise<void> {
  const home = requireHome(opts);
  const pullCore = opts.core !== false;
  const pullOverlay = opts.overlay !== false;
  const doBuild = opts.build !== false;
  const instance = path.join(home, "instance");

  if (pullCore) {
    await runStep("Pull core", "git", ["-C", home, "pull", "--ff-only", "origin", "main"]);
  }
  if (pullOverlay) {
    if (isGitRepo(instance)) {
      await runStep("Pull overlay", "git", ["-C", instance, "pull", "--ff-only"]);
    } else {
      p.log.warn("No overlay checkout at instance/ — skipping overlay pull.");
    }
  }

  ensureOverrideSymlink(home);

  if (doBuild) {
    await buildImages(home);
  }

  await composeRun(home, "Recreate services", upArgv());
  await composeRun(home, "Restart egress sidecars", restartSidecarsArgv());

  p.log.step(chalk.bold("Health check"));
  const healthy = await healthCheck();
  if (!healthy) {
    p.log.error(`Server did not become healthy at ${HEALTH_URL}. Check: lastlight server logs agent`);
    process.exit(1);
  }
  p.log.success("Healthy.");
  p.outro(chalk.green("Update complete."));
}

/** `lastlight server status` — compose state + local version drift + overrides. */
export async function serverStatus(opts: ServerOpts): Promise<{
  home: string;
  drift: { core: RepoDrift; overlay: RepoDrift };
  overrides: OverlayAsset[];
}> {
  const home = requireHome(opts);
  await composeRun(home, "Compose state", ["ps"]);

  const drift = await localDrift(home);
  const row = (label: string, d: RepoDrift) =>
    `  ${chalk.bold(label.padEnd(8))} ${short(d.current)} → ${short(d.latest)}  ` +
    (d.behind ? chalk.yellow("behind") : d.latest ? chalk.green("up to date") : chalk.dim("unknown"));
  console.log();
  console.log(chalk.bold("Version"));
  console.log(row("core", drift.core));
  console.log(row("overlay", drift.overlay));
  if (drift.core.behind || drift.overlay.behind) {
    console.log(chalk.yellow(`\nUpdate available — run: ${chalk.cyan("lastlight server update")}`));
  }

  // Forked/overridden assets the overlay supplies (workflows, prompts, skills,
  // agent-context). Shared with the dashboard's Config → Overrides pane.
  const overrides = enumerateOverlayAssets({ coreRoot: home, overlayRoot: path.join(home, "instance") });
  console.log();
  console.log(chalk.bold("Overrides"));
  if (overrides.length === 0) {
    console.log(chalk.dim("  none — the overlay forks no built-in assets"));
  } else {
    const order: OverlayAsset["type"][] = ["workflow", "cron", "prompt", "skill", "agent-context"];
    for (const type of order) {
      for (const a of overrides.filter((o) => o.type === type)) {
        const tag = a.shadowsDefault ? chalk.yellow("shadows default") : chalk.green("added");
        console.log(`  ${chalk.bold(type.padEnd(13))} ${a.name.padEnd(28)} ${tag}`);
      }
    }
  }

  return { home, drift, overrides };
}
