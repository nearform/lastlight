import { createReadStream, createWriteStream, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { getRuntimeConfig } from "../config/config.js";
import type { ArtifactBackend } from "./artifact-backend.js";
import { LocalArtifactBackend } from "./artifact-backend.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const LASTLIGHT_PREFIX = `.lastlight${sep}`;

/** Thrown by `unpack` when the uploaded bundle exceeds `maxBundleBytes`
 *  (compressed) or `maxDecompressedBytes` (a zip-bomb guard — a small
 *  compressed upload expanding far past what a `.lastlight/` bundle needs).
 *  Route handlers should map this to HTTP 413. */
export class ArtifactTooLarge extends Error {
  constructor(maxBytes: number, kind: "compressed" | "decompressed" = "compressed") {
    super(`artifact bundle exceeds the ${maxBytes}-byte ${kind} cap`);
    this.name = "ArtifactTooLarge";
  }
}

/**
 * Harness-owned authority over a run's `.lastlight/` artifacts. Sits above the
 * `ArtifactBackend` (Task 1): it mints the per-run bearer token a sandbox pod
 * presents, enforces the upload size cap, and guards every extracted tar entry
 * before handing bytes to the backend.
 */
export interface ArtifactStore {
  /** Register a run's upload target; returns the per-run artifact token the pod
   *  presents. `runKey` keys the backend namespace. */
  register(runKey: string): string;
  /** Resolve a bearer token to its runKey (or undefined → the route 401s). */
  resolve(token: string): string | undefined;
  /** Stream a gzipped-tar upload body into the run's namespace via the backend,
   *  enforcing the compressed + decompressed size caps and per-entry traversal
   *  guards. Throws (`ArtifactTooLarge` or a plain `Error`) on cap/traversal. */
  unpack(token: string, body: Readable): Promise<void>;
  /** Drop a run's token (called on dispose) — the bytes are GC'd separately. */
  evict(token: string): void;
  /** GC a run's artifacts (backend.remove) — called on run completion. */
  gc(runKey: string): Promise<void>;
}

/**
 * In-memory token→runKey registry. Mirrors `SkillBundleRegistry`
 * (`k8s/skill-bundle.ts`): `randomUUID` token, lazy TTL (an expired entry is
 * only dropped the next time it's looked up), explicit `evict` as the primary
 * reclaim path.
 */
class TokenRegistry {
  private readonly entries = new Map<string, { runKey: string; expires: number }>();

  constructor(private readonly ttlMs: number) {}

  register(runKey: string): string {
    const token = randomUUID();
    this.entries.set(token, { runKey, expires: Date.now() + this.ttlMs });
    return token;
  }

  resolve(token: string): string | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.runKey;
  }

  evict(token: string): void {
    this.entries.delete(token);
  }
}

/** A `Transform` that counts bytes passing through and aborts (errors) the
 *  instant the running total crosses `maxBytes` — used both before gunzip
 *  (compressed cap) and after it (decompressed cap, the zip-bomb guard). */
function capTransform(maxBytes: number, kind: "compressed" | "decompressed"): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new ArtifactTooLarge(maxBytes, kind));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Stream `body` (gzipped tar) into `destDir` via system `tar` (no npm dep —
 * matches `skill-bundle.ts`'s style). Decompress the upload to a temp tar file
 * FIRST — `body` → compressed-byte cap → gunzip → decompressed-byte cap → temp
 * file — then extract it with a single awaited `tar -xf <file>` spawn. Both
 * caps abort the decompress pipeline (throwing `ArtifactTooLarge`) the instant
 * they're crossed, before the excess bytes ever reach disk.
 *
 * Why the temp file and not `pipeline(body, …, tar.stdin)`: under process/CPU
 * contention (a busy CI runner's parallel test workers) the `tar` child is slow
 * to exec and closes its stdin before the pipeline finishes writing, so the
 * pipeline rejects with `ERR_STREAM_PREMATURE_CLOSE` — an intermittent
 * extraction failure that only surfaced in CI. A file writable can't be
 * premature-closed by the child, and one `tar -xf <file>` spawn awaited via
 * `execFile` removes the coordination race entirely.
 *
 * Traversal defense: both GNU tar and bsdtar refuse to extract entries whose
 * name contains `..` (or an absolute path), exiting non-zero — that's the
 * first guard, before the store's own `.lastlight/`-prefix check ever runs.
 */
async function extractTarStream(
  body: Readable,
  destDir: string,
  maxBundleBytes: number,
  maxDecompressedBytes: number,
): Promise<void> {
  const tarDir = mkdtempSync(join(tmpdir(), "ll-artifact-tar-"));
  const tarFile = join(tarDir, "bundle.tar");
  try {
    await pipeline(
      body,
      capTransform(maxBundleBytes, "compressed"),
      createGunzip(),
      capTransform(maxDecompressedBytes, "decompressed"),
      createWriteStream(tarFile),
    );
    await new Promise<void>((resolveExit, rejectExit) => {
      execFile("tar", ["-xf", tarFile, "-C", destDir], (err, _stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || err.message;
          rejectExit(new Error(`artifact bundle extraction failed: ${detail}`));
          return;
        }
        resolveExit();
      });
    });
  } finally {
    rmSync(tarDir, { recursive: true, force: true });
  }
}

/** Recursively collect file paths under `dir`, relative to `base`. */
function listExtractedFiles(base: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listExtractedFiles(base, abs));
    } else if (entry.isFile()) {
      out.push(relative(base, abs));
    }
  }
  return out;
}

