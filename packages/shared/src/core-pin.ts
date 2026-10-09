/**
 * Read the core-version pin an overlay declares.
 *
 * The overlay's `config.yaml` may carry a `deploy.version` — a git tag/ref
 * (e.g. `v0.10.6`) that pins which core version this instance runs. When set,
 * `lastlight server update|setup` checks the core repo out at that ref instead
 * of tracking `main`, and the dashboard drift banner compares the running image
 * to the pinned tag rather than to `main` HEAD.
 *
 * This reader is deliberately standalone (a raw YAML read, not the full
 * default/overlay/env config machinery) because its two callers run in very
 * different contexts against a raw overlay checkout path:
 *   - the host-local `lastlight server` CLI (no harness / runtime config) —
 *     against `<serverHome>/instance`;
 *   - the in-container harness banner (`src/admin/version.ts`) — against the
 *     mounted `LASTLIGHT_OVERLAY_DIR` (`/app/instance`).
 *
 * `LASTLIGHT_CORE_VERSION` (env) overrides the file so CI can pin without
 * editing config.yaml. Unset, or the sentinels `main` / `latest`, mean "track
 * main" and return `null`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Normalize a raw pin value: trim, treat empty / `main` / `latest` as null. */
function normalizePin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "main" || lower === "latest") return null;
  return v;
}

/**
 * Pick the *commit* SHA for tag `pin` from `git ls-remote … 'refs/tags/<pin>*'`
 * output. Annotated tags emit two rows — the tag object (`refs/tags/<pin>`) and
 * the peeled commit (`refs/tags/<pin>^{}`); only the glob pattern surfaces the
 * peeled row (an exact `refs/tags/<pin>` hides it). We want the commit, since
 * that's what `git checkout <pin>` lands HEAD on and what an image built at the
 * tag is stamped with. Preference: peeled commit → exact tag ref (lightweight
 * tag / branch) → first row. Null when nothing looks like a SHA.
 */
export function pickTagCommit(lsRemoteOut: string | null, pin: string): string | null {
  if (!lsRemoteOut) return null;
  const rows = lsRemoteOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, ref] = l.split(/\s+/);
      return { sha: sha ?? "", ref: ref ?? "" };
    });
  const peeled = rows.find((r) => r.ref === `refs/tags/${pin}^{}`);
  const exact = rows.find((r) => r.ref === `refs/tags/${pin}`);
  const chosen = (peeled ?? exact ?? rows[0])?.sha ?? "";
  return /^[0-9a-f]{7,40}$/i.test(chosen) ? chosen : null;
}

/**
 * The core-version pin for the overlay at `overlayDir`, or `null` to track main.
 * `LASTLIGHT_CORE_VERSION` wins over the file. Missing / unreadable / malformed
 * config.yaml is treated as unpinned (never throws).
 */
export function readCorePin(overlayDir: string): string | null {
  const fromEnv = normalizePin(process.env.LASTLIGHT_CORE_VERSION);
  if (fromEnv) return fromEnv;
  return normalizePin(readDeployBlock(overlayDir)?.version);
}

/**
 * How many GHCR image versions `lastlight server update` keeps per repo when it
 * prunes (`deploy.keepImageVersions` in the overlay's config.yaml), or `null`
 * for the CLI's default. A positive integer; anything else is ignored. A host
 * with little disk to spare sets `1` — each version is ~10 GB across the four
 * images, so the default rollback target is a luxury there.
 */
export function readKeepImageVersions(overlayDir: string): number | null {
  const raw = readDeployBlock(overlayDir)?.keepImageVersions;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

/** The overlay's `deploy:` block, or null. Missing / unreadable / malformed
 *  config.yaml reads as no block (never throws). */
function readDeployBlock(overlayDir: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(readFileSync(join(overlayDir, "config.yaml"), "utf8"));
    if (parsed && typeof parsed === "object") {
      const deploy = (parsed as Record<string, unknown>).deploy;
      if (deploy && typeof deploy === "object") return deploy as Record<string, unknown>;
    }
  } catch {
    /* no overlay / no config.yaml / parse error → track main */
  }
  return null;
}
