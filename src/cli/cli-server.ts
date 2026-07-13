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
import { readCorePin, pickTagCommit } from "../config/core-pin.js";

const exec = promisify(execFile);

// ── constants ────────────────────────────────────────────────────────────────

/** SSH clone URL for the public core repo. */
export const CORE_REPO = "git@github.com:nearform/lastlight.git";
/** HTTPS URL for read-only operations (ls-remote from thin hosts). */
const CORE_REPO_HTTPS = "https://github.com/nearform/lastlight.git";
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

/** GHCR namespace the release CI (`publish.yml` `images` job) publishes the four
 *  locally-built images to. Public packages, so `docker pull` needs no login. */
export const IMAGE_REGISTRY = "ghcr.io/nearform";
/**
 * The images `server build` produces locally, each mapped to the GHCR repo the
 * release CI publishes it to. `server update` pulls these by tag and re-tags each
 * back to its LOCAL name, so `docker-compose.yml` and the harness — which spawn
 * sandboxes by the fixed `lastlight-sandbox:latest` / `lastlight-agent` names
 * (`src/sandbox/images.ts`) — find them unchanged, without any compose/runtime
 * change. `sandbox-qa` is optional: a miss just means browser-QA phases skip.
 */
export const PUBLISHED_IMAGES: { repo: string; localTag: string; optional?: boolean }[] = [
  { repo: "lastlight-agent", localTag: "lastlight-agent" },
  { repo: "lastlight-sandbox-base", localTag: "lastlight-sandbox-base:latest" },
  { repo: "lastlight-sandbox", localTag: "lastlight-sandbox:latest" },
  { repo: "lastlight-sandbox-qa", localTag: "lastlight-sandbox-qa:latest", optional: true },
];

/**
 * The image tag `server update` pulls: the overlay's core-version pin (e.g.
 * `v0.11.0`) when set, else `latest` (the newest published release). Mirrors the
 * core checkout the same pin drives, so a pulled image's baked `GIT_SHA` lines
 * up with the checked-out core and `server status` drift stays consistent.
 */
export function resolveImageTag(instance: string): string {
  return readCorePin(instance) ?? "latest";
}

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

/**
 * Build waves, run in order. Both `sandbox` and `sandbox-qa` are
 * `FROM lastlight-sandbox-base:latest`, and `docker compose build` builds a
 * single invocation's services in PARALLEL (the classic builder has no
 * FROM-dependency ordering) — so the shared base must be built in an earlier
 * invocation, or the leaf builds race their own base and fail to pull it.
 *
 *   wave 1 (buildArgv):        agent + sandbox-base   — independent, parallel-safe
 *   wave 2 (buildSandboxArgv): sandbox                — needs the base tagged
 *   wave 3 (buildQaArgv):      sandbox-qa             — needs the base, non-fatal
 */

/** Wave 1: the agent image (stamped with the core SHA) + the shared
 *  sandbox-base. Independent bases (node:22 vs node:20), safe to build together. */
export function buildArgv(gitSha: string): string[] {
  const args = ["build", "agent", "sandbox-base"];
  if (gitSha) args.push("--build-arg", `GIT_SHA=${gitSha}`);
  return args;
}

/** Wave 2: the lean sandbox — `FROM lastlight-sandbox-base:latest`, so it runs
 *  after wave 1 has tagged the base. */
export function buildSandboxArgv(): string[] {
  return ["build", "sandbox"];
}

/** Wave 3: the browser-QA sandbox — also `FROM` the shared base, built after it
 *  and non-fatally (a failure just means browser-QA phases skip). */
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

async function overlayDriftForInstance(instance: string): Promise<RepoDrift> {
  if (!isGitRepo(instance)) return compareDrift(null, null);
  const [current, remote] = await Promise.all([
    captureSoft("git", ["rev-parse", "HEAD"], instance),
    captureSoft("git", ["ls-remote", "origin", "HEAD"], instance),
  ]);
  return compareDrift(current, remote ? parseLsRemoteSha(remote) : null);
}

/**
 * Commit SHA a pin (git tag/ref) resolves to on `origin`, or null. Uses
 * `ls-remote` (no fetch) with a glob so an *annotated* tag surfaces its peeled
 * `…^{}` commit row — matching what `git rev-parse HEAD` reports after checking
 * the tag out. Falls back to a plain ref lookup for branch/SHA pins.
 */
