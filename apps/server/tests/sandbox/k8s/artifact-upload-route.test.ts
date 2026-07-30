import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountArtifactUpload } from "#src/sandbox/k8s/artifact-upload-route.js";
import { LocalArtifactBackend } from "#src/sandbox/artifact-backend.js";
import { createArtifactStore, type ArtifactStore } from "#src/sandbox/artifact-store.js";

/** Stage `entries` (relPath → content) under a scratch dir and tar up the
 *  `.lastlight` subtree via system `tar` — mirrors artifact-store.test.ts. */
function buildGzTar(entries: Record<string, string>): Buffer {
  const staging = mkdtempSync(join(tmpdir(), "ll-artifact-upload-tar-"));
  for (const [relPath, content] of Object.entries(entries)) {
    const dest = join(staging, relPath);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, content);
  }
  const tarPath = join(staging, "bundle.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", staging, ".lastlight"]);
  return readFileSync(tarPath);
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "ll-artifacts-upload-"));
}

function appWith(store: ArtifactStore): Hono {
  const app = new Hono();
  mountArtifactUpload(app, store);
  return app;
}

describe("POST /internal/sandbox-artifacts", () => {
  it("401s a missing Authorization header", async () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);
    const app = appWith(store);

    const res = await app.request("/internal/sandbox-artifacts", { method: "POST" });

    expect(res.status).toBe(401);
  });

  it("401s an unknown token", async () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);
    const app = appWith(store);

    const res = await app.request("/internal/sandbox-artifacts", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });

    expect(res.status).toBe(401);
  });

  it("204s and unpacks a valid upload under the run root", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    const store = createArtifactStore(backend);
    const token = store.register("run-1");
    const app = appWith(store);

    const body = buildGzTar({
      ".lastlight/pr-review/findings.json": '{"summary":"ok"}',
    });

    const res = await app.request("/internal/sandbox-artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });

    expect(res.status).toBe(204);
    expect(readFileSync(join(root, ".lastlight/pr-review/findings.json"), "utf8")).toBe(
      '{"summary":"ok"}',
    );
  });

  it("413s an over-cap upload", async () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend, { maxBundleBytes: 16 });
    const token = store.register("run-2");
    const app = appWith(store);

    const res = await app.request("/internal/sandbox-artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.alloc(1024, "a"),
    });

    expect(res.status).toBe(413);
  });

  it("400s a malformed (non-tar) upload", async () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);
    const token = store.register("run-3");
    const app = appWith(store);

    const res = await app.request("/internal/sandbox-artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from("not a tarball"),
    });

    expect(res.status).toBe(400);
  });
});
