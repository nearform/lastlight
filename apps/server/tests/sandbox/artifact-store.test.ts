import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { LocalArtifactBackend } from "#src/sandbox/artifact-backend.js";
import { ArtifactTooLarge, createArtifactStore } from "#src/sandbox/artifact-store.js";

/** Stage `entries` (relPath → content) under a scratch dir and tar up the
 *  `.lastlight` subtree via system `tar` — mirrors the brief's sketch. The
 *  staging dir is removed once the archive is built; only the small
 *  `.tar.gz` (outside the staging dir) survives for the caller to read. */
function buildGzTar(entries: Record<string, string>): string {
  const staging = mkdtempSync(join(tmpdir(), "ll-artifact-tar-"));
  try {
    for (const [relPath, content] of Object.entries(entries)) {
      const dest = join(staging, relPath);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, content);
    }
    const tarPath = join(tmpdir(), `ll-artifact-bundle-${randomUUID()}.tar.gz`);
    execFileSync("tar", ["-czf", tarPath, "-C", staging, ".lastlight"]);
    return tarPath;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Build one 512-byte USTAR header (regular file), including checksum. */
function ustarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, "utf8");
  buf.write("0000644\0", 100, "utf8"); // mode
  buf.write("0000000\0", 108, "utf8"); // uid
  buf.write("0000000\0", 116, "utf8"); // gid
  buf.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size
  buf.write("00000000000\0", 136, "utf8"); // mtime
  buf.write("        ", 148, "utf8"); // chksum placeholder (8 spaces)
  buf.write("0", 156, "utf8"); // typeflag: regular file
  buf.write("ustar\0", 257, "utf8"); // magic
  buf.write("00", 263, "utf8"); // version
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return buf;
}

function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const header = ustarHeader(name, data.length);
  const padLen = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padLen)]);
}

/**
 * Hand-craft a gzipped tar (bypassing the tar CLI's own creation-time path
 * sanitization — GNU tar rewrites a CLI-built `../x` member name to a bare
 * `x` at creation time) with one entry literally named `../escape-raw.txt`.
 * This is the realistic threat model: a compromised sandbox pod building its
 * own tar bytes directly, not shelling out to `tar` to create the archive.
 */
function buildRawTraversalTarGz(): string {
  const tar = Buffer.concat([
    tarEntry("../escape-raw.txt", "evil"),
    Buffer.alloc(1024), // two zero blocks: end-of-archive marker
  ]);
  const tarPath = join(tmpdir(), `ll-artifact-raw-${randomUUID()}.tar.gz`);
  writeFileSync(tarPath, gzipSync(tar));
  return tarPath;
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "ll-artifacts-"));
}

describe("ArtifactStore", () => {
  it("register/resolve round-trips a token; an unknown token resolves undefined", () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);

    const token = store.register("run-1");

    expect(store.resolve(token)).toBe("run-1");
    expect(store.resolve("not-a-real-token")).toBeUndefined();
  });

  it("unpacks a gzipped tar's .lastlight/ entries via the backend", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    const store = createArtifactStore(backend);
    const token = store.register("run-2");

    const tarPath = buildGzTar({
      ".lastlight/pr-review/findings.json": '{"summary":"ok"}',
    });

    await store.unpack(token, createReadStream(tarPath));

    expect(readFileSync(join(root, ".lastlight/pr-review/findings.json"), "utf8")).toBe(
      '{"summary":"ok"}',
    );
  });

  it("rejects a tar entry that escapes .lastlight/ via ../", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    const store = createArtifactStore(backend);
    const token = store.register("run-3");

    // Build an archive whose one entry is literally named "../escape.txt" —
    // tar -C into a nested dir and reference a sibling file one level above it.
    const base = mkdtempSync(join(tmpdir(), "ll-artifact-escape-"));
    const outer = join(base, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, "escape.txt"), "evil");
    const tarPath = join(base, "escape.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", inner, "../escape.txt"]);

    await expect(store.unpack(token, createReadStream(tarPath))).rejects.toThrow();
  });

  it("rejects a raw hand-crafted tar entry (bypasses tar-CLI creation sanitizing)", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    const store = createArtifactStore(backend);
    const token = store.register("run-6");

    const tarPath = buildRawTraversalTarGz();

    await expect(store.unpack(token, createReadStream(tarPath))).rejects.toThrow();
    expect(existsSync(join(root, ".lastlight"))).toBe(false);
  });

  it("throws ArtifactTooLarge when the upload body exceeds the compressed cap", async () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend, { maxBundleBytes: 16 });
    const token = store.register("run-4");

    await expect(
      store.unpack(token, Readable.from([Buffer.alloc(1024, "a")])),
    ).rejects.toThrow(ArtifactTooLarge);
  });

  it("throws ArtifactTooLarge when decompressed bytes exceed the decompressed cap", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    // Small decompressed cap so the test stays fast; the compressed cap stays
    // at its generous default since the payload below compresses tiny.
    const store = createArtifactStore(backend, { maxDecompressedBytes: 64 * 1024 });
    const token = store.register("run-7");

    // Highly compressible payload: gzip shrinks a multi-MB run of one repeated
    // byte down to a few KB, so the compressed cap stays generous while the
    // decompressed cap trips almost immediately — the zip-bomb scenario.
    const tarPath = buildGzTar({
      ".lastlight/big.bin": "a".repeat(2 * 1024 * 1024),
    });

    await expect(store.unpack(token, createReadStream(tarPath))).rejects.toThrow(ArtifactTooLarge);
    expect(existsSync(join(root, ".lastlight"))).toBe(false);
  });

  it("evict drops the token so a later resolve is undefined", () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);
    const token = store.register("run-5");

    store.evict(token);

    expect(store.resolve(token)).toBeUndefined();
  });
});