async function resolvePinnedSha(home: string, pin: string): Promise<string | null> {
  const tags = await captureSoft("git", ["ls-remote", "origin", `refs/tags/${pin}*`], home);
  const fromTag = pickTagCommit(tags, pin);
  if (fromTag) return fromTag;
  const ref = await captureSoft("git", ["ls-remote", "origin", pin], home);
  return ref ? parseLsRemoteSha(ref) : null;
}

async function resolvePinnedShaRemote(
  pin: string,
  lsRemote: (remote: string, ref: string) => Promise<string | null>,
): Promise<string | null> {
  const tags = await lsRemote(CORE_REPO_HTTPS, `refs/tags/${pin}*`);
  const fromTag = pickTagCommit(tags ?? null, pin);
  if (fromTag) return fromTag;
  const ref = await lsRemote(CORE_REPO_HTTPS, pin);
  return ref ? parseLsRemoteSha(ref) : null;
}

/**
 * Compute core + overlay drift from the local checkouts under `home`. When the
 * overlay pins a core version (`deploy.version`), core drift is measured against
 * the pinned tag's commit (behind ⇒ "pin bumped, redeploy needed") rather than
 * against `main` HEAD.
 */
export async function localDrift(
  home: string,
): Promise<{ core: RepoDrift; overlay: RepoDrift; pin: string | null }> {
  const instance = path.join(home, "instance");
  const pin = readCorePin(instance);
  const [coreCur, coreLatest] = await Promise.all([
    captureSoft("git", ["rev-parse", "HEAD"], home),
    pin
      ? resolvePinnedSha(home, pin)
      : captureSoft("git", ["ls-remote", "origin", "HEAD"], home).then((o) => (o ? parseLsRemoteSha(o) : null)),
  ]);
  const overlay = await overlayDriftForInstance(instance);
  return {
    core: compareDrift(coreCur, coreLatest),
    overlay,
    pin,
  };
}

export interface ThinHostDriftDeps {
  inspectImage?: () => Promise<unknown>;
  lsRemote?: (remote: string, ref: string) => Promise<string | null>;
  overlay?: () => Promise<{ overlay: RepoDrift; pin: string | null }>;
}

function extractImageRevision(info: unknown): string | null {
  if (!info) return null;
  const first = Array.isArray(info) ? info[0] : info;
  if (!first || typeof first !== "object") return null;
  const config = (first as Record<string, unknown>).Config;
  const labels = config && typeof config === "object" ? (config as { Labels?: Record<string, unknown> }).Labels : null;
  if (!labels) return null;
  const revision =
    labels["org.opencontainers.image.revision"] ?? labels["org.opencontainers.image.source-revision"];
  if (typeof revision === "string" && /^[0-9a-f]{7,40}$/i.test(revision)) {
    return revision;
  }
  return null;
}

