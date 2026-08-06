import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import {
  TeamVisibilityResolver,
  type VisibilityResult,
} from "#src/engine/github/team-visibility.js";
import type { TeamVisibilityConfig } from "#src/config/config.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

const CONFIG: TeamVisibilityConfig = {
  enabled: true,
  ttlMinutes: 60,
  maxTeamsPerUser: 50,
  maxPagesPerTeam: 20,
  maxRequestsPerResolve: 60,
};

/**
 * A GitHub stub that counts calls. The counts are the point of most of these
 * tests: the whole design exists so the cost of an answer tracks the USER's
 * team count, not the org's repo count.
 */
function fakeGithub(opts: {
  teams?: Record<string, Array<{ slug: string; name: string | null }>>;
  /** team slug → the repos it grants, in page-sized reality. */
  teamRepos?: Record<string, string[]>;
  failTeams?: boolean;
  pageSize?: number;
}) {
  const calls = { listUserTeams: 0, listTeamRepos: 0, pages: 0 };
  const pageSize = opts.pageSize ?? 100;
  const github = {
    async listUserTeams(org: string, login: string, o: { maxPages?: number } = {}) {
      calls.listUserTeams++;
      if (opts.failTeams) throw new Error("Resource not accessible by integration");
      void login;
      void o;
      return { teams: opts.teams?.[org] ?? [], requests: 1 };
    },
    async listTeamRepos(
      org: string,
      slug: string,
      o: { maxPages?: number; isDone?: (repos: string[]) => boolean } = {},
    ) {
      calls.listTeamRepos++;
      void org;
      const all = opts.teamRepos?.[slug] ?? [];
      const maxPages = o.maxPages ?? 20;
      const seen: string[] = [];
      let page = 0;
      for (; page < maxPages; page++) {
        const slice = all.slice(page * pageSize, (page + 1) * pageSize);
        seen.push(...slice);
        calls.pages++;
        if (o.isDone?.(seen)) return { repos: seen, truncated: false, requests: page + 1 };
        if ((page + 1) * pageSize >= all.length) {
          return { repos: seen, truncated: false, requests: page + 1 };
        }
      }
      return { repos: seen, truncated: true, requests: page };
    },
  } as unknown as GitHubClient;
  return { github, calls };
}

function resolver(
  github: GitHubClient | null,
  managed: string[],
  config: Partial<TeamVisibilityConfig> = {},
): TeamVisibilityResolver {
  return new TeamVisibilityResolver({
    store: db.teams,
    github,
    config: () => ({ ...CONFIG, ...config }),
    managedRepos: () => managed,
  });
}

/** Every fail-open outcome shares this shape — assert it in one place. */
function expectFailOpen(result: VisibilityResult, reason: VisibilityResult["reason"]) {
  expect(result.repos).toBeNull();
  expect(result.reason).toBe(reason);
}

describe("TeamVisibilityResolver — the happy path", () => {
  it("returns the managed repos this login's teams grant", async () => {
    const { github } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: "Platform" }] },
      teamRepos: { platform: ["nearform/lastlight", "nearform/unmanaged"] },
    });
    const r = resolver(github, ["nearform/lastlight", "nearform/www"]);
    const result = await r.visibleRepos("alice");
    // `nearform/unmanaged` is dropped: the grant is intersected with the
    // managed set, so a team's access to unrelated org repos never leaks in.
    expect(result.repos).toEqual(["nearform/lastlight"]);
    expect(result.reason).toBe("ok");
    expect(result.synced).toBe(true);
  });

  it("unions the grants of several teams", async () => {
    const { github } = fakeGithub({
      teams: {
        nearform: [
          { slug: "platform", name: null },
          { slug: "web", name: null },
        ],
      },
      teamRepos: { platform: ["nearform/lastlight"], web: ["nearform/www"] },
    });
    const r = resolver(github, ["nearform/lastlight", "nearform/www"]);
    expect((await r.visibleRepos("alice")).repos).toEqual([
      "nearform/lastlight",
      "nearform/www",
    ]);
  });

  it("only asks the orgs that actually own a managed repo", async () => {
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: ["nearform/lastlight"] },
    });
    const r = resolver(github, ["nearform/lastlight", "nearform/www", "cliftonc/scratch"]);
    await r.visibleRepos("alice");
    // Two distinct owners across three repos ⇒ two team queries, not three.
    expect(calls.listUserTeams).toBe(2);
  });
});

