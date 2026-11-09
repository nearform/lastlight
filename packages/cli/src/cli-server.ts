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
import {
  detectGh,
  scaffoldOverlayFiles,
  bootstrapOverlayRepo,
  enumerateOverlayAssets,
  type OverlayAsset,
  readCorePin,
  readKeepImageVersions,
  pickTagCommit,
} from "lastlight-shared";

const exec = promisify(execFile);

// ── constants ────────────────────────────────────────────────────────────────

/** SSH clone URL for the public core repo. */
export const CORE_REPO = "git@github.com:nearform/lastlight.git";
/** Default clone URL for the private deployment overlay (see CLAUDE.md). */
export const OVERLAY_REPO_DEFAULT = "git@github-instance:cliftonc/lastlight-instance.git";
/** Compose override the overlay ships; symlinked into the project root. */
export const OVERRIDE_FILE = "docker-compose.override.yml";

/**
 * The F5 home/serverDir split (monorepo Phase 2): `home` stays the GIT ROOT —
 * all `git -C home` operations, the `instance/` overlay clone,
 * `readCorePin(home/instance)` and the override symlink live there — while the
 * compose/asset root (docker-compose.yml, the Dockerfiles, the built-in
 * workflows/skills/agent-context) moved to `<home>/apps/server`.
 */
export function serverDir(home: string): string {
  return path.join(home, "apps", "server");
}
/** Egress firewall + collector sidecars force-RECREATED after an update so they
 *  re-read any regenerated nginx/coredns/collector configs AND come back on their
 *  static `ipv4_address` on `sandbox-egress`. A `restart` would keep whatever
 *  address they hold: when compose recreates the network (an IPAM change, as
 *  v0.41.0's `ip_range` did) it reattaches them WITHOUT the pin, docker hands out
 *  dynamic addresses, and every sandbox's `--dns 172.30.0.10` then hangs. */
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

/** How many superseded GHCR version tags per repo `server update` keeps when it
 *  prunes (newest-first). Two = the current deploy plus one rollback target.
 *  An overlay overrides it with `deploy.keepImageVersions` (`1` on a tight disk). */
export const KEEP_IMAGE_VERSIONS = 2;

/** Descending semver-ish compare for `vMAJOR.MINOR.PATCH` tags (numeric, so
 *  `v0.12.8` sorts below `v0.13.0`). Non-numeric parts compare as 0. */
