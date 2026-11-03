import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLiveRunsForTest,
  claimRun,
  isRunLive,
  markRunLive,
  waitForRunToStop,
} from "#src/workflows/live-runs.js";

describe("live-runs — which runs are executing in this process", () => {
  afterEach(() => __resetLiveRunsForTest());

  it("a run is live between mark and release", () => {
    const release = markRunLive("run-1");
    expect(isRunLive("run-1")).toBe(true);
    release();
    expect(isRunLive("run-1")).toBe(false);
  });

  it("an older release never clears a newer registration of the same id", () => {
    const first = markRunLive("run-1");
    const second = markRunLive("run-1");
    first();
    expect(isRunLive("run-1")).toBe(true);
    second();
    expect(isRunLive("run-1")).toBe(false);
  });

  it("a run stays live until every registration releases, whatever the order", () => {
    const first = markRunLive("run-1");
    const second = markRunLive("run-1");
    second();
    expect(isRunLive("run-1")).toBe(true);
    first();
    expect(isRunLive("run-1")).toBe(false);
  });

  it("claimRun takes a run that is not live, and refuses one that is", () => {
    const release = claimRun("run-1");
    expect(release).not.toBeNull();
    expect(isRunLive("run-1")).toBe(true);
    expect(claimRun("run-1")).toBeNull();
    release!();
    expect(isRunLive("run-1")).toBe(false);
    expect(claimRun("run-1")).not.toBeNull();
  });

  it("waitForRunToStop waits for the last registration, not the latest", async () => {
    const first = markRunLive("run-1");
    const second = markRunLive("run-1");
    let stopped = false;
    const waiting = waitForRunToStop("run-1", 60_000).then((r) => {
      stopped = true;
      return r;
    });
    second();
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    first();
    await expect(waiting).resolves.toBe(true);
  });

  it("waitForRunToStop resolves true once the run releases", async () => {
    const release = markRunLive("run-1");
    const waiting = waitForRunToStop("run-1", 60_000);
    release();
    await expect(waiting).resolves.toBe(true);
  });

  it("waitForRunToStop resolves true at once for a run that is not live", async () => {
    await expect(waitForRunToStop("never-ran", 60_000)).resolves.toBe(true);
  });

  it("waitForRunToStop resolves false when the run outlasts the wait", async () => {
    markRunLive("run-1");
    await expect(waitForRunToStop("run-1", 5)).resolves.toBe(false);
  });
});
