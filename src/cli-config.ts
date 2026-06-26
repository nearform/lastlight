/**
 * Persisted CLI config — `~/.lastlight/config.json`.
 *
 * Stores the instance URL and bearer token that `lastlight login` obtains, so
 * every subsequent command runs against the same remote instance without
 * re-authenticating. The file holds a credential, so it is written mode 0600
 * inside a 0700 directory.
 *
 * Env vars (`LASTLIGHT_URL` / `LASTLIGHT_TOKEN`) always take precedence over
 * the file — see `resolveTarget()` — so CI/scripts can override without
 * touching disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  /** Base URL of the Last Light instance, e.g. https://ll.example.com */
  url: string;
  /** Bearer token minted by the instance (7-day TTL). */
  token: string;
  /** ISO timestamp the token was saved — informational. */
  savedAt: string;
  /**
   * Working directory for the host-local `lastlight server` lifecycle commands
   * (start/stop/restart/update). A full git checkout of the lastlight repo plus
   * the `instance/` overlay + the `docker-compose.override.yml` symlink — the
   * docker build context. Written by `lastlight server setup`. Distinct from
   * `url`/`token`, which target a *remote* instance over HTTP.
   */
  serverHome?: string;
}

export const DEFAULT_URL = "http://localhost:8644";

/** Default working directory for `lastlight server` when nothing else is set. */
export function defaultServerHome(): string {
  return path.join(os.homedir(), "lastlight");
}

/** `~/.lastlight` — the CLI config directory. */
export function configDir(): string {
  return path.join(os.homedir(), ".lastlight");
}

/** `~/.lastlight/config.json` — the saved-credentials file. */
export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/**
 * Read the raw config object (any subset of fields), or null if none /
 * unreadable. Unlike `loadConfig`, this does not require `url`/`token` — it is
 * used when the only persisted field might be `serverHome`.
 */
function readRaw(): Partial<CliConfig> | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<CliConfig>;
  } catch {
    return null;
  }
}

/** Load the saved credentials, or null if none / unreadable. */
export function loadConfig(): CliConfig | null {
  const parsed = readRaw();
  if (parsed && typeof parsed.url === "string" && typeof parsed.token === "string") {
    return {
      url: parsed.url,
      token: parsed.token,
      savedAt: parsed.savedAt ?? "",
      serverHome: typeof parsed.serverHome === "string" ? parsed.serverHome : undefined,
    };
  }
  return null;
}

/** Merge `patch` into the on-disk config and persist it (mode 0600 / dir 0700). */
function writeMerged(patch: Partial<CliConfig>): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const merged = { ...(readRaw() ?? {}), ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // mkdir/writeFile honour `mode` only on creation; enforce on existing files too.
  try {
    fs.chmodSync(configPath(), 0o600);
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort — non-POSIX filesystems may reject chmod */
  }
}

/**
 * Persist `{ url, token }` (stamping `savedAt`), preserving any other fields
 * (e.g. `serverHome`) already in the file.
 */
export function saveConfig(cfg: { url: string; token: string }): CliConfig {
  writeMerged({ url: cfg.url, token: cfg.token, savedAt: new Date().toISOString() });
  return loadConfig()!;
}

/** Persist the `serverHome` working directory, preserving credentials. */
export function saveServerHome(home: string): void {
  writeMerged({ serverHome: home });
}

/**
 * Resolve the working directory for `lastlight server` lifecycle commands.
 * Precedence: explicit override (`--home`) → `LASTLIGHT_HOME` env → saved
 * `serverHome` → built-in default (`~/lastlight`).
 */
export function resolveServerHome(override?: string): string {
  return (
    override ||
    process.env.LASTLIGHT_HOME ||
    readRaw()?.serverHome ||
    defaultServerHome()
  );
}

/** Remove the saved config (logout). No-op if it doesn't exist. */
export function clearConfig(): void {
  try {
    fs.rmSync(configPath());
  } catch {
    /* already gone */
  }
}

/**
 * Resolve the effective instance URL + token the CLI should use for a command.
 * Precedence: explicit override (`--url`/`--token`) → env → saved file →
 * built-in default URL (with no token).
 */
export function resolveTarget(override?: { url?: string; token?: string }): {
  url: string;
  token: string;
} {
  const saved = loadConfig();
  const url =
    override?.url ||
    process.env.LASTLIGHT_URL ||
    saved?.url ||
    DEFAULT_URL;
  const token =
    override?.token ||
    process.env.LASTLIGHT_TOKEN ||
    saved?.token ||
    "";
  return { url: url.replace(/\/+$/, ""), token };
}
