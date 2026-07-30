import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Harness-owned store for agent-written `.lastlight/` artifacts produced inside
 * a sandbox run. The k8s sandbox backend has no shared filesystem with the
 * harness, so it hands artifacts back through this seam instead: the sandbox
 * pod streams bytes in (`put`) via the harness's proxy API, and review/build
 * code streams them back out (`get`/`list`) exactly like it already does for
 * the docker backend's local checkout.
 */
export interface ArtifactBackend {
  /** Stream one artifact's bytes in (proxy mode). `relPath` is run-relative,
   *  already traversal-validated by the store. */
  put(runKey: string, relPath: string, body: Readable): Promise<void>;
  /** Stream one artifact's bytes out (proxy mode / harness self-read). */
  get(runKey: string, relPath: string): Promise<Readable>;
  /** List a run's artifact rel-paths. */
  list(runKey: string): Promise<string[]>;
  /** GC a run's whole namespace. */
  remove(runKey: string): Promise<void>;
  /** OPTIONAL broker capability — return a direct URL the POD uses to bypass the
   *  harness (e.g. S3 pre-signed), or null/omit for proxy mode. Not implemented
   *  by the local backend. */
  presign?(
    runKey: string,
    relPath: string,
    op: "put" | "get",
  ): Promise<{ url: string; headers?: Record<string, string> } | null>;
}

/** True when `child` resolves to a path inside (or equal to) `parent`. */
function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * Resolve `relPath` under `root`, refusing anything that would escape it. The
 * artifact store above this backend already validates traversal on `relPath`
 * before it reaches us — this is defense-in-depth, not the primary guard.
 */
function resolveWithin(root: string, relPath: string): string {
  const abs = resolve(join(root, relPath));
  if (!isInside(root, abs)) {
    throw new Error(`artifact path escapes run root: ${relPath}`);
  }
  return abs;
}

/** Recursively collect file paths under `dir`, relative to `base`. */
function listFilesRecursive(base: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(base, abs));
    } else if (entry.isFile()) {
      out.push(relative(base, abs));
    }
  }
  return out;
}

/**
 * Local-durable backend. `rootFor(runKey)` maps a run to a host directory; the
 * store passes a resolver so the root is the SAME dir post-review.ts reads
 * (`$STATE_DIR/sandboxes/<taskId>/<repo>`). Proxy-only: no `presign`.
 */
export class LocalArtifactBackend implements ArtifactBackend {
  constructor(private readonly rootFor: (runKey: string) => string) {}

  async put(runKey: string, relPath: string, body: Readable): Promise<void> {
    const dest = resolveWithin(this.rootFor(runKey), relPath);
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(body, createWriteStream(dest));
  }

  async get(runKey: string, relPath: string): Promise<Readable> {
    const src = resolveWithin(this.rootFor(runKey), relPath);
    return createReadStream(src);
  }

  async list(runKey: string): Promise<string[]> {
    const root = resolve(this.rootFor(runKey));
    if (!existsSync(root)) return [];
    return listFilesRecursive(root, root).sort();
  }

  async remove(runKey: string): Promise<void> {
    const root = resolve(this.rootFor(runKey));
    const artifactDir = resolveWithin(root, ".lastlight");
    rmSync(artifactDir, { recursive: true, force: true });
  }
}
