import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parsePrRef, prCommand, type PrOpts } from "../src/pr-cli.js";

/**
 * `lastlight pr retry` — the client half of the third retry surface
 * (docs/plans/stuck-pr-recovery/03-retry-intervention.md).
 *
 * The command is deliberately thin: every guard that matters (the managed-repo
 * allowlist, the hold label, the run lock, the fix budgets) lives on the server,
 * at the same gate a webhook crosses. So what is worth testing here is exactly
 * what the CLI owns — the reference it accepts, the request it builds, and the
 * fact that a REFUSAL is rendered as a refusal and exits non-zero rather than
 * being mistaken for a queued retry.
 */

function fakePost(status: number, data: unknown) {
  return vi.fn(async () => ({ status, data })) as unknown as PrOpts["apiPost"];
}

let logs: string[];
let errs: string[];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("parsePrRef", () => {
  it("accepts owner/repo#N and a pull URL", () => {
    expect(parsePrRef("acme/widget#190")).toEqual({ owner: "acme", repo: "widget", prNumber: 190 });
    expect(parsePrRef("https://github.com/acme/widget/pull/190")).toEqual({
      owner: "acme",
      repo: "widget",
      prNumber: 190,
    });
  });

  it("refuses an ISSUE url — a retry moves a PR's fix budgets and means nothing on an issue", () => {
    expect(parsePrRef("https://github.com/acme/widget/issues/190")).toBeNull();
  });

  it("refuses anything that isn't a reference", () => {
    expect(parsePrRef("acme/widget")).toBeNull();
    expect(parsePrRef("190")).toBeNull();
    expect(parsePrRef("")).toBeNull();
  });
});

describe("lastlight pr retry", () => {
  it("POSTs to the PR's retry endpoint and reports the dispatched workflow", async () => {
    const apiPost = fakePost(200, {
      repo: "acme/widget",
      prNumber: 190,
      workflow: "dependabot-ci-fix",
      dispatched: true,
      reason: "attempt 1/3",
    });

    const code = await prCommand(["retry", "acme/widget#190"], { apiPost });

    expect(code).toBe(0);
    expect(apiPost).toHaveBeenCalledWith("/admin/api/prs/acme/widget/190/retry", {});
    expect(logs.join("\n")).toContain("retrying dependabot-ci-fix on acme/widget#190");
  });

  it("sends everything after the reference as the reason, unquoted", async () => {
    const apiPost = fakePost(200, { workflow: "pr-fix", dispatched: true, reason: "attempt 1/3" });

    await prCommand(["retry", "acme/widget#190", "arm64", "runner", "was", "flaky"], { apiPost });

    expect(apiPost).toHaveBeenCalledWith("/admin/api/prs/acme/widget/190/retry", {
      reason: "arm64 runner was flaky",
    });
  });

  it("says so — and still succeeds — when the retry was recorded but not run", async () => {
    // The gate skipped for an unrelated reason (a red base branch). The ask IS
    // on the record, so this is a success: the next event honours it.
    const apiPost = fakePost(200, {
      workflow: "pr-fix",
      dispatched: false,
      recorded: true,
      reason: "upstream-broken: base branch main is failing",
      retry: { via: "api", note: "try again please" },
    });

    const code = await prCommand(["retry", "acme/widget#190"], { apiPost });

    expect(code).toBe(0);
    const printed = logs.join("\n");
    expect(printed).toContain("recorded a retry");
    expect(printed).toContain("upstream-broken");
    expect(printed).toContain("note: try again please");
  });

  it("exits non-zero on a refusal, and prints the reason rather than a stack trace", async () => {
    // The hold label beats a retry outright (locked decision 4) and nothing is
    // recorded — so this must not read like a queued retry.
    const apiPost = fakePost(409, {
      dispatched: false,
      recorded: false,
      held: "lastlight-ignore",
      reason: "I'm staying off this one — it's labelled `lastlight-ignore`…",
    });

    const code = await prCommand(["retry", "acme/widget#190"], { apiPost });

    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("lastlight-ignore");
    expect(logs.join("\n")).not.toContain("retrying");
  });

  it("surfaces an unmanaged repo as an error", async () => {
    const apiPost = fakePost(403, { error: "acme/widget is not a managed repository" });
    await expect(prCommand(["retry", "acme/widget#190"], { apiPost })).rejects.toThrow(
      /not a managed repository/,
    );
  });

  it("--json prints the server's answer verbatim and mirrors its status in the exit code", async () => {
    const body = { workflow: "pr-fix", dispatched: true };
    const ok = await prCommand(["retry", "acme/widget#190"], { apiPost: fakePost(200, body), json: true });
    expect(ok).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual(body);

    logs.length = 0;
    const refused = await prCommand(["retry", "acme/widget#190"], {
      apiPost: fakePost(409, { reason: "run-in-flight" }),
      json: true,
    });
    expect(refused).toBe(1);
    expect(JSON.parse(logs.join(""))).toEqual({ reason: "run-in-flight" });
  });

  it("explains itself instead of calling the server on a bad reference or subcommand", async () => {
    const apiPost = fakePost(200, {});
    await expect(prCommand(["retry", "acme/widget"], { apiPost })).rejects.toThrow(
      /Not a pull-request reference/,
    );
    await expect(prCommand(["retry"], { apiPost })).rejects.toThrow(/Usage: lastlight pr retry/);
    await expect(prCommand([], { apiPost })).rejects.toThrow(/Unknown "pr" subcommand/);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
