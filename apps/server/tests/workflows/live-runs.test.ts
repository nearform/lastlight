import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLiveRunsForTest,
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
