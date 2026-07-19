import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __prePopulateWorkspaceForTest as prePopulateWorkspace } from "#src/sandbox/index.js";

const mockExec = vi.mocked(execFileSync);

const TOKEN = "ghs_secret123ABC_xyz";

/** Flatten every execFileSync invocation's argv (args[1]) for assertions. */
function calledArgs(): string[][] {
  return mockExec.mock.calls.map((c) => (c[1] as string[]) ?? []);
}

/**
 * The git subcommand of an argv, skipping the `-C <dir>` / `-c <cfg>` top-level
 * options the auth wiring prepends (`git -C dir -c http…=… fetch …`).
 */
function gitVerb(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C" || a === "-c") { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "";
}

/** Every call's resolved git subcommand, in order. */
function gitVerbs(): string[] {
  return calledArgs().map(gitVerb);
}

/** The single `clone` invocation's argv (throws if not exactly one). */
function findClone(): string[] {
  const clones = calledArgs().filter((a) => gitVerb(a) === "clone");
  if (clones.length !== 1) throw new Error(`expected exactly one clone, got ${clones.length}`);
  return clones[0];
}

/** Base64 of `x-access-token:<token>` — the credential carried on the `-c` arg. */
function authB64(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString("base64");
}

describe("prePopulateWorkspace token-leak protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockExec.mockReset();
  });

  it("clones from a plain URL (no token embedded) and authenticates via -c extraheader", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });
    const clone = findClone();
    // The URL is plain — the token never appears in it.
    const url = clone.find((a) => a.startsWith("https://"))!;
    expect(url).toBe("https://github.com/cliftonc/lastlight.git");
    expect(clone.join(" ")).not.toContain(TOKEN);
    // Auth rides a one-shot `-c http.extraheader=AUTHORIZATION: basic <b64>`.
    const cfg = clone[clone.indexOf("-c") + 1];
    expect(cfg).toBe(`http.https://github.com/.extraheader=AUTHORIZATION: basic ${authB64(TOKEN)}`);
  });

  it("normalizes origin to a credential-free URL after cloning", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc", repo: "lastlight", branch: "opencode-fork", token: TOKEN,
    });
    const setUrl = calledArgs().find((a) => a.includes("set-url"))!;
    expect(setUrl).toEqual([
      "-C", "/tmp/work/lastlight", "remote", "set-url", "origin",
      "https://github.com/cliftonc/lastlight.git",
    ]);
  });

  it("does not leak the token into the success log line", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });
    const joined = logSpy.mock.calls.flat().join("\n");
    expect(joined).not.toContain(TOKEN);
  });

  it("redacts the token AND its base64 from the warning when git clone fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // execFileSync surfaces command failures with an Error whose .message
    // echoes the full command — now the `-c http.extraheader=…: basic <b64>`
    // arg rather than an auth URL. Reproduce that shape.
    const b64 = authB64(TOKEN);
    const failure = new Error(
      `Command failed: git -c http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64} ` +
      `clone --branch opencode-fork --depth 50 ` +
      `https://github.com/cliftonc/lastlight.git /tmp/work\n` +
      `fatal: could not create work tree dir '/tmp/work'`,
    );
    mockExec.mockImplementation(() => { throw failure; });

    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0].join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(b64);
    expect(logged).toContain("[REDACTED-AUTH]");
    // Sanity: the non-secret part of the diagnostic is preserved.
    expect(logged).toContain("opencode-fork");
    expect(logged).toContain("Pre-clone");
  });

  it("tolerates a token with URL-unsafe characters (./ /+/=)", () => {
    // The old guard threw on these; GitHub can return them. The token now
    // rides base64 inside a `-c` arg, so any charset is fine.
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
    const weird = "ghs_weird.tok/en+v=";
    prePopulateWorkspace("/tmp/work", {
      owner: "x", repo: "y", branch: "z", token: weird,
    });
    const clone = findClone();
    const cfg = clone[clone.indexOf("-c") + 1];
    // The extraheader base64 decodes back to the exact token.
    const b64 = cfg.replace(/^.*AUTHORIZATION: basic /, "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(`x-access-token:${weird}`);
    // The raw token never lands in the clone URL.
    expect(clone.join(" ")).not.toContain(weird);
  });
});

