/**
 * The `lastlight-state` entry point — argument parsing, the refusals, and the
 * error-message unwrapping.
 *
 * The copy itself is covered by `data-migrate.test.ts`; what matters here is
 * that a mistyped invocation is REFUSED rather than half-executed, because the
 * mistakes this tool invites are destructive ones (migrating the wrong way,
 * pointing `--to` at the database you meant to keep).
 */
import { describe, expect, it, vi } from "vitest";
import { parseArgs, runStateCli } from "#src/state/state-cli.js";
import { describeError } from "#src/state/data-migrate.js";

/** Capture what the CLI writes without letting it reach the test reporter. */
async function capture(argv: string[]): Promise<{ code: number; text: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await runStateCli(argv);
    return { code, text: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

describe("parseArgs", () => {
  it("reads flags as `--name value` and `--name=value`, and bare flags as true", () => {
    const { command, flags } = parseArgs([
      "migrate",
      "--from",
      "/data/lastlight.db",
      "--to=postgres://host/db",
      "--dry-run",
    ]);
    expect(command).toBe("migrate");
    expect(flags.get("from")).toBe("/data/lastlight.db");
    expect(flags.get("to")).toBe("postgres://host/db");
    expect(flags.get("dry-run")).toBe(true);
  });

  it("keeps a value containing '=' intact", () => {
    // A connection string carries `?options=-c search_path=x`; splitting on
    // every `=` would truncate it to the first one.
    const { flags } = parseArgs(["migrate", "--to=postgres://h/db?options=-c%20a%3Db"]);
    expect(flags.get("to")).toBe("postgres://h/db?options=-c%20a%3Db");
  });

  it("does not swallow the next flag as a value", () => {
    const { flags } = parseArgs(["migrate", "--dry-run", "--from", "x"]);
    expect(flags.get("dry-run")).toBe(true);
    expect(flags.get("from")).toBe("x");
  });
});

describe("runStateCli", () => {
  it("prints usage and exits non-zero with no command", async () => {
    const { code, text } = await capture([]);
    expect(code).toBe(2);
    expect(text).toContain("lastlight-state migrate");
  });

  it("names an unknown command instead of guessing", async () => {
    const { code, text } = await capture(["mgirate"]);
    expect(code).toBe(2);
    expect(text).toContain('Unknown command "mgirate"');
  });

  it("requires both --from and --to", async () => {
    const { code, text } = await capture(["migrate", "--from", "/data/lastlight.db"]);
    expect(code).toBe(2);
    expect(text).toContain("Both --from and --to are required");
  });

  it("refuses a --to that is not postgres:// — the wrong-direction guard", async () => {
    // The destructive mistake this catches: `--to /data/lastlight.db` with the
    // arguments the wrong way round would otherwise open the live database as
    // a migration TARGET.
    const { code, text } = await capture([
      "migrate",
      "--from",
      "postgres://host/db",
      "--to",
      "/data/lastlight.db",
    ]);
    expect(code).toBe(2);
    expect(text).toContain("--to must be a postgres:// URL");
  });

  it("refuses an unknown --driver rather than silently auto-detecting", async () => {
    const { code, text } = await capture([
      "migrate",
      "--from",
      "/data/lastlight.db",
      "--to",
      "postgres://host/db",
      "--driver",
      "neon-http",
    ]);
    expect(code).toBe(2);
    // neon-http specifically: it type-checks, passes simple reads, and loses
    // every transaction. It must never be reachable through a flag typo.
    expect(text).toContain('--driver must be "pg" or "neon"');
  });

  it("never echoes the password in a postgres URL", async () => {
    const { text } = await capture([
      "migrate",
      "--from",
      "postgres://u:hunter2@host/db",
      "--to",
      "/data/lastlight.db",
    ]);
    expect(text).not.toContain("hunter2");
  });

  it("check with no URL asks for one", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { code, text } = await capture(["check"]);
    expect(code).toBe(2);
    expect(text).toContain("--url");
    vi.unstubAllEnvs();
  });

  it("check on a non-postgres URL is a no-op success", async () => {
    const { code, text } = await capture(["check", "--url", "file:/app/data/lastlight.db"]);
    expect(code).toBe(0);
    expect(text).toContain("nothing to reach");
  });
});

describe("describeError", () => {
  it("surfaces the innermost cause, which is the only actionable part", () => {
    // The real shape: Drizzle's message is the SQL, the driver's is the reason.
    const driver = new Error('password authentication failed for user "lastlight"');
    const wrapped = new Error("Failed query: select 1\nparams: ", { cause: driver });
    const described = describeError(wrapped);
    expect(described).toContain("password authentication failed");
    // The context is kept but trimmed to one line — the `params:` dump buried
    // the reason it was wrapping.
    expect(described).toContain("while running: Failed query: select 1");
    expect(described).not.toContain("params:");
  });

  it("passes a plain error through unchanged", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});
