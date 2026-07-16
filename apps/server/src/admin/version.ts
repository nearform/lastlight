/**
 * Server version + drift detection for the dashboard banner.
 *
 * Computed agent-side (inside the container) from what the harness can reach:
 *  - core.current  — baked at build time as LASTLIGHT_GIT_SHA (Dockerfile ARG).
 *  - core.latest   — `git ls-remote` of the public core repo (agent has GitHub
 *                    egress). Best-effort; null on failure.
 *  - overlay.current — `git rev-parse HEAD` in the read-only-mounted overlay
 *                    checkout (its .git is readable).
 *  - overlay.latest  — best-effort `git ls-remote`; often null in-container
 *                    (the private overlay's deploy key isn't present), shown as
 *                    "unknown" rather than implying drift.
 *
 * `behind` is only true when BOTH SHAs are known and differ — so an unreachable
 * remote never produces a false "update available". The authoritative drift
 * view is `lastlight server status` on the host (full git access); this is the
 * in-dashboard nudge.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCorePin, pickTagCommit } from "@lastlight/shared/core-pin";

const exec = promisify(execFile);

const CORE_REMOTE = "https://github.com/nearform/lastlight";
/** Overlay checkout path inside the container (LASTLIGHT_OVERLAY_DIR mount). */
function overlayDir(): string {
  return process.env.LASTLIGHT_OVERLAY_DIR || "/app/instance";
}

export interface RepoVersion {
  current: string | null;
  latest: string | null;
  behind: boolean;
}

export interface ServerVersion {
  core: RepoVersion;
  overlay: RepoVersion;
  /**
   * Core-version pin the overlay declares (`deploy.version`), if any. When set,
   * `core.latest` is the pinned tag's commit (not `main` HEAD), so `core.behind`
   * means "the pin was bumped, redeploy needed" — the dashboard shows a "pinned"
   * label instead of a main-drift nudge.
   */
  pinned: string | null;
  /** package.json version of the running harness. */
  packageVersion: string | null;
  /** Build date baked into the image (LASTLIGHT_BUILD_DATE), if any. */
  buildDate: string | null;
}

/** Capture trimmed stdout with a short timeout; null instead of throwing. */
async function softCapture(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** First column of `git ls-remote … <ref>` — the SHA, or null. */
function lsRemoteSha(stdout: string | null): string | null {
  if (!stdout) return null;
  const first = stdout.split(/\s+/)[0];
  return /^[0-9a-f]{7,40}$/i.test(first) ? first : null;
}

function compare(current: string | null, latest: string | null): RepoVersion {
  return { current, latest, behind: !!current && !!latest && current !== latest };
}

function readPackageVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the core "latest" SHA to compare the running image against. Unpinned:
 * `main` HEAD (today's behaviour). Pinned: the pinned tag's commit — preferring
 * the peeled `…^{}` line so an annotated tag compares against its commit, i.e.
 * the SHA baked into an image built at that tag.
 */
async function coreLatestSha(pin: string | null): Promise<string | null> {
  if (!pin) return lsRemoteSha(await softCapture("git", ["ls-remote", CORE_REMOTE, "HEAD"]));
  const tags = await softCapture("git", ["ls-remote", CORE_REMOTE, `refs/tags/${pin}*`]);
  const fromTag = pickTagCommit(tags, pin);
  if (fromTag) return fromTag;
  const ref = await softCapture("git", ["ls-remote", CORE_REMOTE, pin]);
  return lsRemoteSha(ref);
}

/** Compute core + overlay version drift for `GET /admin/api/server/info`. */
export async function getServerVersion(): Promise<ServerVersion> {
  const ov = overlayDir();
  const pin = readCorePin(ov);
  const [coreLatest, overlayCurrent, overlayLatest] = await Promise.all([
    coreLatestSha(pin),
    softCapture("git", ["-C", ov, "rev-parse", "HEAD"]),
    softCapture("git", ["-C", ov, "ls-remote", "origin", "HEAD"]),
  ]);
  return {
    core: compare(process.env.LASTLIGHT_GIT_SHA || null, coreLatest),
    overlay: compare(overlayCurrent, lsRemoteSha(overlayLatest)),
    pinned: pin,
    packageVersion: readPackageVersion(),
    buildDate: process.env.LASTLIGHT_BUILD_DATE || null,
  };
}
