import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalArtifactBackend } from "#src/sandbox/artifact-backend.js";

const root = mkdtempSync(join(tmpdir(), "ll-artifacts-"));
const backend = new LocalArtifactBackend(() => root);

describe("LocalArtifactBackend", () => {
  it("put then get round-trips bytes under the run root", async () => {
    await backend.put(
      "run-1",
      ".lastlight/pr-review/findings.json",
      Readable.from(['{"summary":"ok"}']),
    );
    const out = await backend.get("run-1", ".lastlight/pr-review/findings.json");
    const chunks: Buffer[] = [];
    for await (const c of out) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('{"summary":"ok"}');
    // Landed at the real host path a handler would read:
    expect(readFileSync(join(root, ".lastlight/pr-review/findings.json"), "utf8")).toBe(
      '{"summary":"ok"}',
    );
  });

  it("list enumerates a run's artifacts and remove clears them", async () => {
    await backend.put("run-2", ".lastlight/a.txt", Readable.from(["a"]));
    expect(await backend.list("run-2")).toContain(".lastlight/a.txt");
    await backend.remove("run-2");
    expect(await backend.list("run-2")).toEqual([]);
  });

  it("does not implement presign (proxy-only backend)", () => {
    expect(backend.presign).toBeUndefined();
  });
});
