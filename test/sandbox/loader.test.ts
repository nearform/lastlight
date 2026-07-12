/**
 * Unit tests for the image loader.
 *
 * No real network: we stub `fetch` with an in-memory tarball. The tar
 * extraction itself shells out to system `tar`, which exists on every
 * supported host (macOS/Linux), so we exercise it for real.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ensureImage,
  ImageLoaderError,
  detectArch,
  defaultCacheRoot,
} from "../../src/sandbox/images/loader.js";
import type { ImageManifest } from "../../src/sandbox/images/manifest.js";

function makeArchive(): { body: Uint8Array; sha256: string; size: number } {
  // Build a tiny tar.gz containing a single manifest.json file. The
  // loader treats "extracted iff manifest.json exists" as the signal
  // that an install is complete, so we match gondolin's asset layout.
  const stageRoot = mkdtempSync(path.join(tmpdir(), "loader-test-stage-"));
  writeFileSync(path.join(stageRoot, "manifest.json"), JSON.stringify({ stub: true }));
  writeFileSync(path.join(stageRoot, "rootfs.ext4"), "stub-rootfs-bytes");

  const archivePath = path.join(stageRoot, "out.tar.gz");
  const r = spawnSync("tar", [
    "-czf",
    archivePath,
    "-C",
    stageRoot,
    "manifest.json",
    "rootfs.ext4",
  ]);
  assert.equal(r.status, 0, `tar failed: ${r.stderr?.toString()}`);

  const body = readFileSync(archivePath);
  const sha256 = createHash("sha256").update(body).digest("hex");
  rmSync(stageRoot, { recursive: true, force: true });
  return { body: new Uint8Array(body), sha256, size: body.length };
}

function stubFetch(body: Uint8Array): typeof fetch {
  // `Response` in lib.dom.d.ts wants a `BodyInit` that doesn't include
  // a bare Uint8Array; copy into an ArrayBuffer to satisfy the typings.
  // Runtime Response accepts both, but we go through the typed path.
  return (async (_url: string) => {
    const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(ab, { status: 200 });
  }) as unknown as typeof fetch;
}

function manifestFor(arch: "aarch64" | "x86_64", sha: string, size: number): ImageManifest {
  return {
    name: "agentic-pi-dev",
    version: "0.1.0-test",
    archives: {
      aarch64:
        arch === "aarch64"
          ? { url: "https://example.com/aarch64.tar.gz", sha256: sha, uncompressedBytes: size }
          : {
              url: "https://example.com/aarch64.tar.gz",
              sha256: "0".repeat(64),
              uncompressedBytes: 0,
            },
      x86_64:
        arch === "x86_64"
          ? { url: "https://example.com/x86_64.tar.gz", sha256: sha, uncompressedBytes: size }
          : {
              url: "https://example.com/x86_64.tar.gz",
              sha256: "0".repeat(64),
              uncompressedBytes: 0,
            },
    },
  };
}

describe("ensureImage", () => {
  test("gondolin-builtin → builtin resolution", async () => {
    const r = await ensureImage("gondolin-builtin");
    assert.equal(r.kind, "builtin");
  });

  test("absolute path → local resolution with basename descriptor", async () => {
    const r = await ensureImage("/abs/path/to/foo");
    assert.equal(r.kind, "local");
    if (r.kind !== "local") return;
    assert.equal(r.imagePath, "/abs/path/to/foo");
    assert.equal(r.descriptor.name, "foo");
    assert.equal(r.descriptor.source, "local-path");
  });

  test("unknown selector throws ImageLoaderError", async () => {
    await assert.rejects(() => ensureImage("not-a-real-image"), ImageLoaderError);
  });

  test("default with unpublished manifest throws with builtin hint", async () => {
    const empty: ImageManifest = {
      name: "agentic-pi-dev",
      version: "0.0.0",
      archives: {
        aarch64: { url: "", sha256: "", uncompressedBytes: 0 },
        x86_64: { url: "", sha256: "", uncompressedBytes: 0 },
      },
    };
    await assert.rejects(
      () => ensureImage("default", { manifest: empty, arch: "aarch64" }),
      (err) => err instanceof ImageLoaderError && /gondolin-builtin/.test(err.hint),
    );
  });

  test("default → downloads, verifies sha256, extracts, then caches", async () => {
    const { body, sha256, size } = makeArchive();
    const cacheRoot = mkdtempSync(path.join(tmpdir(), "loader-test-cache-"));
    try {
      const manifest = manifestFor("aarch64", sha256, size);
      const fetchImpl = stubFetch(body);

      // First call: downloads.
      const first = await ensureImage("default", {
        manifest,
        cacheRoot,
        arch: "aarch64",
        fetch: fetchImpl,
      });
      assert.equal(first.kind, "downloaded");
      if (first.kind !== "downloaded") return;
      assert.equal(first.descriptor.source, "downloaded");
      assert.equal(first.descriptor.version, "0.1.0-test");
      assert.ok(first.descriptor.downloadMs !== undefined);
      assert.equal(first.imagePath, path.join(cacheRoot, "images", sha256));
      assert.ok(existsSync(path.join(first.imagePath, "manifest.json")));

      // Second call: should hit the cache.
      const second = await ensureImage("default", {
        manifest,
        cacheRoot,
        arch: "aarch64",
        fetch: stubFetch(new Uint8Array(0)), // would 0-byte if hit
      });
      assert.equal(second.kind, "downloaded");
      if (second.kind !== "downloaded") return;
      assert.equal(second.descriptor.source, "cached");
      assert.equal(second.imagePath, first.imagePath);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("sha256 mismatch throws and does not pollute cache", async () => {
    const { body, size } = makeArchive();
    const cacheRoot = mkdtempSync(path.join(tmpdir(), "loader-test-cache-"));
    try {
      const wrongSha = "f".repeat(64);
      const manifest = manifestFor("aarch64", wrongSha, size);
      await assert.rejects(
        () =>
          ensureImage("default", {
            manifest,
            cacheRoot,
            arch: "aarch64",
            fetch: stubFetch(body),
          }),
        (err) => err instanceof ImageLoaderError && /sha256 mismatch/.test(err.message),
      );
      assert.equal(existsSync(path.join(cacheRoot, "images", wrongSha)), false);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("HTTP error throws with builtin hint", async () => {
    const cacheRoot = mkdtempSync(path.join(tmpdir(), "loader-test-cache-"));
    try {
      const manifest = manifestFor("aarch64", "a".repeat(64), 100);
      const badFetch = (async () =>
        new Response("nope", { status: 503 })) as unknown as typeof fetch;
      await assert.rejects(
        () =>
          ensureImage("default", {
            manifest,
            cacheRoot,
            arch: "aarch64",
            fetch: badFetch,
          }),
        (err) =>
          err instanceof ImageLoaderError &&
          /503/.test(err.message) &&
          /gondolin-builtin/.test(err.hint),
      );
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("detectArch", () => {
  test("returns a supported arch on this host", () => {
    // The CI matrix and dev hosts are all aarch64 or x86_64, so this
    // shouldn't throw — but if it does, the message tells the user
    // exactly what to do.
    const a = detectArch();
    assert.ok(a === "aarch64" || a === "x86_64");
  });
});

describe("defaultCacheRoot", () => {
  test("respects XDG_CACHE_HOME when set", () => {
    const original = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache-test-root";
    try {
      assert.equal(defaultCacheRoot(), "/tmp/xdg-cache-test-root/agentic-pi");
    } finally {
      if (original === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = original;
    }
  });

  test("falls back to ~/.cache/agentic-pi when XDG_CACHE_HOME unset", () => {
    const original = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      const r = defaultCacheRoot();
      assert.ok(r.endsWith("/.cache/agentic-pi"), `got ${r}`);
    } finally {
      if (original !== undefined) process.env.XDG_CACHE_HOME = original;
    }
  });
});

// Tell tsc that mkdirSync is used (for future hook points) — keeps
// the linter quiet without an eslint-disable.
void mkdirSync;
