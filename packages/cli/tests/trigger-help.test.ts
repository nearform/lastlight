/**
 * `lastlight <cmd> help` must never dispatch a workflow.
 *
 * The seven trigger commands took `positionals[1]` as their target with no
 * validation, so `lastlight review help` POSTed /api/run with `repo: "help"` —
 * a real, billable repo-wide scan on whatever instance the CLI was pointed at.
 * It only ever looked harmless because no repository is named "help" and the
 * server answered 403; the write path was reached every time (issue #361).
 *
 * Asserted on the wire, not on the exit code: the whole failure was that the
 * request happened at all.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AddressInfo } from "node:net";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TRIGGERS = ["triage", "review", "health", "security", "verify", "qa-test", "demo"];

const run = promisify(execFile);

type Result = { requests: string[]; stdout: string; stderr: string; code: number };

/** Run one CLI command against a server that records every request path. */
async function runCli(args: string[]): Promise<Result> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, executionId: "test" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await run(
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
    ).catch((e: Error & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      code: e.code ?? 1,
    }));
    return { requests, stdout: res.stdout, stderr: res.stderr, code: (res as { code?: number }).code ?? 0 };
  } finally {
    // `close()` alone waits on keep-alive sockets the CLI's fetch leaves open.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("trigger commands — help never dispatches", () => {
  for (const cmd of TRIGGERS) {
    it(`\`${cmd} help\` prints usage and sends nothing`, { timeout: 60_000 }, async () => {
      const res = await runCli([cmd, "help"]);
      expect(res.requests).toEqual([]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`lastlight ${cmd} `);
    });

    it(`\`${cmd} --help\` prints usage and sends nothing`, { timeout: 60_000 }, async () => {
      const res = await runCli([cmd, "--help"]);
      expect(res.requests).toEqual([]);
      expect(res.stdout).toContain(`lastlight ${cmd} `);
    });
  }
});

describe("trigger commands — unparseable targets fail before the network", () => {
  it("rejects a bare word as a scan target", { timeout: 60_000 }, async () => {
    const res = await runCli(["review", "widget"]);
    expect(res.requests).toEqual([]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Not a repository: widget");
  });

  it("rejects an issue ref for a repo-level command", { timeout: 60_000 }, async () => {
    const res = await runCli(["health", "acme/widget#941"]);
    expect(res.requests).toEqual([]);
    expect(res.stderr).toContain("scans a whole repository");
  });

  it("still dispatches a well-formed repo scan", { timeout: 60_000 }, async () => {
    const res = await runCli(["review", "acme/widget"]);
    expect(res.requests).toEqual(["POST /api/run"]);
  });
});
