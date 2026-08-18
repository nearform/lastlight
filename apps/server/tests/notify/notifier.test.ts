import { describe, it, expect, vi } from "vitest";

// src/notify/notifier.ts now logs a transport failure via the pino LoggerPort
// instead of console — mock the logger module so the suite's stderr stays
// free of real pino JSON (the "survives one failing" test below deliberately
// triggers this path; no assertions depend on the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { ProgressNotifier } from "#src/notify/notifier.js";
import type { NotifierTransport, ProgressModel } from "#src/notify/types.js";

function fakeTransport(opts: { terminalPing?: boolean } = {}) {
  const published: string[] = [];
  const notes: string[] = [];
  const t: NotifierTransport = {
    publish: vi.fn(async (md: string) => { published.push(md); }),
    note: vi.fn(async (md: string) => { notes.push(md); }),
    terminalPing: opts.terminalPing,
  };
  return { t, published, notes };
}

const model: ProgressModel = {
  title: "build for #1",
  steps: [
    { key: "a", label: "A", status: "pending" },
    { key: "b", label: "B", status: "pending" },
  ],
};

describe("ProgressNotifier", () => {
  it("publishes the initial model on start and re-publishes on each mutation", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.step("a", "running", "working");
    await n.step("a", "done");
    expect(published).toHaveLength(3);
    expect(published[0]).toContain("**A**");
    expect(published[1]).toContain("**A** — working");
    expect(published[2]).toMatch(/✅ \*\*A\*\*/);
  });

  it("insertStep adds a dynamic row before the named key", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.insertStep({ key: "x", label: "Fix (cycle 1)", status: "running" }, "b");
    const last = published[published.length - 1];
    expect(last.indexOf("Fix (cycle 1)")).toBeGreaterThan(last.indexOf("**A**"));
    expect(last.indexOf("Fix (cycle 1)")).toBeLessThan(last.indexOf("**B**"));
  });

  it("note posts a standalone message to every transport and skips empties", async () => {
    const { t, notes } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.note("done!");
    await n.note("   ");
    expect(notes).toEqual(["done!"]);
  });

  it("fans out to multiple transports and survives one failing", async () => {
    const ok = fakeTransport();
    const bad: NotifierTransport = {
      publish: vi.fn(async () => { throw new Error("boom"); }),
      note: vi.fn(async () => {}),
    };
    const n = new ProgressNotifier([bad, ok.t]);
    await expect(n.start(model)).resolves.toBeUndefined();
    expect(ok.published).toHaveLength(1); // healthy transport still got it
  });

  it("noteTerminal only hits transports that want a terminal ping", async () => {
    const gh = fakeTransport({ terminalPing: false });   // GitHub: no terminal ping
    const slack = fakeTransport({ terminalPing: true });  // Slack: wants it
    const n = new ProgressNotifier([gh.t, slack.t]);
    await n.start(model);
    await n.noteTerminal("✅ build complete — PR #1.");
    expect(slack.notes).toEqual(["✅ build complete — PR #1."]);
    expect(gh.notes).toEqual([]);
  });

  it("footer sets the trailing section and re-publishes in place", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.footer("## CONFIRMED\nthe verdict");
    const last = published[published.length - 1];
    expect(last).toContain("## CONFIRMED");
    expect(last).toContain("the verdict");
    // Still the same surface (in-place update), not a standalone note.
    expect(last).toContain("**A**");
  });

  it("footer with blank content clears the footer and re-publishes", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.footer("temp");
    await n.footer("   ");
    expect(published[published.length - 1]).not.toContain("temp");
  });

  it("no-ops cleanly with zero transports", async () => {
    const n = new ProgressNotifier([]);
    await expect(n.start(model)).resolves.toBeUndefined();
    await expect(n.step("a", "done")).resolves.toBeUndefined();
    await expect(n.note("x")).resolves.toBeUndefined();
  });

  it("ignores step/insert before start (no model yet)", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.step("a", "done");
    expect(published).toHaveLength(0);
  });
});