function cmpVersionDesc(a: string, b: string): number {
  const parts = (t: string) => t.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Decide which of a repo's local tags `server update` should delete: keep the
 * `keep` newest `vX.Y.Z` version tags plus `keepTag` (the one just deployed),
 * drop the rest. Pure, so the retention policy is unit-tested without touching
 * docker.
 *
 * `latest` goes too when the deploy is PINNED to a version: a pinned update
 * only ever pulls the version tag, so a `:latest` left from before the pin is
 * never refreshed and never superseded — it sat on drizby for two months as
 * ~12 GB nothing referenced (the local names compose uses point at the
 * deployed version). An unpinned deploy runs `latest`, so it stays. Other
 * floating tags (`main`, `edge`) are an operator's hand pulls — left alone.
 */
export function tagsToPrune(tags: string[], keepTag: string, keep = KEEP_IMAGE_VERSIONS): string[] {
  const isVersion = (t: string) => /^v\d/.test(t);
  const versions = tags.filter(isVersion);
  const keepSet = new Set([...versions].sort(cmpVersionDesc).slice(0, keep));
  keepSet.add(keepTag);
  const stale = versions.filter((t) => !keepSet.has(t));
  if (isVersion(keepTag) && tags.includes("latest")) stale.push("latest");
  return stale;
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

/**
 * `docker compose up -d --no-deps --force-recreate <sidecars…>` for an update.
 * Recreate, not restart — see {@link SIDECARS}. `--no-deps` keeps it to these
 * five; it never touches the network, so an attached sandbox doesn't block it.
 */
export function recreateSidecarsArgv(extra: readonly string[] = []): string[] {
  return ["up", "-d", "--no-deps", "--force-recreate", ...SIDECARS, ...extra];
}

/**
 * Pinned `sandbox-egress` services behind an opt-in compose profile — today
 * only `model-gateway` (172.30.0.40; sandboxes dial it by IP). Recreated and
 * address-checked only when already running: naming a profiled service on the
 * command line activates its profile, which would start it on a host that has
 * no `sandboxGateway` provider (and no config for it to read).
 */
export const OPTIONAL_PINNED_SIDECARS = ["model-gateway"];

/**
 * `docker compose config` args that can see every sidecar in `services`.
 * `config` omits a profile-gated service unless its profile is active, and the
 * CLI's own env rarely sets `COMPOSE_PROFILES`, so without `--profile` the
 * model-gateway pin is never found and the check passes it blind.
 */
export function sidecarConfigArgv(services: readonly string[]): string[] {
  const profiles = services.filter((s) => OPTIONAL_PINNED_SIDECARS.includes(s));
  return [...profiles.flatMap((s) => ["--profile", s]), "config", "--format", "json"];
}

/** The optional pinned sidecars with a running container. */
async function runningOptionalSidecars(home: string): Promise<string[]> {
  const c = compose();
  const out: string[] = [];
  for (const svc of OPTIONAL_PINNED_SIDECARS) {
    const id = await captureSoft(c.cmd, composeArgv(home, ["ps", "-q", svc], c.pre), home);
    if (id) out.push(svc);
  }
  return out;
}

/** Recreate the egress sidecars (plus any running optional one), then check their addresses. */
async function recreateAndVerifySidecars(home: string): Promise<void> {
  const optional = await runningOptionalSidecars(home);
  await composeRun(home, "Recreate egress sidecars", recreateSidecarsArgv(optional));
  await verifySidecarAddresses(home, "lastlight server update --no-build", [...SIDECARS, ...optional]);
}

// ── state database (`server db …`) ───────────────────────────────────────────

/**
 * Where `lastlight-state` lives inside the agent image, and where the SQLite
 * database is mounted. Both are CONTAINER paths, not host ones — the tool runs
 * IN the image because that is where `pg`, `@libsql/client` and the Drizzle
 * schemas are. The CLI itself may never depend on `lastlight-core`.
 *
 * `/app/dist/…`, not `/app/apps/server/dist/…`: the Dockerfile's `pnpm deploy`
 * FLATTENS the package into `/app`, so the monorepo path does not survive into
 * the image (`CMD ["node", "dist/index.js"]` is the same shape).
 */
export const STATE_CLI_PATH = "/app/dist/state/state-cli.js";
export const CONTAINER_DB_PATH = "/app/data/lastlight.db";

export interface DbMigrateOptions {
  /** Source database, as the CONTAINER sees it. Defaults to the mounted volume. */
  from?: string;
  /** Target `postgres://` URL. Omitted → the container's own `DATABASE_URL`. */
  to?: string;
  driver?: string;
  batch?: string;
  dryRun?: boolean;
  truncate?: boolean;
  json?: boolean;
}

/**
 * `docker compose run` args for a one-off `lastlight-state` invocation.
 *
 * `--rm` (no container left behind), `--no-deps` (this needs the agent's image
 * and volumes, not the egress sidecars), and `--entrypoint node` to bypass the
 * image's normal boot. Pure so the argv is unit-testable — the mistakes worth
 * fencing are silent ones, like losing `--no-deps` and quietly starting the
 * stack mid-migration.
 */
export function dbMigrateArgv(opts: DbMigrateOptions): string[] {
  const args = [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "agent",
    STATE_CLI_PATH,
    "migrate",
    "--from",
    opts.from ?? CONTAINER_DB_PATH,
  ];
  // Omitting `--to` is the RECOMMENDED path: the container already has
  // DATABASE_URL from `instance/secrets/.env`, so the credential never reaches
  // the host's process list or shell history.
  if (opts.to) args.push("--to", opts.to);
  if (opts.driver) args.push("--driver", opts.driver);
  if (opts.batch) args.push("--batch", opts.batch);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.truncate) args.push("--truncate");
  if (opts.json) args.push("--json");
  return args;
}

/** `docker compose run` args for the connectivity probe. */
export function dbCheckArgv(url?: string): string[] {
  const args = [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "agent",
    STATE_CLI_PATH,
    "check",
  ];
  if (url) args.push("--url", url);
  return args;
}

/**
 * `lastlight server db check|migrate` — the state-database tools, run inside
 * the agent image.
 *
 * The migration reads the live SQLite file and applies its pending migrations,
 * so the agent must not be running. That is checked rather than assumed: a
 * concurrent writer produces a target that is subtly short of rows, and the
 * row-count verification would report the mismatch long after the operator has
 * moved on.
 */
export async function serverDb(
  action: string | undefined,
  opts: ServerOpts & DbMigrateOptions & { url?: string },
): Promise<void> {
  const home = resolveServerHome(opts.home);
  if (action === "check") {
    await composeRun(home, "Checking the database connection", dbCheckArgv(opts.url));
    return;
  }
  if (action !== "migrate") {
    p.log.error("Usage: lastlight server db check [--url <url>] | migrate [--to <url>] [--dry-run]");
    process.exitCode = 2;
    return;
  }

  if (!opts.dryRun && (await agentIsRunning(home))) {
    p.log.warn(
      "The agent is running. Migrating while it writes to the SQLite database " +
        "produces a target that is quietly short of rows.",
    );
    if (!opts.yes) {
      const go = await p.confirm({ message: "Stop the agent and continue?", initialValue: true });
      if (go !== true) {
        p.log.info("Nothing was copied.");
        return;
      }
    }
    await serverStop("agent", { home });
  }

  await composeRun(
    home,
    opts.dryRun ? "Counting rows (dry run)" : "Copying state to Postgres",
    dbMigrateArgv(opts),
  );

  if (!opts.dryRun) {
    p.log.success("Copy complete.");
    p.log.info(
      "Next: set DATABASE_URL in instance/secrets/.env, then " +
        chalk.cyan("lastlight server start agent") +
        chalk.dim("  (a recreate — env_file vars are injected at container creation)"),
    );
  }
}

/** Is the `agent` service up? `compose ps` prints nothing for a stopped one. */
async function agentIsRunning(home: string): Promise<boolean> {
  const c = compose();
  const out = await captureSoft(
    c.cmd,
    composeArgv(home, ["ps", "-q", "agent"], c.pre),
    home,
  );
  return !!out?.trim();
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

/**
 * File/project args spliced into EVERY compose invocation (the F5 split): the
 * compose file lives at `<home>/apps/server/docker-compose.yml`, but the
 * project directory stays `home` so the compose file's `./`-relative paths
 * (`build.context: .`, `./instance`, `./apps/server/Caddyfile`) resolve
 * against the repo root exactly as before the move. Passing an explicit `-f`
 * DISABLES compose's auto-loading of `docker-compose.override.yml`, so the
 * overlay's override symlink is passed as a second `-f` when present.
 */
export function composeFileArgs(home: string): string[] {
  const args = ["-f", path.join(serverDir(home), "docker-compose.yml")];
  const override = path.join(home, OVERRIDE_FILE);
  if (fs.existsSync(override)) args.push("-f", override);
  args.push("--project-directory", home);
  return args;
}

/**
 * Full argv (after the binary) for one compose invocation — pure assembly of
 * the binary's `pre` args + the `-f`/`--project-directory` prefix + the
 * subcommand args. Exported for the F5 regression fence
 * (tests/cli/compose-argv.test.ts).
 */
export function composeArgv(home: string, args: string[], pre: string[] = ["compose"]): string[] {
  return [...pre, ...composeFileArgs(home), ...args];
}

/** Run a `docker compose` subcommand in `home` with inherited stdio. */
function composeRun(home: string, label: string, args: string[]): Promise<void> {
  const c = compose();
  return runStep(label, c.cmd, composeArgv(home, args, c.pre), home);
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

// ── sandbox network pre-flight ───────────────────────────────────────────────

/** One IPAM pool, normalised from compose config or `docker network inspect`. */
export interface IpamPool {
  subnet: string;
  ipRange: string;
}

/** A running container attached to the sandbox network. */
export interface AttachedContainer {
  name: string;
  /** `com.docker.compose.project` label; empty for harness-spawned sandboxes. */
  project: string;
}

export type SandboxNetworkVerdict =
  | { kind: "ok" }
  | { kind: "recreate" }
  | { kind: "blocked"; blockers: string[] };

/**
 * Decide whether `compose up` can apply the sandbox network's IPAM settings.
 *
 * Compose can't change a network's IPAM in place: when they differ it stops the
 * services on the network, removes it and creates it again. The removal fails
 * while a container compose doesn't manage (a harness-spawned sandbox) is still
 * attached, and by then the services are already stopped. So when the network
 * must be recreated and such a container is attached, `server update` stops
 * before it touches anything.
 *
 * `actual` is null when the network doesn't exist yet (compose just creates it).
 */
export function sandboxNetworkVerdict(
  desired: IpamPool[],
  actual: IpamPool[] | null,
  attached: AttachedContainer[],
  project: string,
): SandboxNetworkVerdict {
  if (actual === null) return { kind: "ok" };
  const key = (pools: IpamPool[]) =>
    pools.map((x) => `${x.subnet}|${x.ipRange}`).sort().join(",");
  if (key(desired) === key(actual)) return { kind: "ok" };
  const blockers = attached.filter((c) => c.project !== project).map((c) => c.name).sort();
  return blockers.length ? { kind: "blocked", blockers } : { kind: "recreate" };
}

/**
 * Check the `sandbox-egress` network before `compose up` recreates services.
 * Exits non-zero (nothing stopped yet) when the network needs recreating while
 * sandboxes are attached; best-effort otherwise — if docker can't be queried,
 * the command proceeds as before. `rerun` is the command the error tells the
 * operator to run again.
 */
async function guardSandboxNetwork(home: string, rerun = "lastlight server update"): Promise<void> {
  const c = compose();
  const raw = await captureSoft(c.cmd, composeArgv(home, ["config", "--format", "json"], c.pre), home);
  if (!raw) return;
  let project: string;
  let name: string;
  let desired: IpamPool[];
  try {
    const cfg = JSON.parse(raw) as {
      name?: string;
      networks?: Record<string, { name?: string; ipam?: { config?: { subnet?: string; ip_range?: string }[] } }>;
    };
    const net = cfg.networks?.["sandbox-egress"];
    if (!cfg.name || !net?.name) return;
    project = cfg.name;
    name = net.name;
    desired = (net.ipam?.config ?? []).map((x) => ({ subnet: x.subnet ?? "", ipRange: x.ip_range ?? "" }));
  } catch {
    return;
  }

  const inspect = await captureSoft("docker", ["network", "inspect", name, "--format", "{{json .IPAM.Config}}"]);
  let actual: IpamPool[] | null = null;
  if (inspect) {
    try {
      const pools = (JSON.parse(inspect) ?? []) as { Subnet?: string; IPRange?: string }[];
      actual = pools.map((x) => ({ subnet: x.Subnet ?? "", ipRange: x.IPRange ?? "" }));
    } catch {
      return;
    }
  }

  const ps = await captureSoft("docker", [
    "ps", "--filter", `network=${name}`,
    "--format", '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  const attached: AttachedContainer[] = (ps ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [n, proj = ""] = line.split("\t");
      return { name: n, project: proj };
    });

  const verdict = sandboxNetworkVerdict(desired, actual, attached, project);
  if (verdict.kind === "recreate") {
    p.log.info(`Network ${chalk.bold(name)} changed its address settings; compose will recreate it.`);
  } else if (verdict.kind === "blocked") {
    p.log.error(
      `Network ${chalk.bold(name)} has new address settings, so compose must recreate it,\n` +
        `  but these containers are still attached:\n` +
        verdict.blockers.map((b) => `    ${b}`).join("\n") +
        `\n  Nothing has been stopped. Let the runs finish (or stop them with ` +
        `${chalk.cyan("docker stop <name>")}), then run ${chalk.cyan(rerun)} again.`,
    );
    process.exit(1);
  }
}

// ── sidecar address check ───────────────────────────────────────────────────

/** A sidecar whose `sandbox-egress` address differs from its compose pin. */
export interface SidecarAddressMismatch {
  service: string;
  want: string;
  /** The container's actual address; empty when it isn't on the network at all. */
  got: string;
}

/**
 * Compare each pinned sidecar's compose `ipv4_address` with the address its
 * container actually holds. Only services with a pin in `desired` are checked;
 * one missing from `actual` (not running, or not on the network) is a mismatch,
 * since sandboxes dial these IPs directly and nothing else answers there.
 */
export function sidecarAddressMismatches(
  desired: Record<string, string>,
  actual: Record<string, string>,
): SidecarAddressMismatch[] {
  return Object.entries(desired)
    .filter(([service, want]) => (actual[service] ?? "") !== want)
    .map(([service, want]) => ({ service, want, got: actual[service] ?? "" }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

/**
 * After `up`: fail the command when an egress sidecar isn't on its static
 * `sandbox-egress` address. Sandboxes are started with `--dns <coredns IP>` and
 * reach nginx by that IP, so a drifted sidecar makes every model call hang
 * until it times out while `/health` stays green (v0.41.0 shipped exactly
 * that for two days). Best-effort like {@link guardSandboxNetwork}: if docker
 * can't be queried, it proceeds.
 */
async function verifySidecarAddresses(
  home: string,
  rerun = "lastlight server update --no-build",
  /** The sidecars to check. A single-service start passes just that one, so a
   *  sidecar that is merely stopped doesn't fail an unrelated start. */
  services: readonly string[] = SIDECARS,
): Promise<void> {
  const c = compose();
  const raw = await captureSoft(c.cmd, composeArgv(home, sidecarConfigArgv(services), c.pre), home);
  if (!raw) {
    // Legacy docker-compose v1 has no `config --format json`; say so rather
    // than let the deploy look checked.
    p.log.warn("Couldn't read the compose config, so the egress sidecar addresses were not checked.");
    return;
  }
  let net: string;
  const desired: Record<string, string> = {};
  try {
    const cfg = JSON.parse(raw) as {
      networks?: Record<string, { name?: string }>;
      services?: Record<string, { networks?: Record<string, { ipv4_address?: string } | null> }>;
    };
    const name = cfg.networks?.["sandbox-egress"]?.name;
    if (!name) return;
    net = name;
    for (const svc of services) {
      const pin = cfg.services?.[svc]?.networks?.["sandbox-egress"]?.ipv4_address;
      if (pin) desired[svc] = pin;
    }
  } catch {
    return;
  }
  if (Object.keys(desired).length === 0) return;

  const actual: Record<string, string> = {};
  for (const svc of Object.keys(desired)) {
    const id = await captureSoft(c.cmd, composeArgv(home, ["ps", "-q", svc], c.pre), home);
    if (!id) continue;
    const ip = await captureSoft("docker", [
      "inspect", id.split("\n")[0],
      "--format", `{{with index .NetworkSettings.Networks "${net}"}}{{.IPAddress}}{{end}}`,
    ]);
    if (ip) actual[svc] = ip;
  }

  const bad = sidecarAddressMismatches(desired, actual);
  if (bad.length === 0) return;
  p.log.error(
    `Egress sidecars are not on their static ${chalk.bold(net)} addresses, so sandboxes can't resolve or reach anything:\n` +
      bad.map((m) => `    ${m.service}: want ${m.want}, got ${m.got || "(not attached)"}`).join("\n") +
      `\n  Recreate them with ${chalk.cyan(rerun)}, or\n` +
      `  ${chalk.cyan(`docker compose up -d --no-deps --force-recreate ${bad.map((m) => m.service).join(" ")}`)}`,
  );
  process.exit(1);
}

// ── filesystem helpers ───────────────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * The nearest ANCESTOR of `dir` that is a git work tree, or null.
 *
 * Walks upward from the first ancestor that exists, so it answers correctly for
 * a `home` that has not been created yet — which is the case that matters, since
 * the whole point is to check before cloning into it.
 */
export function enclosingGitRepo(dir: string): string | null {
  let current = path.dirname(path.resolve(dir));
  for (;;) {
    if (isGitRepo(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null; // hit the filesystem root
    current = parent;
  }
}

/** Does this checkout's `origin` point at the lastlight core repo? */
async function isCoreCheckout(dir: string): Promise<boolean> {
  const origin = await captureSoft("git", ["remote", "get-url", "origin"], dir);
  return !!origin && /[:/]nearform\/lastlight(\.git)?$/i.test(origin.trim());
}

/**
 * Refuse to scaffold a working directory INSIDE another git repository.
 *
 * The failure this prevents is not hypothetical: answering the working-directory
 * prompt with a relative path resolves against the current directory, so running
 * `lastlight server setup` from inside a checkout and typing `lastlight` clones
 * the whole core repo to `<checkout>/lastlight`. It is ~50 MB of nested repo
 * that the outer repo will happily stage on the next `git add -A`, and nothing
 * about the successful setup output suggests anything is wrong.
 *
 * Nesting inside the CORE repo is always a mistake, so that is a hard refusal.
 * Any other enclosing repo gets a confirm defaulting to NO rather than a
 * refusal, because a legitimate case exists — a home directory that is itself a
 * dotfiles repo makes `~/lastlight` "nested" while being exactly right.
 */
export async function guardNestedHome(home: string, nonInteractive = false): Promise<void> {
  // Adopting an existing checkout AT `home` is the supported path, not nesting.
  if (isGitRepo(home)) return;
  const outer = enclosingGitRepo(home);
  if (!outer) return;

  if (await isCoreCheckout(outer)) {
    p.log.error(
      `${chalk.bold(home)} is inside the lastlight checkout at ${chalk.bold(outer)}.\n` +
        "  Setup would clone the core repo into itself, and the outer repo would\n" +
        "  stage all of it on the next `git add -A`.\n" +
        `  Pick a path outside it — ${chalk.cyan("--home ~/lastlight")}, say. ` +
        "Relative paths resolve against the current directory.",
    );
    process.exit(1);
  }

  p.log.warn(
    `${chalk.bold(home)} is inside the git repository at ${chalk.bold(outer)}.\n` +
      "  The clone would live inside that repo and get committed by a stray `git add -A`.",
  );
  if (nonInteractive) {
    p.log.error("Refusing to nest a checkout in --yes mode. Pass --home <dir> with a path outside it.");
    process.exit(1);
  }
  const go = await p.confirm({ message: "Continue anyway?", initialValue: false });
  if (go !== true) {
    p.cancel("Cancelled — nothing was written.");
    process.exit(1);
  }
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
  const [coreCur, coreLatest, ovCur, ovRemote] = await Promise.all([
    captureSoft("git", ["rev-parse", "HEAD"], home),
    pin
      ? resolvePinnedSha(home, pin)
      : captureSoft("git", ["ls-remote", "origin", "HEAD"], home).then((o) => (o ? parseLsRemoteSha(o) : null)),
    isGitRepo(instance) ? captureSoft("git", ["rev-parse", "HEAD"], instance) : Promise.resolve(null),
    isGitRepo(instance) ? captureSoft("git", ["ls-remote", "origin", "HEAD"], instance) : Promise.resolve(null),
  ]);
  return {
    core: compareDrift(coreCur, coreLatest),
    overlay: compareDrift(ovCur, ovRemote ? parseLsRemoteSha(ovRemote) : null),
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
  /** `--no-prune` → keep every old image version instead of reclaiming disk. */
  prune?: boolean;
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
      // Say it: the answer is resolved against the current directory, and a
      // relative one typed from inside a checkout is how a repo ends up cloned
      // into another repo (see guardNestedHome).
      placeholder: `absolute path — relative resolves against ${process.cwd()}`,
      initialValue: home,
    });
    if (p.isCancel(answer)) { p.cancel("Cancelled."); process.exit(1); }
    home = answer;
  }
  home = path.resolve(home);
  await guardNestedHome(home, opts.yes);

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
  const home = requireHome(opts);
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
  await guardSandboxNetwork(home, "lastlight server start");
  await composeRun(home, service ? `Start ${service}` : "Start stack", startArgv(service));
  if (!service) {
    await verifySidecarAddresses(home, "lastlight server update --no-build", [
      ...SIDECARS,
      ...(await runningOptionalSidecars(home)),
    ]);
  } else if (SIDECARS.includes(service) || OPTIONAL_PINNED_SIDECARS.includes(service)) {
    await verifySidecarAddresses(home, "lastlight server update --no-build", [service]);
  }
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
async function pullImages(
  home: string,
  tag: string,
  filter?: (img: (typeof PUBLISHED_IMAGES)[number]) => boolean,
): Promise<void> {
  for (const img of PUBLISHED_IMAGES) {
    if (filter && !filter(img)) continue;
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

/**
 * Reclaim disk after an image change: for each published repo, delete the
 * superseded GHCR version tags beyond the `keep` newest (plus `keepTag`, the
 * tag just deployed), then prune the images left dangling by the pulls. Every
 * step is best-effort — a pruning hiccup must never fail a deploy that already
 * converged. Safe because it runs AFTER `up`: removing a version tag that shares
 * an image id with a live local tag (`lastlight-agent`, …) merely untags it,
 * and docker refuses to delete an image a running container uses (we swallow
 * that). Without this, every `server update` leaves ~12 GB of old images behind
 * (four repos × ~3 GB) until the host fills up.
 */
async function pruneOldImages(home: string, keepTag: string, keep = KEEP_IMAGE_VERSIONS): Promise<void> {
  p.log.step(chalk.bold("Prune superseded images"));
  let removed = 0;
  for (const img of PUBLISHED_IMAGES) {
    const repo = `${IMAGE_REGISTRY}/${img.repo}`;
    const out = await captureSoft("docker", ["images", repo, "--format", "{{.Tag}}"], home);
    if (!out) continue;
    const tags = out.split("\n").map((t) => t.trim()).filter(Boolean);
    for (const tag of tagsToPrune(tags, keepTag, keep)) {
      // In use / already gone → best-effort, keep going.
      if (await captureSoft("docker", ["rmi", `${repo}:${tag}`], home) !== null) removed++;
    }
  }
  // Sweep images the repeated `:latest` re-pulls left untagged.
  await captureSoft("docker", ["image", "prune", "-f"], home);
  console.log(chalk.dim(`  removed ${removed} superseded tag(s)`));
}

/**
 * `lastlight server build` — build the docker images FROM SOURCE without starting
 * anything. The local-build escape hatch: `server update` pulls prebuilt images
 * by default (use `server update --local` to build + up). Does not pull git or
 * bring the stack up.
 */
export async function serverBuild(opts: ServerOpts): Promise<void> {
  const home = requireHome(opts);
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
  const home = requireHome(opts);
  const pullCore = opts.core !== false;
  const pullOverlay = opts.overlay !== false;
  const doBuild = opts.build !== false;
  const instance = path.join(home, "instance");

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

  ensureOverrideSymlink(home);

  // Before any image work or `up`: refuse while the sandbox network must be
  // recreated but sandboxes are still attached (compose would stop the
  // services, then fail to remove the network). Checked again right before
  // each `up`, because a run can spawn a sandbox during the pull or build.
  await guardSandboxNetwork(home);

  // Images: pull prebuilt from GHCR by default (seconds); `--local` builds from
  // source (minutes). `--no-build` skips both — just recreate + restart.
  //
  // On the pull path we split the fetch so the web app's downtime is only its
  // OWN recreate, not the whole ~9 GB fetch: pull the AGENT image, recreate,
  // then pull the sandbox images with the agent already back online. The
  // sandbox images are build-only compose profiles used by `docker run` at
  // workflow time — `up -d` never starts them — so deferring their pull is safe
  // and cuts perceived downtime on hosts where the pull otherwise saturates the
  // box for its full duration.
  const isAgent = (img: (typeof PUBLISHED_IMAGES)[number]) => img.localTag === "lastlight-agent";
  if (doBuild && !opts.local) {
    const tag = resolveImageTag(instance);
    await pullImages(home, tag, isAgent); // agent only — the serving container
    await guardSandboxNetwork(home);
    await composeRun(home, "Recreate services", upArgv());
    await recreateAndVerifySidecars(home);
    await pullImages(home, tag, (img) => !isAgent(img)); // sandbox images, agent already up
  } else {
    if (doBuild && opts.local) {
      await buildImages(home);
    }
    await guardSandboxNetwork(home);
    await composeRun(home, "Recreate services", upArgv());
    await recreateAndVerifySidecars(home);
  }

  // Reclaim disk from the versions this update superseded. After `up`, so the
  // live stack's images are safe. Skipped by `--no-prune`, and when `--no-build`
  // left the images untouched (nothing new to supersede).
  if (doBuild && opts.prune !== false) {
    await pruneOldImages(home, resolveImageTag(instance), readKeepImageVersions(instance) ?? KEEP_IMAGE_VERSIONS);
  }

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
  const home = requireHome(opts);
  await composeRun(home, "Compose state", ["ps"]);

  const drift = await localDrift(home);
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
  // Built-in workflows/skills/agent-context moved to apps/server/ (F5 split).
  const overrides = enumerateOverlayAssets({ coreRoot: serverDir(home), overlayRoot: path.join(home, "instance") });
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