describe("prePopulateWorkspace clone depth + per-PR reuse (issue #107)", () => {
  let workDir: string;
  const REPO = "lastlight";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ll-prepop-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockExec.mockReset();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Pretend the workspace already has a clone, with `marker` as last run. */
  function seedExistingClone(marker?: string): void {
    mkdirSync(join(workDir, REPO, ".git"), { recursive: true });
    if (marker !== undefined) writeFileSync(join(workDir, ".lastlight-run"), marker);
  }

  it("clones read-only workflows shallow (--depth 1 --single-branch)", () => {
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN,
      runId: "run-1", shallow: true,
    });
    const clone = findClone();
    expect(clone).toContain("--depth");
    expect(clone[clone.indexOf("--depth") + 1]).toBe("1");
    expect(clone).toContain("--single-branch");
    // Marker stamped so a later same-run phase preserves the workspace.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("run-1");
  });

  it("clones code-writing workflows deep (--depth 50, no --single-branch)", () => {
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN,
      runId: "run-1", shallow: false,
    });
    const clone = findClone();
    expect(clone[clone.indexOf("--depth") + 1]).toBe("50");
    expect(clone).not.toContain("--single-branch");
  });

  it("preserves the workspace when a later phase of the SAME run revisits it", () => {
    seedExistingClone("run-1");
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN, runId: "run-1",
    });
    // No git ops — the architect's uncommitted scratch must survive.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("preserves the workspace for callers that don't track a run id", () => {
    seedExistingClone();
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN,
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("refreshes (fetch+reset+clean) when a DIFFERENT run reuses the PR dir", () => {
    seedExistingClone("old-run");
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "pr-head", token: TOKEN,
      runId: "new-run", shallow: true,
    });
    // fetch → checkout → reset → clean, then origin is normalized to plain.
    expect(gitVerbs()).toEqual(["fetch", "checkout", "reset", "clean", "remote"]);
    // node_modules is kept warm so the next install is incremental.
    const clean = calledArgs().find((a) => a.includes("clean"))!;
    expect(clean).toContain("-e");
    expect(clean).toContain("node_modules");
    // Never re-clones from scratch.
    expect(gitVerbs()).not.toContain("clone");
    // origin points at the credential-free URL.
    const setUrl = calledArgs().find((a) => a.includes("set-url"))!;
    expect(setUrl[setUrl.length - 1]).toBe("https://github.com/cliftonc/lastlight.git");
    // Marker advanced to the new run.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("new-run");
  });

  it("does not advance the marker if the refresh fetch fails", () => {
    seedExistingClone("old-run");
    mockExec.mockImplementation((_cmd, args) => {
      if ((args as string[]).includes("fetch")) throw new Error("network down");
      return Buffer.from("");
    });
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "pr-head", token: TOKEN,
      runId: "new-run", shallow: true,
    });
    // Stale marker retained → the next run retries the refresh.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("old-run");
  });
});

describe("prePopulateWorkspace recreate-from-base (build, issue #153)", () => {
  let workDir: string;
  const REPO = "lastlight";
  const FEATURE = "lastlight/149-foo";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ll-recreate-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockExec.mockReset();
    rmSync(workDir, { recursive: true, force: true });
  });

  function seedExistingClone(marker?: string): void {
    mkdirSync(join(workDir, REPO, ".git"), { recursive: true });
    if (marker !== undefined) writeFileSync(join(workDir, ".lastlight-run"), marker);
  }

  it("deletes a stale checkout from a DIFFERENT run and re-clones from the default branch", () => {
    seedExistingClone("old-run");
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: FEATURE, token: TOKEN,
      runId: "new-run", shallow: false, recreateFromBase: true,
    });
    // The stale checkout was removed (clone is mocked, so it isn't recreated).
    expect(existsSync(join(workDir, REPO, ".git"))).toBe(false);
    // Never refreshes the stale feature branch (no fetch/reset/clean).
    expect(calledArgs().some((a) => a.includes("fetch"))).toBe(false);
    // Clones the DEFAULT branch (no `--branch <feature>`), then cuts the
    // feature branch locally off it.
    const clone = findClone();
    expect(clone).not.toContain("--branch");
    const checkout = calledArgs().find((a) => a.includes("checkout"))!;
    expect(checkout).toEqual(["-C", join(workDir, REPO), "checkout", "-B", FEATURE]);
    // Marker advanced to the new run.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("new-run");
  });

  it("cuts the branch from the default branch on a fresh clone (never clone --branch)", () => {
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: FEATURE, token: TOKEN,
      runId: "run-1", shallow: false, recreateFromBase: true,
    });
    // A stale *pushed* feature branch must never be resurrected via clone --branch.
    const clones = calledArgs().filter((a) => gitVerb(a) === "clone");
    expect(clones).toHaveLength(1);
    expect(clones[0]).not.toContain("--branch");
    const checkout = calledArgs().find((a) => a.includes("checkout"))!;
    expect(checkout[checkout.indexOf("checkout") + 1]).toBe("-B");
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("run-1");
  });

  it("preserves the workspace on a SAME-run revisit even with recreateFromBase", () => {
    seedExistingClone("run-1");
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: FEATURE, token: TOKEN,
      runId: "run-1", recreateFromBase: true,
    });
    // Same run → no git ops, no delete (the architect's plan.md must survive).
    expect(mockExec).not.toHaveBeenCalled();
    expect(existsSync(join(workDir, REPO, ".git"))).toBe(true);
  });
});
