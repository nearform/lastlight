import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { activityCommand, type ActivityOpts } from "../src/activity-cli.js";

/**
 * `lastlight activity` — the client half of the audit stream (issue #206).
 *
 * The command is deliberately thin: filtering, pagination and the `total` all
 * happen server-side. So what is worth testing is exactly what the CLI owns —
 * the query it builds from its flags, and how it renders the two things a
 * naive table would get wrong: a row with NO actor (a password session, which
 * is a real row and not missing data), and `--json` passing the envelope
 * through untouched.
 */

function fakeGet(data: unknown) {
  return vi.fn(async () => data) as unknown as ActivityOpts["apiGet"];
}

const ROW = {
  id: "a1",
  createdAt: new Date().toISOString(),
  actorLogin: "octocat",
  actorType: "github",
  action: "cron.toggle",
  targetType: "cron",
  targetId: "cron-review",
  outcome: "ok",
  detail: { enabled: false },
};

let logs: string[];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("activityCommand", () => {
  it("defaults to a bounded page rather than the server default", async () => {
    const apiGet = fakeGet({ activity: [], total: 0, users: {} });
    await activityCommand([], { apiGet });
    const path = (apiGet as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(path).toContain("limit=30");
  });

  it("passes every filter through to the query", async () => {
    const apiGet = fakeGet({ activity: [], total: 0, users: {} });
    await activityCommand(
      ["--actor", "octocat", "--action", "cron.fire", "--target", "cron:review", "--since", "2026-01-01"],
      { apiGet },
    );
    const path = (apiGet as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(path).toContain("actor=octocat");
    expect(path).toContain("action=cron.fire");
    expect(path).toContain("target=cron%3Areview");
    expect(path).toContain("since=2026-01-01");
  });

  it("renders the real name when the server resolved one", async () => {
    const apiGet = fakeGet({
      activity: [ROW],
      total: 1,
      users: { octocat: { login: "octocat", name: "Mona Lisa" } },
    });
    await activityCommand([], { apiGet });
    const output = logs.join("\n");
    expect(output).toContain("Mona Lisa");
    expect(output).toContain("cron.toggle");
    expect(output).toContain("cron:cron-review");
    expect(output).toContain("1 total");
  });

  it("falls back to the bare login when `users` has no row", async () => {
    const apiGet = fakeGet({ activity: [ROW], total: 1, users: {} });
    await activityCommand([], { apiGet });
    expect(logs.join("\n")).toContain("octocat");
  });

  it("marks a row with no actor rather than leaving the cell blank", async () => {
    // A password session writes a real row that names nobody. Rendering that as
    // an empty cell would read as missing data; it is not.
    const apiGet = fakeGet({
      activity: [{ ...ROW, actorLogin: undefined, actorType: "admin" }],
      total: 1,
      users: {},
    });
    await activityCommand([], { apiGet });
    expect(logs.join("\n")).toContain("no login");
  });

  it("--json prints the envelope verbatim and renders no table", async () => {
    const envelope = { activity: [ROW], total: 1, users: {} };
    const apiGet = fakeGet(envelope);
    await activityCommand([], { apiGet, json: true });
    expect(JSON.parse(logs.join("\n"))).toEqual(envelope);
  });

  it("prints usage for help without calling the API", async () => {
    const apiGet = fakeGet({});
    await activityCommand(["help"], { apiGet });
    expect(logs.join("\n")).toContain("Usage: lastlight activity");
    expect(apiGet).not.toHaveBeenCalled();
  });
});
