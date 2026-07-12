/**
 * Image loader for `--sandbox-image`.
 *
 * Three resolution modes:
 *   - `"gondolin-builtin"` → `{ kind: "builtin" }` (let gondolin pick).
 *   - absolute path        → `{ kind: "local", imagePath }`.
 *   - `"default"`          → resolves the bundled DEFAULT_IMAGE_MANIFEST,
 *                            verifies the per-arch tarball against the
 *                            baked sha256, extracts into
 *                            `~/.cache/agentic-pi/images/<sha>/`,
 *                            returns that path. Atomic: extract to
 *                            `<sha>.tmp/` then rename.
 *
 * The cache layout is `<cacheRoot>/images/<sha256>/` — one directory
 * per sha, so different image versions coexist and verification on
 * disk is just `existsSync(dir)`. No eviction (Phase B4 open question).
 *
 * Network errors throw a typed `ImageLoaderError` with `hint` so the
 * runner can surface `--sandbox-image gondolin-builtin` as the escape
 * hatch without parsing the message.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir, homedir, arch as osArch } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  DEFAULT_IMAGE_MANIFEST,
  isManifestPublished,
  type ImageArchive,
  type ImageManifest,
} from "./manifest.js";

export type LoaderArch = "aarch64" | "x86_64";

export type ImageResolution =
  | { kind: "builtin" }
  | {
      kind: "local";
      imagePath: string;
      descriptor: { name: string; source: "local-path" };
    }
  | {
      kind: "downloaded";
      imagePath: string;
      descriptor: {
        name: string;
        version: string;
        source: "cached" | "downloaded";
        downloadMs?: number;
      };
    };

export class ImageLoaderError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "ImageLoaderError";
    this.hint = hint;
  }
}

export interface EnsureImageOptions {
  /** Override the manifest (used by tests). Defaults to DEFAULT_IMAGE_MANIFEST. */
  manifest?: ImageManifest;
  /** Override the cache root. Defaults to `<XDG_CACHE_HOME or ~/.cache>/agentic-pi`. */
  cacheRoot?: string;
  /** Override the detected host arch. */
  arch?: LoaderArch;
  /** Fetch function (DI for tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

export function detectArch(): LoaderArch {
  const a = osArch();
  if (a === "arm64") return "aarch64";
  if (a === "x64") return "x86_64";
  throw new ImageLoaderError(
    `unsupported host arch '${a}' for default image`,
    "use --sandbox-image gondolin-builtin or build a local image for your arch",
  );
}

export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".cache");
  return path.join(base, "agentic-pi");
}

/**
 * Resolve a `--sandbox-image` selector to a concrete path or builtin
 * directive. Pure async; no side effects beyond the cache directory.
 */