/** Reject any extracted entry that doesn't land under `.lastlight/` — the only
 *  tree a bundle is allowed to contribute to a run's artifact namespace. */
function assertUnderLastlight(relPath: string): void {
  if (!relPath.startsWith(LASTLIGHT_PREFIX)) {
    throw new Error(`artifact bundle entry outside .lastlight/: ${relPath}`);
  }
}

/**
 * Unpack one upload: streamed + double-capped extract (compressed AND
 * decompressed byte caps — the second is the zip-bomb guard) to a scratch
 * dir → per-entry `.lastlight/`-prefix guard → `backend.put` each file →
 * scratch dir removed. Validates every entry before `put`-ing any of them, so
 * a bundle with one bad entry lands nothing.
 */
async function unpackBundle(
  backend: ArtifactBackend,
  runKey: string,
  body: Readable,
  maxBundleBytes: number,
  maxDecompressedBytes: number,
): Promise<void> {
  const extractDir = mkdtempSync(join(tmpdir(), "ll-artifact-"));
  try {
    await extractTarStream(body, extractDir, maxBundleBytes, maxDecompressedBytes);
    const relPaths = listExtractedFiles(extractDir, extractDir);
    for (const relPath of relPaths) assertUnderLastlight(relPath);
    for (const relPath of relPaths) {
      await backend.put(runKey, relPath, createReadStream(join(extractDir, relPath)));
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function createArtifactStore(
  backend: ArtifactBackend,
  opts?: { maxBundleBytes?: number; maxDecompressedBytes?: number; ttlMs?: number },
): ArtifactStore {
  const maxBundleBytes = opts?.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const maxDecompressedBytes = opts?.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  const registry = new TokenRegistry(opts?.ttlMs ?? DEFAULT_TTL_MS);

  return {
    register(runKey) {
      return registry.register(runKey);
    },
    resolve(token) {
      return registry.resolve(token);
    },
    evict(token) {
      registry.evict(token);
    },
    async unpack(token, body) {
      const runKey = registry.resolve(token);
      if (!runKey) throw new Error(`unknown artifact token`);
      await unpackBundle(backend, runKey, body, maxBundleBytes, maxDecompressedBytes);
    },
    async gc(runKey) {
      await backend.remove(runKey);
    },
  };
}

/**
 * Process-wide singleton — mirrors `skillBundleRegistry`
 * (`k8s/skill-bundle.ts`): the k8s adapter's default `register`s a run's
 * token here, and the `/internal/sandbox-artifacts` route (mounted on the
 * same instance) `resolve`s it here, so both sides of a real run agree on
 * the same in-memory token table. Wiring either side to a fresh
 * `createArtifactStore(...)` instead of this export is the bug Task 4 left
 * behind — every upload would 401 (the adapter's token lives in a registry
 * the route never reads). Inject an explicit `ArtifactStore` only in tests.
 *
 * `rootFor` mirrors `post-review.ts`'s `resolveHostRepoDir`: the run's host
 * dir is `<sandboxDir>/<taskId>` — the workDir itself, NOT a repo subdir,
 * because the in-pod upload script tars `.lastlight/` from its cwd, so the
 * bundle always unpacks to `<workDir>/.lastlight/`, which
 * `resolveHostRepoDir`'s existing `workDir/.lastlight` fallback already
 * reads. `sandboxDir` is resolved from `getRuntimeConfig()` LAZILY, per call
 * (not memoized at module-import time), because config loads after this
 * module is first imported.
 */
export const artifactStore: ArtifactStore = createArtifactStore(
  new LocalArtifactBackend((taskId) => {
    const sandboxBase =
      getRuntimeConfig()?.sandboxDir ?? join(process.env.STATE_DIR || "data", "sandboxes");
    return join(sandboxBase, taskId);
  }),
);
