/**
 * `UserStore` — identity upserts, the finders, and the boolean round-trip
 * (issue #205).
 *
 * Bodies moved verbatim from the pre-Phase-3 `tests/state/user-store.test.ts`.
 * The `isTriggerActorType` block that shared that file is a pure predicate with
 * no database at all, so it stayed behind in
 * `tests/state/trigger-actor-type.test.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runUsersSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("UserStore", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    describe("UserStore.getOrCreateUserByGithub", () => {
      it("creates a user capturing id/login/name/email/avatar", async () => {
        const user = await db.users.getOrCreateUserByGithub({
          githubId: 42,
          login: "octocat",
          name: "The Octocat",
          email: "octo@example.com",
          avatarUrl: "https://avatars/oct.png",
        });
        expect(user.githubId).toBe(42);
        expect(user.login).toBe("octocat");
        expect(user.name).toBe("The Octocat");
        expect(user.email).toBe("octo@example.com");
        expect(user.avatarUrl).toBe("https://avatars/oct.png");
        expect(user.isBlocked).toBe(false);
        expect(user.emailIsPlaceholder).toBe(false);
        expect(user.lastLoginAt).toBeTruthy();
      });

      it("upserts on github_id — refreshes mutable fields and bumps last_login_at", async () => {
        const first = await db.users.getOrCreateUserByGithub({
          githubId: 42,
          login: "octocat",
          name: "Old Name",
          email: "old@example.com",
        });
        const second = await db.users.getOrCreateUserByGithub({
          githubId: 42,
          login: "octocat-renamed",
          name: "New Name",
          email: "new@example.com",
          avatarUrl: "https://a.png",
        });
        expect(second.id).toBe(first.id); // same row
        expect(second.login).toBe("octocat-renamed");
        expect(second.name).toBe("New Name");
        expect(second.email).toBe("new@example.com");
        expect(second.avatarUrl).toBe("https://a.png");
        // Only one row exists.
        expect((await db.users.findByGithubId(42))?.id).toBe(first.id);
      });

      it("preserves existing name/email/avatar when a refresh omits them", async () => {
        await db.users.getOrCreateUserByGithub({
          githubId: 7,
          login: "a",
          name: "Ada",
          email: "ada@example.com",
          avatarUrl: "https://ada.png",
        });
        const refreshed = await db.users.getOrCreateUserByGithub({ githubId: 7, login: "a" });
        expect(refreshed.name).toBe("Ada");
        expect(refreshed.email).toBe("ada@example.com");
        expect(refreshed.avatarUrl).toBe("https://ada.png");
      });

      it("is findable by login and email", async () => {
        await db.users.getOrCreateUserByGithub({ githubId: 42, login: "octocat", email: "octo@example.com" });
        expect((await db.users.findByLogin("octocat"))?.githubId).toBe(42);
        expect((await db.users.findByEmail("octo@example.com"))?.login).toBe("octocat");
      });
    });

    describe("UserStore.upsertSlackUser", () => {
      it("matches an existing GitHub row by email and links slack_user_id", async () => {
        const gh = await db.users.getOrCreateUserByGithub({
          githubId: 42,
          login: "octocat",
          email: "octo@example.com",
        });
        const matched = await db.users.upsertSlackUser({
          slackUserId: "U123",
          name: "Octo",
          email: "octo@example.com",
        });
        expect(matched.id).toBe(gh.id);
        expect(matched.login).toBe("octocat"); // retains GitHub identity
        expect(matched.slackUserId).toBe("U123");
        expect((await db.users.findBySlackUserId("U123"))?.login).toBe("octocat");
      });

      it("creates a Slack-only row when no email matches", async () => {
        const slackOnly = await db.users.upsertSlackUser({
          slackUserId: "U999",
          name: "Stranger",
          email: "nobody@example.com",
        });
        expect(slackOnly.login).toBeUndefined();
        expect(slackOnly.githubId).toBeUndefined();
        expect(slackOnly.slackUserId).toBe("U999");
        expect(slackOnly.name).toBe("Stranger");
      });

      it("is idempotent on slack_user_id (fast path re-links, no duplicate row)", async () => {
        const first = await db.users.upsertSlackUser({ slackUserId: "U1", name: "One" });
        const second = await db.users.upsertSlackUser({ slackUserId: "U1", email: "one@example.com" });
        expect(second.id).toBe(first.id);
        expect(second.email).toBe("one@example.com");
        expect(second.name).toBe("One");
      });
    });

    describe("UserStore.linkSlackUser", () => {
      it("links a slack id onto an existing user", async () => {
        const gh = await db.users.getOrCreateUserByGithub({ githubId: 1, login: "a" });
        await db.users.linkSlackUser(gh.id, "U-link");
        expect((await db.users.findBySlackUserId("U-link"))?.id).toBe(gh.id);
      });
    });
  });
}