export async function ensureImage(
  name: string,
  options: EnsureImageOptions = {},
): Promise<ImageResolution> {
  if (name === "gondolin-builtin") {
    return { kind: "builtin" };
  }
  if (path.isAbsolute(name)) {
    return {
      kind: "local",
      imagePath: name,
      descriptor: { name: path.basename(name), source: "local-path" },
    };
  }
  if (name !== "default") {
    // Anything else (relative path, unknown name) is a usage error.
    throw new ImageLoaderError(
      `unrecognized --sandbox-image value '${name}'`,
      "expected 'default', 'gondolin-builtin', or an absolute path",
    );
  }

  const manifest = options.manifest ?? DEFAULT_IMAGE_MANIFEST;
  if (!isManifestPublished(manifest)) {
    throw new ImageLoaderError(
      `default image manifest not yet populated (this build of agentic-pi predates the first image release)`,
      "use --sandbox-image gondolin-builtin until the npm package is rebuilt against a published image",
    );
  }

  const arch = options.arch ?? detectArch();
  const archive = manifest.archives[arch];
  if (!archive?.url || archive.sha256.length !== 64) {
    throw new ImageLoaderError(
      `default image has no entry for arch '${arch}'`,
      "use --sandbox-image gondolin-builtin or build a local image",
    );
  }

  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  const imageDir = path.join(cacheRoot, "images", archive.sha256);

  // Fast path: a complete extraction is on disk.
  if (await isExtractedImage(imageDir)) {
    return {
      kind: "downloaded",
      imagePath: imageDir,
      descriptor: {
        name: manifest.name,
        version: manifest.version,
        source: "cached",
      },
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const t0 = Date.now();
  await downloadAndExtract(archive, imageDir, fetchImpl);
  const downloadMs = Date.now() - t0;

  return {
    kind: "downloaded",
    imagePath: imageDir,
    descriptor: {
      name: manifest.name,
      version: manifest.version,
      source: "downloaded",
      downloadMs,
    },
  };
}

/**
 * A complete extraction has a `manifest.json` (gondolin's asset
 * manifest, written by `gondolin build`). Checking for the directory
 * alone is insufficient — a previous run could have crashed mid-extract.
 */
async function isExtractedImage(dir: string): Promise<boolean> {
  try {
    const s = await stat(path.join(dir, "manifest.json"));
    return s.isFile();
  } catch {
    return false;
  }
}

async function downloadAndExtract(
  archive: ImageArchive,
  imageDir: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const tmpRoot = path.join(tmpdir(), `agentic-pi-image-${process.pid}-${Date.now()}`);
  const tmpExtract = path.join(tmpRoot, "extract");
  const tmpArchive = path.join(tmpRoot, "archive.tar.gz");
  await mkdir(tmpExtract, { recursive: true });

  let response: Response;
  try {
    response = await fetchImpl(archive.url);
  } catch (err) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new ImageLoaderError(
      `failed to download image from ${archive.url}: ${(err as Error).message}`,
      "set --sandbox-image gondolin-builtin to skip the auto-downloaded image",
    );
  }
  if (!response.ok || !response.body) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new ImageLoaderError(
      `image download failed: HTTP ${response.status} from ${archive.url}`,
      "set --sandbox-image gondolin-builtin to skip the auto-downloaded image",
    );
  }

  // Stream to disk + hash in one pass — the tarball is ~hundreds of MB,
  // so don't buffer in memory.
  const hash = createHash("sha256");
  const fileSink = createWriteStream(tmpArchive);
  await pipeline(
    response.body as unknown as NodeJS.ReadableStream,
    async function* (source) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        hash.update(buf);
        yield buf;
      }
    },
    fileSink,
  );
  const actualSha = hash.digest("hex");
  if (actualSha !== archive.sha256) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new ImageLoaderError(
      `image sha256 mismatch: expected ${archive.sha256}, got ${actualSha}`,
      "the manifest baked into this build of agentic-pi is out of sync with the release artifact",
    );
  }

  // Extract using system tar. Both macOS bsdtar and GNU tar accept
  // `-x -z -f <file> -C <dir>`; that's a hard prerequisite for using
  // gondolin in the first place (the build pipeline needs it too) so
  // we don't preflight separately here.
  await extractTarGz(tmpArchive, tmpExtract);

  // Atomic publish: rename tmp dir to the final sha-keyed dir.
  await mkdir(path.dirname(imageDir), { recursive: true });
  try {
    await rename(tmpExtract, imageDir);
  } catch (err) {
    // Either a concurrent run won the race, or rename failed across FS.
    // If the target now exists and is valid, treat as success.
    if (await isExtractedImage(imageDir)) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new ImageLoaderError(
      `failed to install image at ${imageDir}: ${(err as Error).message}`,
      "check disk space and ~/.cache/agentic-pi permissions",
    );
  }

  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
}

function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new ImageLoaderError(
            `tar extraction failed (exit ${code}): ${stderr.trim() || "no stderr"}`,
            "ensure 'tar' is on PATH and the archive isn't corrupt",
          ),
        );
    });
  });
}
