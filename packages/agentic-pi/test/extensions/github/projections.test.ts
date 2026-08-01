import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BODY_CHARS,
  MAX_PATCH_CHARS,
  capText,
  page,
  summarizeCommit,
  summarizeFile,
  summarizeIssue,
  summarizeIssueHit,
} from "../../../src/extensions/github/projections.js";

describe("capText", () => {
  test("returns short text untouched, and normalises absence to null", () => {
    assert.equal(capText("short"), "short");
    // An empty body and a missing one are different facts; only the latter is null.
    assert.equal(capText(""), "");
    assert.equal(capText(null), null);
    assert.equal(capText(undefined), null);
  });

  test("names the escape hatch in the notice so the agent can find it", () => {
    const out = capText("x".repeat(MAX_BODY_CHARS + 10), { hatch: "full_body: true" });
    assert.match(out as string, /truncated 10 chars — re-call with full_body: true for the rest/);
  });

  test("omits the hatch clause when a field has no escape hatch", () => {
    const out = capText("x".repeat(MAX_BODY_CHARS + 5));
    assert.match(out as string, /\[truncated 5 chars\]$/);
    assert.doesNotMatch(out as string, /re-call/);
  });

  test("full bypasses the cap entirely", () => {
    const long = "x".repeat(MAX_BODY_CHARS + 100);
    assert.equal(capText(long, { full: true }), long);
  });
});

describe("page", () => {
  test("a full page offers the next one", () => {
    const p = page([1, 2, 3], 2, 3);
    assert.deepEqual(p, { items: [1, 2, 3], page: 2, per_page: 3, has_more: true, next_page: 3 });
  });

  test("a short page is the last one", () => {
    const p = page([1, 2], 1, 30);
    assert.equal(p.has_more, false);
    assert.equal(p.next_page, null);
  });

  test("an empty page terminates rather than looping", () => {
    assert.equal(page([], 4, 30).next_page, null);
  });
});

describe("summarizeFile", () => {
  const file = {
    filename: "pnpm-lock.yaml",
    status: "modified",
    additions: 900,
    deletions: 850,
    changes: 1750,
    patch: "@@ ".repeat(20_000),
  };

  test("omits the patch by default — the file list is a survey", () => {
    const out = summarizeFile(file);
    assert.deepEqual(out, {
      filename: "pnpm-lock.yaml",
      status: "modified",
      additions: 900,
      deletions: 850,
      changes: 1750,
    });
    assert.ok(!("patch" in out));
  });

  test("include_patch caps each patch and names the lift", () => {
    const out = summarizeFile(file, { includePatch: true }) as { patch: string };
    assert.ok(out.patch.length < file.patch.length);
    assert.ok(out.patch.length < MAX_PATCH_CHARS + 200);
    assert.match(out.patch, /full_patch: true/);
  });

  test("full_patch returns it whole", () => {
    const out = summarizeFile(file, { includePatch: true, fullPatch: true }) as { patch: string };
    assert.equal(out.patch, file.patch);
  });

  test("keeps previous_filename only for a rename", () => {
    assert.ok(!("previous_filename" in summarizeFile(file)));
    const renamed = summarizeFile({ ...file, status: "renamed", previous_filename: "old.yaml" });
    assert.equal((renamed as { previous_filename: string }).previous_filename, "old.yaml");
  });
});

describe("summarizeIssue", () => {
  const raw = {
    number: 7,
    title: "Crash on empty config",
    state: "open",
    html_url: "https://github.com/acme/app/issues/7",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    comments: 42,
    user: { login: "octocat" },
    labels: [{ name: "bug" }, "regression", { color: "fff" }],
    assignees: [{ login: "maintainer" }, {}],
    body: "x".repeat(50_000),
  };

  test("drops the body and normalises labels of both shapes", () => {
    const out = summarizeIssue(raw);
    assert.ok(!("body" in out));
    assert.deepEqual(out.labels, ["bug", "regression"]);
    assert.deepEqual(out.assignees, ["maintainer"]);
    assert.equal(out.author, "octocat");
    assert.equal(out.comments, 42);
  });

  test("flags a pull request, since the issues endpoint returns both", () => {
    assert.equal(summarizeIssue(raw).is_pull_request, false);
    assert.equal(summarizeIssue({ ...raw, pull_request: { url: "…" } }).is_pull_request, true);
  });
});

describe("summarizeCommit", () => {
  const raw = {
    sha: "abc123",
    commit: { message: `subject\n\n${"body ".repeat(2000)}`, author: { name: "Ada", date: "2026-01-01T00:00:00Z" } },
    author: { login: "ada-gh" },
    html_url: "https://github.com/acme/app/commit/abc123",
  };

  test("caps the message but keeps the subject", () => {
    const out = summarizeCommit(raw);
    assert.ok((out.message as string).startsWith("subject"));
    assert.match(out.message as string, /full_messages: true/);
  });

  test("prefers the GitHub login and falls back to the git author name", () => {
    assert.equal(summarizeCommit(raw).author, "ada-gh");
    assert.equal(summarizeCommit({ ...raw, author: null }).author, "Ada");
  });
});

describe("summarizeIssueHit", () => {
  test("recovers the owning repo from repository_url", () => {
    const out = summarizeIssueHit({
      number: 3,
      title: "t",
      state: "open",
      html_url: "u",
      created_at: "c",
      updated_at: "u",
      repository_url: "https://api.github.com/repos/acme/app",
    });
    assert.equal(out.repository, "acme/app");
  });
});
