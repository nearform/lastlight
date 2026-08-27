/**
 * What the trigger commands put in the dispatch CONTEXT.
 *
 * `pr-review` is PR-scoped, and the server resolves its `PrState` snapshot only
 * when the context carries `prNumber` **as a number** — an `issueNumber` alone
 * does not satisfy that gate. The CLI sent only `issueNumber`, and the failure
 * was entirely silent: the run still succeeded, the agent just rediscovered the
 * PR with `list_pull_requests` and reviewed it with no head SHA, no PR title, no
 * `{{ciSection}}` and no merge decision. Once the review evidence pipeline
 * shipped it got louder but no clearer — with no `prState` there is no
 * `analysisEnabled`, so every analysis phase skipped as "trigger rule not
 * satisfied" on a deployment that had explicitly turned the pipeline on.
 *
 * Nothing in the CLI's own output distinguishes either case from success, which
 * is why this is asserted on the wire rather than on the exit code.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AddressInfo } from "node:net";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Captured = { workflow?: string; skill?: string; context: Record<string, unknown> };

const run = promisify(execFile);

/**
 * Run one CLI command against a throwaway server and return what it POSTed.
 *
 * `execFile`, NOT `execFileSync`. The server lives in THIS process, so a
 * synchronous spawn blocks the event loop that would have to answer the
 * request: the child waits forever for a response and the parent waits forever
 * for the child. That deadlock does not fail, it hangs — the suite sits there
 * until something outside kills it.
 */
async function capture(args: string[]): Promise<Captured> {
  const seen: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (body) seen.push(JSON.parse(body) as Captured);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, executionId: "test" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(
      process.execPath,
      [join(PACKAGE_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(PACKAGE_ROOT, "src", "cli.ts"), ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          LASTLIGHT_URL: `http://127.0.0.1:${port}`,
          LASTLIGHT_TOKEN: "test-token",
        },
      },
    );
  } finally {
    // `close()` alone waits for keep-alive sockets the CLI's fetch leaves open,
    // so the callback would not fire and the hang would simply move here.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe("trigger context — PR-scoped workflows", () => {
  it(
    "sends prNumber for `review`, so the server resolves PrState",
    { timeout: 60_000 },
    async () => {
      const sent = await capture(["review", "acme/widget#941"]);
      expect(sent.skill ?? sent.workflow).toBe("pr-review");
      // BOTH, not one or the other — the webhook sets them to the same value
      // ("PRs are issues too"), and anything already reading `issueNumber`
      // keeps working.
      expect(sent.context.prNumber).toBe(941);
      expect(sent.context.issueNumber).toBe(941);
    },
  );

  it("sends prNumber from a full pull-request URL too", { timeout: 60_000 }, async () => {
    const sent = await capture(["review", "https://github.com/acme/widget/pull/941"]);
    expect(sent.context.prNumber).toBe(941);
    expect(sent.context.repo).toBe("acme/widget");
  });

  it(
    "does NOT send prNumber for `triage` — issue-triage is not PR-scoped",
    { timeout: 60_000 },
    async () => {
      const sent = await capture(["triage", "acme/widget#941"]);
      expect(sent.skill ?? sent.workflow).toBe("issue-triage");
      expect(sent.context.issueNumber).toBe(941);
      expect(sent.context.prNumber).toBeUndefined();
    },
  );

  it("omits both numbers for a repo-wide scan", { timeout: 60_000 }, async () => {
    const sent = await capture(["review", "acme/widget"]);
    expect(sent.context.repo).toBe("acme/widget");
    expect(sent.context.prNumber).toBeUndefined();
    expect(sent.context.issueNumber).toBeUndefined();
  });
});