describe("TeamVisibilityResolver — cost", () => {
  it("costs a handful of requests in an org with thousands of repos", async () => {
    // 3000 managed repos, one team that grants 250 of them.
    const managed = Array.from({ length: 3000 }, (_, i) => `nearform/repo-${i}`);
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: managed.slice(0, 250) },
    });
    const r = resolver(github, managed);
    const result = await r.visibleRepos("alice");
    expect(result.repos).toHaveLength(250);
    // 1 team query + 3 pages of 100. The org's size does not appear here at
    // all — that is the whole reason this resolves lazily per user.
    expect(calls.listUserTeams).toBe(1);
    expect(calls.pages).toBe(3);
  });

  it("stops paging a team the moment every managed repo is accounted for", async () => {
    // The team grants 1000 repos but only the first 2 are managed... and the
    // early exit can only fire once both have been seen.
    const teamGrant = Array.from({ length: 1000 }, (_, i) => `nearform/repo-${i}`);
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "everyone", name: null }] },
      teamRepos: { everyone: teamGrant },
    });
    const r = resolver(github, ["nearform/repo-0", "nearform/repo-1"]);
    const result = await r.visibleRepos("alice");
    expect(result.repos).toEqual(["nearform/repo-0", "nearform/repo-1"]);
    // Both managed repos are on page 1, so the walk stops there rather than
    // grinding through the remaining nine pages.
    expect(calls.pages).toBe(1);
  });

  it("resolves once for concurrent callers", async () => {
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: ["nearform/lastlight"] },
    });
    const r = resolver(github, ["nearform/lastlight"]);
    await Promise.all([
      r.visibleRepos("alice"),
      r.visibleRepos("alice"),
      r.visibleRepos("alice"),
    ]);
    expect(calls.listUserTeams).toBe(1);
  });

  it("serves the second request from cache", async () => {
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: ["nearform/lastlight"] },
    });
    const r = resolver(github, ["nearform/lastlight"]);
    await r.visibleRepos("alice");
    const again = await r.visibleRepos("alice");
    expect(again.repos).toEqual(["nearform/lastlight"]);
    expect(calls.listUserTeams).toBe(1);
  });
});

describe("TeamVisibilityResolver — every budget fails OPEN", () => {
  it("fails open when a team's grant is too big to enumerate", async () => {
    const managed = Array.from({ length: 500 }, (_, i) => `nearform/repo-${i}`);
    const { github } = fakeGithub({
      teams: { nearform: [{ slug: "everyone", name: null }] },
      // Grants 500 repos but the managed ones sit past the 2-page budget, so
      // the early exit never fires and the walk is cut short.
      teamRepos: { everyone: managed },
    });
    const r = resolver(github, managed, { maxPagesPerTeam: 2 });
    // A PARTIAL list is the one answer this must never give — it would hide
    // repos the person is responsible for and look like inactivity.
    expectFailOpen(await r.visibleRepos("alice"), "truncated");
  });

  it("fails open when the login is in more teams than the cap", async () => {
    const teams = Array.from({ length: 6 }, (_, i) => ({ slug: `t${i}`, name: null }));
    const { github, calls } = fakeGithub({ teams: { nearform: teams }, teamRepos: {} });
    const r = resolver(github, ["nearform/lastlight"], { maxTeamsPerUser: 5 });
    expectFailOpen(await r.visibleRepos("alice"), "too-many-teams");
    // Bailed before walking any team's repos.
    expect(calls.listTeamRepos).toBe(0);
  });

  it("fails open when the request budget runs out mid-walk", async () => {
    const teams = Array.from({ length: 10 }, (_, i) => ({ slug: `t${i}`, name: null }));
    const { github } = fakeGithub({
      teams: { nearform: teams },
      teamRepos: Object.fromEntries(teams.map((t) => [t.slug, ["nearform/lastlight"]])),
    });
    const r = resolver(github, ["nearform/lastlight"], { maxRequestsPerResolve: 4 });
    expectFailOpen(await r.visibleRepos("alice"), "budget");
  });

  it("fails open when GitHub refuses the query (e.g. no Members: read)", async () => {
    const { github } = fakeGithub({ failTeams: true });
    const r = resolver(github, ["nearform/lastlight"]);
    expectFailOpen(await r.visibleRepos("alice"), "error");
  });

  it("fails open when ONE org errors, even though another answered cleanly", async () => {
    // The dangerous case: filtering to the org that worked would hide every
    // repo in the org that didn't. A partial org set is a partial answer.
    const github = {
      async listUserTeams(org: string) {
        if (org === "mirevue") throw new Error("Resource not accessible by integration");
        return { teams: [{ slug: "platform", name: null }], requests: 1 };
      },
      async listTeamRepos() {
        return { repos: ["nearform/lastlight"], truncated: false, requests: 1 };
      },
    } as unknown as GitHubClient;
    const r = resolver(github, ["nearform/lastlight", "mirevue/app"]);
    expectFailOpen(await r.visibleRepos("alice"), "error");
  });

  it("fails open — not blank — when the login is in no granting team", async () => {
    const { github } = fakeGithub({ teams: { nearform: [] } });
    const r = resolver(github, ["nearform/lastlight"]);
    const result = await r.visibleRepos("alice");
    expectFailOpen(result, "no-teams");
    // Resolved cleanly, so the UI can say so — it just doesn't filter.
    expect(result.synced).toBe(true);
  });

  it("fails open for a session with no GitHub identity (password / Slack login)", async () => {
    const { github, calls } = fakeGithub({});
    const r = resolver(github, ["nearform/lastlight"]);
    expectFailOpen(await r.visibleRepos(undefined), "no-identity");
    expect(calls.listUserTeams).toBe(0);
  });

  it("fails open when the feature is switched off, without touching GitHub", async () => {
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
    });
    const r = resolver(github, ["nearform/lastlight"], { enabled: false });
    expectFailOpen(await r.visibleRepos("alice"), "disabled");
    expect(calls.listUserTeams).toBe(0);
  });

  it("fails open with no GitHub client at all (chat-only mode)", async () => {
    const r = resolver(null, ["nearform/lastlight"]);
    expectFailOpen(await r.visibleRepos("alice"), "unavailable");
  });

  it("fails open before boot discovery has populated the managed list", async () => {
    const { github, calls } = fakeGithub({});
    const r = resolver(github, []);
    expectFailOpen(await r.visibleRepos("alice"), "unavailable");
    expect(calls.listUserTeams).toBe(0);
  });
});