export async function thinHostDrift(
  home: string,
  instance: string,
  deps: ThinHostDriftDeps = {},
): Promise<{ core: RepoDrift; overlay: RepoDrift; pin: string | null }> {
  const inspectImage =
    deps.inspectImage ??
    (async () => {
      const raw = await captureSoft("docker", ["image", "inspect", "lastlight-agent"], home);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    });
  const lsRemote = deps.lsRemote ?? ((remote: string, ref: string) => captureSoft("git", ["ls-remote", remote, ref]));
  const overlayProvider =
    deps.overlay ??
    (async () => ({ overlay: await overlayDriftForInstance(instance), pin: readCorePin(instance) }));

  const { overlay, pin } = await overlayProvider();

  const inspect = await inspectImage();
  const current = extractImageRevision(inspect);
  if (!current) {
    p.log.warn(
      `Could not determine the core revision from the ${chalk.bold("lastlight-agent")} image. ` +
        `Pull the published images with ${chalk.cyan("lastlight server update")}.`,
    );
  }

  let latest: string | null = null;
  if (pin) {
    latest = await resolvePinnedShaRemote(pin, lsRemote);
    if (!latest) {
      p.log.warn(`Failed to resolve pinned core version ${chalk.bold(pin)} on ${CORE_REPO_HTTPS}.`);
    }
  } else {
    const head = await lsRemote(CORE_REPO_HTTPS, "HEAD");
    if (!head) {
      p.log.warn(`Failed to resolve core HEAD on ${CORE_REPO_HTTPS}.`);
    }
    latest = head ? parseLsRemoteSha(head) : null;
  }

  return {
    core: compareDrift(current, latest),
    overlay,
    pin,
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
  /** `--no-build` → skip touching images entirely (just up + restart). */
  build?: boolean;
  /** `--local` → build images from source instead of pulling prebuilt (default). */
  local?: boolean;
}

export type WorkingDirLayout = "checkout" | "thin";

export interface ResolvedHomeAndLayout {
  home: string;
  layout: WorkingDirLayout;
}

function layoutError(home: string, reason: string): never {
  p.log.error(
    `${reason}\n` +
      `  Run ${chalk.cyan("lastlight server setup")} first, or pass ${chalk.cyan("--home <dir>")} to choose a different directory.`,
  );
  process.exit(1);
}

function readPackageName(home: string): string | null {
  const pkgPath = path.join(home, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      const name = (parsed as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the working dir and classify its layout (checkout vs thin host). */
export function resolveHomeAndLayout(opts: ServerOpts): ResolvedHomeAndLayout {
  const home = path.resolve(resolveServerHome(opts.home));
  if (!fs.existsSync(home)) {
    layoutError(home, `No lastlight assets at ${chalk.bold(home)}.`);
  }
  const pkgName = readPackageName(home);
  if (pkgName !== "lastlight") {
    const reason =
      pkgName === null
        ? `No ${chalk.bold("package.json")} found in ${chalk.bold(home)}.`
        : `Expected ${chalk.bold("package.json name")} to be ${chalk.bold("lastlight")}, found ${chalk.bold(pkgName)}.`;
    layoutError(home, reason);
  }
  if (isGitRepo(home)) {
    return { home, layout: "checkout" };
  }
  const instanceDir = path.join(home, "instance");
  const composePath = path.join(home, "docker-compose.yml");
  if (fs.existsSync(instanceDir) && fs.existsSync(composePath)) {
    return { home, layout: "thin" };
  }
  layoutError(home, `The directory ${chalk.bold(home)} is not a lastlight checkout or thin-host bundle.`);
}

export function ensureLocalBuildAllowed(layout: WorkingDirLayout, command: string): void {
  if (layout !== "thin") return;
  const guidance = command.includes("--local")
    ? `Re-run ${chalk.cyan("lastlight server update")} without ${chalk.cyan("--local")}, or execute it from a full checkout.`
    : `Run ${chalk.cyan("lastlight server setup")} to provision a full checkout before running ${chalk.bold(command)}.`;
  p.log.error(
    `${chalk.bold(command)} is only supported from a full lastlight checkout.\n  ${guidance}`,
  );
  process.exit(1);
}

// ── commands ─────────────────────────────────────────────────────────────────

/** `lastlight server setup` — scaffold (or adopt) the working directory. */
export async function serverSetup(opts: ServerOpts & { local?: boolean }): Promise<void> {
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

  // 3b. Honour a core-version pin the overlay declares, so the FIRST deploy
  // builds the pinned commit rather than whatever `main` the clone landed on.
  // A fresh / unpinned overlay leaves the clone on `main` — no-op.
  const pin = readCorePin(instance);
  if (pin) await pinCore(home, pin);

  // 4. Offer an initial fetch + launch. Defaults to pulling prebuilt images
  // (fast); `--local` builds from source.
  const prompt = opts.local ? "Build images and start the stack now?" : "Pull images and start the stack now?";
  const build = opts.yes ? true : await p.confirm({ message: prompt, initialValue: true });
  if (!p.isCancel(build) && build) {
    await serverUpdate({ ...opts, home, core: false, overlay: false, build: true });
  } else {
    p.outro(`Ready. Start it with: ${chalk.cyan("lastlight server start")}`);
  }
}

/** `lastlight server start [service]`. */
export async function serverStart(service: string | undefined, opts: ServerOpts): Promise<void> {
  const { home } = resolveHomeAndLayout(opts);
  // The agent image is built locally (never published), and several services
  // reference the `lastlight-agent` tag. Starting before it exists yields an
  // opaque "pull access denied" from docker — pre-check and point at the build
  // step instead. Only gate the whole-stack start; a single-service start may
  // legitimately target something else.
  if (!service && !(await agentImageExists())) {
    p.log.error(
      `The ${chalk.bold("lastlight-agent")} image isn't present yet.\n` +
        `  Run ${chalk.cyan("lastlight server update")} to pull prebuilt images + start` +
        ` (or ${chalk.cyan("lastlight server build")} / ${chalk.cyan("server update --local")} to build from source).`,
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
  const { home } = resolveHomeAndLayout(opts);
  await composeRun(home, service ? `Stop ${service}` : "Stop stack (down)", stopArgv(service));
  p.log.success("Stopped.");
}

/** `lastlight server restart [service]` (default `agent`). */
export async function serverRestart(service: string | undefined, opts: ServerOpts): Promise<void> {
  const { home } = resolveHomeAndLayout(opts);
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
  // Wave 1: agent + the shared sandbox-base (independent bases).
  await composeRun(home, "Build images", buildArgv(sha));
  // Wave 2: the lean sandbox (FROM lastlight-sandbox-base:latest) — must run
  // after wave 1 tags the base, since compose builds one invocation's services
  // in parallel and would otherwise race the FROM.
  await composeRun(home, "Build sandbox", buildSandboxArgv());
  // Wave 3: browser-QA sandbox (also FROM the shared base) — non-fatally: a
  // failure just means browser-QA phases skip (graceful degradation) rather
  // than blocking the whole deploy.
  try {
    await composeRun(home, "Build browser-QA sandbox", buildQaArgv());
  } catch (err) {
    p.log.warn(`sandbox-qa build failed — browser QA will skip until rebuilt: ${(err as Error).message}`);
  }
}

/**
 * Pull the prebuilt images for `tag` from GHCR and re-tag each to its LOCAL name
 * (`lastlight-agent`, `lastlight-sandbox:latest`, …), so docker-compose + the
 * harness find them by the names they already use. This is the default
 * (registry) alternative to `buildImages` — a pull is seconds where a build is
 * minutes. `sandbox-qa` is non-fatal, mirroring the build path; a missing
 * required image throws with a pointer to `--local`.
 */
async function pullImages(home: string, tag: string): Promise<void> {
  for (const img of PUBLISHED_IMAGES) {
    const remote = `${IMAGE_REGISTRY}/${img.repo}:${tag}`;
    try {
      await runStep(`Pull ${img.repo}:${tag}`, "docker", ["pull", remote], home);
      // Re-tag to the local name the compose file + harness reference. Quiet —
      // `docker tag` is instant and prints nothing worth a header.
      await exec("docker", ["tag", remote, img.localTag], { cwd: home });
    } catch (err) {
      if (img.optional) {
        p.log.warn(`${img.repo} pull failed — browser QA will skip until pulled/built: ${(err as Error).message}`);
        continue;
      }
      throw new Error(
        `Failed to pull ${remote}: ${(err as Error).message}\n` +
          `  If this version isn't published yet, build from source with: ${chalk.cyan("lastlight server update --local")}`,
      );
    }
  }
}

const COMPOSE_ASSETS = ["docker-compose.yml", "Caddyfile"] as const;

export interface SyncComposeAssetsOptions {
  home: string;
  ref: string;
  fetcher?: typeof fetch;
}

function writeFileAtomic(target: string, contents: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

const composeTree = (ref: string) => (ref === "latest" ? "main" : ref);

export async function syncComposeAssets({ home, ref, fetcher }: SyncComposeAssetsOptions): Promise<void> {
  const fetchImpl = fetcher ?? fetch;
  const tree = composeTree(ref);
  p.log.step(chalk.bold(`Sync compose assets (${tree})`));
  for (const file of COMPOSE_ASSETS) {
    const url = `https://raw.githubusercontent.com/nearform/lastlight/${tree}/${file}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { cache: "no-store" });
    } catch (err) {
      throw new Error(`Failed to fetch ${file} from ${tree}: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch ${file} from ${tree} (HTTP ${response.status}).`);
    }
    const body = await response.text();
    writeFileAtomic(path.join(home, file), body);
    p.log.info(`${chalk.bold(file)} ← ${chalk.dim(url)}`);
  }
  p.log.success(`Compose assets synced from ${tree}.`);
}

/**
 * `lastlight server build` — build the docker images FROM SOURCE without starting
 * anything. The local-build escape hatch: `server update` pulls prebuilt images
 * by default (use `server update --local` to build + up). Does not pull git or
 * bring the stack up.
 */
export async function serverBuild(opts: ServerOpts): Promise<void> {
  const { home, layout } = resolveHomeAndLayout(opts);
  ensureLocalBuildAllowed(layout, "server build");
  await buildImages(home);
  p.log.success(`Built. Start with: ${chalk.cyan("lastlight server start")}`);
}

/**
 * Fetch tags and check `home`'s core repo out at `pin` (a git tag/ref). The
 * resulting detached HEAD is expected — this is a deploy checkout, not a working
 * branch. `buildImages` stamps GIT_SHA from `git rev-parse HEAD`, so the image
 * is correctly labelled with the pinned commit. Shared by `update` and `setup`.
 */
async function pinCore(home: string, pin: string): Promise<void> {
  await runStep("Fetch core tags", "git", ["-C", home, "fetch", "origin", "--tags", "--prune"]);
  await runStep(`Pin core → ${pin}`, "git", ["-C", home, "-c", "advice.detachedHead=false", "checkout", pin]);
}

/** `lastlight server update` — the deploy.sh-equivalent flow. */
export async function serverUpdate(opts: UpdateOpts): Promise<void> {
  const { home, layout } = resolveHomeAndLayout(opts);
  const pullCore = opts.core !== false;
  const pullOverlay = opts.overlay !== false;
  const doBuild = opts.build !== false;
  const instance = path.join(home, "instance");

  if (layout === "thin" && opts.local) {
    ensureLocalBuildAllowed(layout, "server update --local");
  }

  if (layout === "checkout") {
    // Overlay first: it's the declarative source of truth, so a freshly-bumped
    // deploy.version must be visible before we converge the core checkout.
    if (pullOverlay) {
      if (isGitRepo(instance)) {
        await runStep("Pull overlay", "git", ["-C", instance, "pull", "--ff-only"]);
      } else {
        p.log.warn("No overlay checkout at instance/ — skipping overlay pull.");
      }
    }
    if (pullCore) {
      const pin = readCorePin(instance);
      if (pin) {
        await pinCore(home, pin);
      } else {
        // Return to main (a previous pin may have left HEAD detached), then ff.
        await runStep("Track core main", "git", ["-C", home, "checkout", "main"]);
        await runStep("Pull core", "git", ["-C", home, "pull", "--ff-only", "origin", "main"]);
      }
    }
  } else {
    if (pullOverlay) {
      p.log.warn("Thin-host layout: skipping overlay pull — no git checkout present.");
    }
    if (pullCore) {
      p.log.warn("Thin-host layout: skipping core pull — no git checkout present.");
    }
  }

  ensureOverrideSymlink(home);

  const imageTag = resolveImageTag(instance);

  // Images: pull prebuilt from GHCR by default (seconds); `--local` builds from
  // source (minutes). `--no-build` skips both — just recreate + restart.
  if (doBuild) {
    if (layout === "checkout" && opts.local) {
      await buildImages(home);
    } else {
      await pullImages(home, imageTag);
    }
  }

  if (layout === "thin") {
    await syncComposeAssets({ home, ref: imageTag });
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
  drift: { core: RepoDrift; overlay: RepoDrift; pin: string | null };
  overrides: OverlayAsset[];
}> {
  const { home, layout } = resolveHomeAndLayout(opts);
  await composeRun(home, "Compose state", ["ps"]);

  const instance = path.join(home, "instance");
  const drift = layout === "thin" ? await thinHostDrift(home, instance) : await localDrift(home);
  const row = (label: string, d: RepoDrift) =>
    `  ${chalk.bold(label.padEnd(8))} ${short(d.current)} → ${short(d.latest)}  ` +
    (d.behind ? chalk.yellow("behind") : d.latest ? chalk.green("up to date") : chalk.dim("unknown"));
  console.log();
  console.log(chalk.bold("Version"));
  if (drift.pin) {
    // Pinned: measured against the pinned tag, so "behind" means "pin bumped —
    // redeploy needed", not "behind main".
    const state = drift.core.behind
      ? chalk.yellow("redeploy needed")
      : drift.core.latest
        ? chalk.green("up to date")
        : chalk.dim("unknown");
    console.log(
      `  ${chalk.bold("core".padEnd(8))} ${short(drift.core.current)} → ${short(drift.core.latest)}  ` +
        `${chalk.cyan(`pinned ${drift.pin}`)}  ${state}`,
    );
  } else {
    console.log(row("core", drift.core));
  }
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
