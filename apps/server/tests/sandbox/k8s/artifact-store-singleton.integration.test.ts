/**
 * Artifact-store singleton — in-process round-trip.
 *
 * This is the critical correctness check for Plan 8 Task 6: the k8s adapter
 * (`KubernetesSandbox`, which `register`s a per-run token) and the
 * `POST /internal/sandbox-artifacts` route (which `resolve`s it) MUST share
 * the SAME `ArtifactStore` instance, or every real upload 401s. Task 4 left
 * the adapter defaulting to a fresh per-instance store; Task 6 points both
 * sides at the `artifactStore` singleton exported from
 * `src/sandbox/artifact-store.ts`.
 *
 * This test proves the wiring end-to-end without a cluster: it registers a
 * token on the exported singleton — exactly what `KubernetesSandbox.runAgent`
 * does now that its default falls back to this same export (see the sibling
 * assertion in `kubernetes-sandbox.test.ts`) — mounts the real
 * `mountArtifactUpload` route on a fresh Hono app using that SAME singleton,
 * then POSTs a small gz-tar and confirms both the 204 and that the bytes land
 * under the singleton's own `rootFor` path. No cluster needed, so this runs
 * in the normal suite (not gated on `RUN_K8S_IT`).
 *
 * What's still deferred: the real pod → harness network round-trip (a sandbox
 * Pod's exit hook actually curling a deployed harness) is exercised by the
 * opt-in `RUN_K8S_IT` case in `kubernetes.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { artifactStore } from "#src/sandbox/artifact-store.js";
import { mountArtifactUpload } from "#src/sandbox/k8s/artifact-upload-route.js";
import { resetRuntimeConfigForTests } from "#src/config/config.js";

/** Stage `entries` under a scratch dir and tar the `.lastlight` subtree via
 *  system `tar` — the same shape the in-pod upload script produces
 *  (`tar -czf - .lastlight`). */
function buildGzTar(entries: Record<string, string>): Buffer {
  const staging = mkdtempSync(join(tmpdir(), "ll-singleton-tar-"));
  try {
    for (const [relPath, content] of Object.entries(entries)) {
      const dest = join(staging, relPath);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, content);
    }
    const tarPath = join(staging, "bundle.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", staging, ".lastlight"]);
    return readFileSync(tarPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

describe("artifactStore singleton (in-process round-trip)", () => {
  const originalStateDir = process.env.STATE_DIR;
  let stateDir: string | undefined;

  beforeEach(() => {
    // The singleton's `rootFor` reads `getRuntimeConfig()?.sandboxDir` first and
    // only falls back to `$STATE_DIR/sandboxes` when it's undefined. In the full
    // suite another test may have left a runtime config loaded (pointing
    // `sandboxDir` elsewhere), which would make this test's `STATE_DIR` pin a
    // no-op and land the upload at an unrelated (possibly unwritable) path. Reset
    // it so the fallback is deterministic and this test controls where bytes land.
    resetRuntimeConfigForTests();
  });

  afterEach(() => {
    resetRuntimeConfigForTests();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    stateDir = undefined;
    if (originalStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = originalStateDir;
  });

  it("a token registered on the singleton is resolvable by a route mounting the same singleton, and the upload lands at the singleton's own rootFor path", async () => {
    // No `loadConfig()` runs in this test file, so `getRuntimeConfig()` stays
    // undefined and the singleton's lazy `rootFor` falls back to
    // `$STATE_DIR/sandboxes/<taskId>` — pin STATE_DIR to an isolated temp dir
    // so the assertion below is deterministic regardless of the ambient env.
    stateDir = mkdtempSync(join(tmpdir(), "ll-state-"));
    process.env.STATE_DIR = stateDir;

    const taskId = `it-singleton-${Date.now()}`;
    // Mirrors `KubernetesSandbox.runAgent`'s
    // `this.artifactToken = this.artifactStore.register(this.opts.taskId)`.
    const token = artifactStore.register(taskId);

    const app = new Hono();
    mountArtifactUpload(app, artifactStore);

    const body = buildGzTar({
      ".lastlight/pr-review/findings.json": '{"summary":"ok"}',
    });

    const res = await app.request("/internal/sandbox-artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });

    expect(res.status).toBe(204);
    const landed = join(stateDir, "sandboxes", taskId, ".lastlight", "pr-review", "findings.json");
    expect(readFileSync(landed, "utf8")).toBe('{"summary":"ok"}');
  });
});