describe("TeamVisibilityResolver — staleness", () => {
  it("drops a repo that has since left the managed list", async () => {
    const { github } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: ["nearform/lastlight", "nearform/www"] },
    });
    const managed = ["nearform/lastlight", "nearform/www"];
    const r = new TeamVisibilityResolver({
      store: db.teams,
      github,
      config: () => CONFIG,
      managedRepos: () => managed,
    });
    expect((await r.visibleRepos("alice")).repos).toEqual([
      "nearform/lastlight",
      "nearform/www",
    ]);
    // The App loses access to www; the cached row must not resurrect it.
    managed.pop();
    expect((await r.visibleRepos("alice")).repos).toEqual(["nearform/lastlight"]);
  });

  it("resync re-asks GitHub even inside the TTL", async () => {
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: ["nearform/lastlight"] },
    });
    const r = resolver(github, ["nearform/lastlight"]);
    await r.visibleRepos("alice");
    await r.resync("alice");
    expect(calls.listUserTeams).toBe(2);
  });

  it("re-resolves after a webhook invalidated the login", async () => {
    const { github, calls } = fakeGithub({
      teams: { nearform: [{ slug: "platform", name: null }] },
      teamRepos: { platform: ["nearform/lastlight"] },
    });
    const r = resolver(github, ["nearform/lastlight"]);
    await r.visibleRepos("alice");
    db.teams.invalidateLogin("alice");
    await r.visibleRepos("alice");
    expect(calls.listUserTeams).toBe(2);
  });
});

describe("GitHubClient.listUserTeams — a personal account is an answer, not a fault", () => {
  // `organization(login:)` against a USER account returns
  // `{ organization: null }` PLUS a NOT_FOUND error, and Octokit throws on any
  // `errors` array — so this can't be handled by checking for a null
  // organization, which is never reached. Left unclassified it logs a warning
  // per personal-account owner on every resolution AND fails the whole pass,
  // since any failure now fails open.
  const classify = async () => {
    const { GitHubClient } = await import("#src/engine/github/github.js");
    return (
      GitHubClient as unknown as { isOrganizationNotFoundError: (e: unknown) => boolean }
    ).isOrganizationNotFoundError;
  };

  const withErrors = (errors: unknown[]) =>
    Object.assign(new Error("graphql"), { errors, data: { organization: null } });

  it("recognises the not-an-organization error", async () => {
    const isNotFound = await classify();
    expect(isNotFound(withErrors([{ type: "NOT_FOUND", path: ["organization"] }]))).toBe(true);
  });

  it("does NOT swallow a real failure", async () => {
    const isNotFound = await classify();
    expect(isNotFound(new Error("rate limited"))).toBe(false);
    expect(isNotFound(withErrors([{ type: "FORBIDDEN", path: ["organization"] }]))).toBe(false);
    // A NOT_FOUND on some other path is a different problem entirely.
    expect(isNotFound(withErrors([{ type: "NOT_FOUND", path: ["repository"] }]))).toBe(false);
    // Mixed: one genuine error alongside it must not be classified away.
    expect(
      isNotFound(
        withErrors([
          { type: "NOT_FOUND", path: ["organization"] },
          { type: "RATE_LIMITED", path: ["organization"] },
        ]),
      ),
    ).toBe(false);
  });
});
