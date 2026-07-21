import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDb } from "#src/state/db.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("UserStore.getOrCreateUserByGithub", () => {
  it("creates a user capturing id/login/name/email/avatar", () => {
    const user = db.users.getOrCreateUserByGithub({
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

  it("upserts on github_id — refreshes mutable fields and bumps last_login_at", () => {
    const first = db.users.getOrCreateUserByGithub({
      githubId: 42,
      login: "octocat",
      name: "Old Name",
      email: "old@example.com",
    });
    const second = db.users.getOrCreateUserByGithub({
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
    expect(db.users.findByGithubId(42)?.id).toBe(first.id);
  });

  it("preserves existing name/email/avatar when a refresh omits them", () => {
    db.users.getOrCreateUserByGithub({
      githubId: 7,
      login: "a",
      name: "Ada",
      email: "ada@example.com",
      avatarUrl: "https://ada.png",
    });
    const refreshed = db.users.getOrCreateUserByGithub({ githubId: 7, login: "a" });
    expect(refreshed.name).toBe("Ada");
    expect(refreshed.email).toBe("ada@example.com");
    expect(refreshed.avatarUrl).toBe("https://ada.png");
  });

  it("is findable by login and email", () => {
    db.users.getOrCreateUserByGithub({ githubId: 42, login: "octocat", email: "octo@example.com" });
    expect(db.users.findByLogin("octocat")?.githubId).toBe(42);
    expect(db.users.findByEmail("octo@example.com")?.login).toBe("octocat");
  });
});

describe("UserStore.upsertSlackUser", () => {
  it("matches an existing GitHub row by email and links slack_user_id", () => {
    const gh = db.users.getOrCreateUserByGithub({
      githubId: 42,
      login: "octocat",
      email: "octo@example.com",
    });
    const matched = db.users.upsertSlackUser({
      slackUserId: "U123",
      name: "Octo",
      email: "octo@example.com",
    });
    expect(matched.id).toBe(gh.id);
    expect(matched.login).toBe("octocat"); // retains GitHub identity
    expect(matched.slackUserId).toBe("U123");
    expect(db.users.findBySlackUserId("U123")?.login).toBe("octocat");
  });

  it("creates a Slack-only row when no email matches", () => {
    const slackOnly = db.users.upsertSlackUser({
      slackUserId: "U999",
      name: "Stranger",
      email: "nobody@example.com",
    });
    expect(slackOnly.login).toBeUndefined();
    expect(slackOnly.githubId).toBeUndefined();
    expect(slackOnly.slackUserId).toBe("U999");
    expect(slackOnly.name).toBe("Stranger");
  });

  it("is idempotent on slack_user_id (fast path re-links, no duplicate row)", () => {
    const first = db.users.upsertSlackUser({ slackUserId: "U1", name: "One" });
    const second = db.users.upsertSlackUser({ slackUserId: "U1", email: "one@example.com" });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe("one@example.com");
    expect(second.name).toBe("One");
  });
});

describe("UserStore.linkSlackUser", () => {
  it("links a slack id onto an existing user", () => {
    const gh = db.users.getOrCreateUserByGithub({ githubId: 1, login: "a" });
    db.users.linkSlackUser(gh.id, "U-link");
    expect(db.users.findBySlackUserId("U-link")?.id).toBe(gh.id);
  });
});
