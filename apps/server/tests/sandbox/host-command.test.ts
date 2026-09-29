import { describe, expect, it } from "vitest";
import { runHostCommand } from "#src/sandbox/sandbox.js";

/**
 * The in-process backends' (`none`, `gondolin`) bash-phase runner. It was a
 * `spawnSync`, which froze the whole harness process for the command's
 * duration; the load-bearing property is that the event loop stays free.
 */
describe("runHostCommand", () => {
  it("does not block the event loop while the command runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const r = await runHostCommand("sleep 0.3; echo done", { env: process.env, timeoutMs: 10_000 });
    clearInterval(timer);
    expect(r).toEqual({ exitCode: 0, stdout: "done\n", stderr: "", timedOut: false });
    expect(ticks).toBeGreaterThan(5);
  });

  it("reports the exit status and stderr", async () => {
    const r = await runHostCommand("echo oops >&2; exit 3", { env: process.env, timeoutMs: 10_000 });
    expect(r).toEqual({ exitCode: 3, stdout: "", stderr: "oops\n", timedOut: false });
  });

  it("kills on timeout and says so", async () => {
    const r = await runHostCommand("sleep 5", { env: process.env, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
  });

  it("kills the command's children on timeout, not just the shell", async () => {
    // A compound command makes every shell FORK `sleep` rather than exec it (a
    // lone `sleep 5` is exec'd by bash but forked by dash, which is why the test
    // above passed on macOS and hung on Linux CI). Killing only `sh` orphans the
    // child, which holds stdout/stderr open, so the call would not return until
    // the child exited on its own — after this test's timeout.
    const started = Date.now();
    const r = await runHostCommand("sleep 5; echo done", { env: process.env, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).not.toContain("done");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("runs in the given cwd", async () => {
    const r = await runHostCommand("pwd", { cwd: "/", env: process.env, timeoutMs: 10_000 });
    expect(r.stdout.trim()).toBe("/");
  });
});
