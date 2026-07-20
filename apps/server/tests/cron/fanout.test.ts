import { describe, it, expect, vi } from "vitest";
import { dispatchCronWorkflow, fanOutContexts, type CronDispatcher } from "#src/cron/fanout.js";

describe("dispatchCronWorkflow", () => {
  it("dispatches once when context has no repos[]", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const res = await dispatchCronWorkflow(
      "repo-health",
      { repo: "cliftonc/lastlight", mode: "report" },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("repo-health", expect.objectContaining({
      repo: "cliftonc/lastlight",
      mode: "report",
      _triggerType: "cron",
    }));
    expect(res).toEqual({ dispatched: 1, failures: 0 });
  });

  it("fans out one dispatch per repo, stripping repos[] and injecting singular repo", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const repos = ["cliftonc/a", "cliftonc/b", "cliftonc/c"];
    const res = await dispatchCronWorkflow(
      "security-review",
      { repos, mode: "scan", deliverSlackSummary: true },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(3);
    const passedRepos = dispatch.mock.calls.map((c) => (c[1] as Record<string, unknown>).repo);
    expect(passedRepos.sort()).toEqual(repos.sort());
    for (const call of dispatch.mock.calls) {
      const ctx = call[1] as Record<string, unknown>;
      expect(ctx.repos).toBeUndefined();            // fan-out strips the array
      expect(ctx._triggerType).toBe("cron");
      expect(ctx.mode).toBe("scan");
      expect(ctx.deliverSlackSummary).toBe(true);
    }
    expect(res).toEqual({ dispatched: 3, failures: 0 });
  });

  it("returns zero dispatches when repos[] is empty", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const res = await dispatchCronWorkflow(
      "security-review",
      { repos: [] },
      dispatch,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(res).toEqual({ dispatched: 0, failures: 0 });
  });

  it("counts dispatch failures but isolates them (Promise.allSettled)", async () => {
    const dispatch = vi.fn<CronDispatcher>()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "boom" })
      .mockRejectedValueOnce(new Error("sandbox exploded"));
    const res = await dispatchCronWorkflow(
      "security-review",
      { repos: ["cliftonc/a", "cliftonc/b", "cliftonc/c"] },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ dispatched: 3, failures: 2 });
  });

  it("counts paused runs as non-failures", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true, paused: true });
    const res = await dispatchCronWorkflow(
      "security-review",
      { repos: ["cliftonc/a"] },
      dispatch,
    );
    expect(res).toEqual({ dispatched: 1, failures: 0 });
  });

  it("fires all dispatches at once — no throttle (the run queue is the limiter)", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const dispatch = vi.fn<CronDispatcher>().mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { success: true };
    });

    const repos = Array.from({ length: 10 }, (_, i) => `cliftonc/repo-${i}`);
    const res = await dispatchCronWorkflow("security-review", { repos }, dispatch);
    expect(res).toEqual({ dispatched: 10, failures: 0 });
    // All ten dispatched concurrently — nothing serialized on the dispatch side.
    expect(peakInFlight).toBe(10);
  });

  it("drops non-string entries from repos[] silently", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const res = await dispatchCronWorkflow(
      "security-review",
      { repos: ["cliftonc/a", 42, null, "", "cliftonc/b"] as unknown[] },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ dispatched: 2, failures: 0 });
  });
});

describe("fanOutContexts", () => {
  it("dispatches each pre-built context verbatim (the per-PR fan-out engine)", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const contexts = [
      { repo: "cliftonc/a", prNumber: 1, title: "Bump a" },
      { repo: "cliftonc/a", prNumber: 2, title: "Bump b" },
    ];
    const res = await fanOutContexts("dependabot-pr-merge", contexts, dispatch);
    expect(res).toEqual({ dispatched: 2, failures: 0 });
    expect(dispatch).toHaveBeenCalledWith("dependabot-pr-merge", { repo: "cliftonc/a", prNumber: 1, title: "Bump a" });
    expect(dispatch).toHaveBeenCalledWith("dependabot-pr-merge", { repo: "cliftonc/a", prNumber: 2, title: "Bump b" });
  });

  it("returns zero for an empty context list", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    expect(await fanOutContexts("w", [], dispatch)).toEqual({ dispatched: 0, failures: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fires every context at once — no dispatch-side throttle", async () => {
    let inFlight = 0;
    let peak = 0;
    const dispatch = vi.fn<CronDispatcher>().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { success: true };
    });
    const contexts = Array.from({ length: 9 }, (_, i) => ({ prNumber: i }));
    await fanOutContexts("w", contexts, dispatch);
    expect(peak).toBe(9);
  });
});
